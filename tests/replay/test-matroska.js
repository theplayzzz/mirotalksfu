'use strict';

require('should');

const fs = require('node:fs');
const path = require('node:path');

const { MatroskaMuxer, fileSink } = require('../../app/src/replay/Matroska');
const h264 = require('../../app/src/replay/h264');
const { OPUS_SILENCE_FRAME } = require('../../app/src/replay/opus');
const gen = require('./lib/gen');
const media = require('./lib/media');
const { parseMkv } = require('./lib/mkv');

/** A sink that keeps everything in memory. */
function memorySink() {
    const chunks = [];
    return { chunks, write: async (buf) => void chunks.push(Buffer.from(buf)), bytes: () => Buffer.concat(chunks) };
}

async function writeSample(muxer, { seconds = 6, fps = 30, keyEvery = 90, audio = true } = {}) {
    await muxer.start();
    const frames = [];
    for (let i = 0; i < seconds * fps; i++)
        frames.push({
            track: 'video',
            tsMs: (i * 1000) / fps,
            key: i % keyEvery === 0,
            size: i % keyEvery === 0 ? 4000 : 800,
            seed: i,
        });
    if (audio)
        for (let i = 0; i < seconds * 50; i++)
            frames.push({ track: 'audio', tsMs: i * 20, key: true, size: 60, seed: 1000 + i });
    frames.sort((a, b) => a.tsMs - b.tsMs);
    for (const f of frames) {
        const data =
            f.track === 'video'
                ? gen.vp8Frame({ key: f.key, size: f.size, seed: f.seed })
                : gen.opusPacket({ size: f.size, seed: f.seed });
        await muxer.writeFrame({ track: f.track, tsMs: f.tsMs, key: f.key, data });
    }
    await muxer.finish();
}

describe('replay: Matroska muxer', () => {
    describe('structure', () => {
        it('writes the EBML header, an unknown size segment, the tracks and clusters at key frames', async () => {
            const sink = memorySink();
            const muxer = new MatroskaMuxer({
                docType: 'webm',
                video: { codec: 'vp8', width: 1280, height: 720 },
                audio: { channels: 2 },
                sink,
            });
            await writeSample(muxer);
            const mkv = parseMkv(sink.bytes());
            mkv.docType.should.equal('webm');
            mkv.timecodeScale.should.equal(1000000);
            mkv.segmentSize.should.equal(-1); // unknown
            mkv.tracks
                .map((t) => [t.number, t.type, t.codec])
                .should.deepEqual([
                    [1, 1, 'V_VP8'],
                    [2, 2, 'A_OPUS'],
                ]);
            const audioTrack = mkv.tracks[1];
            audioTrack.codecPrivate.subarray(0, 8).toString().should.equal('OpusHead');
            audioTrack.codecDelay.should.equal(6500000);
            audioTrack.seekPreRoll.should.equal(80000000);

            // 6 s with key frames every 3 s and a cluster at most every 2 s
            const starts = mkv.clusters.map((c) => c.ts);
            starts.should.containEql(0).and.containEql(3000);
            for (let i = 1; i < starts.length; i++) (starts[i] - starts[i - 1]).should.be.within(1, 2000);
            // Every cluster that starts at a key frame time begins with it
            const at3000 = mkv.clusters.find((c) => c.ts === 3000);
            at3000.blocks.find((b) => b.track === 1).key.should.be.true();

            const video = mkv.clusters.flatMap((c) => c.blocks).filter((b) => b.track === 1);
            const audio = mkv.clusters.flatMap((c) => c.blocks).filter((b) => b.track === 2);
            video.should.have.length(180);
            audio.should.have.length(300);
            video
                .filter((b) => b.key)
                .map((b) => b.ts)
                .should.deepEqual([0, 3000]);
            audio.every((b) => b.key).should.be.true();
            // blocks are in time order
            const all = mkv.clusters.flatMap((c) => c.blocks).map((b) => b.ts);
            for (let i = 1; i < all.length; i++) all[i].should.not.be.below(all[i - 1]);
        });

        it('makes the timestamps of a track strictly increasing', async () => {
            const sink = memorySink();
            const muxer = new MatroskaMuxer({ video: { codec: 'vp8', width: 640, height: 360 }, sink });
            await muxer.start();
            for (const tsMs of [0, 33.4, 33.6, 33.2, 80]) {
                await muxer.writeFrame({
                    track: 'video',
                    tsMs,
                    key: tsMs === 0,
                    data: gen.vp8Frame({ key: tsMs === 0, size: 100 }),
                });
            }
            await muxer.finish();
            const ts = parseMkv(sink.bytes()).clusters.flatMap((c) => c.blocks.map((b) => b.ts));
            ts.should.deepEqual([0, 33, 34, 35, 80]);
        });

        it('has no audio track when there is no audio', async () => {
            const sink = memorySink();
            const muxer = new MatroskaMuxer({ video: { codec: 'vp8', width: 640, height: 360 }, sink });
            await writeSample(muxer, { audio: false, seconds: 2 });
            const mkv = parseMkv(sink.bytes());
            mkv.tracks.should.have.length(1);
            mkv.clusters
                .flatMap((c) => c.blocks)
                .every((b) => b.track === 1)
                .should.be.true();
        });

        it('starts a new cluster when audio only runs for longer than clusterMs', async () => {
            const sink = memorySink();
            const muxer = new MatroskaMuxer({ video: { codec: 'vp8', width: 640, height: 360 }, audio: {}, sink });
            await muxer.start();
            await muxer.writeFrame({
                track: 'video',
                tsMs: 0,
                key: true,
                data: gen.vp8Frame({ key: true, size: 100 }),
            });
            for (let i = 0; i < 400; i++)
                await muxer.writeFrame({ track: 'audio', tsMs: i * 20, key: true, data: gen.opusPacket() });
            await muxer.finish();
            const starts = parseMkv(sink.bytes()).clusters.map((c) => c.ts);
            starts.should.deepEqual([0, 2000, 4000, 6000]);
        });

        it('refuses to write after finish and to build without a known video codec', async () => {
            (() => new MatroskaMuxer({ video: { codec: 'vp9' }, sink: memorySink() })).should.throw();
            const muxer = new MatroskaMuxer({ video: { codec: 'vp8', width: 1, height: 1 }, sink: memorySink() });
            await muxer.finish();
            await muxer.writeFrame({ track: 'video', tsMs: 0, key: true, data: Buffer.alloc(4) }).should.be.rejected();
        });

        it('encodes big values: timestamps beyond 2^24 ms and frames that need a 4 byte size', async () => {
            const sink = memorySink();
            const muxer = new MatroskaMuxer({ video: { codec: 'vp8', width: 640, height: 360 }, sink });
            const big = Buffer.alloc(300000, 7);
            big[0] = 0x10;
            await muxer.writeFrame({ track: 'video', tsMs: 20000000, key: true, data: big });
            await muxer.finish();
            const mkv = parseMkv(sink.bytes());
            mkv.clusters[0].ts.should.equal(20000000);
            mkv.clusters[0].blocks[0].size.should.equal(300000);
        });
    });

    describe('what FFmpeg makes of it', () => {
        let dir;

        before(function () {
            media.requireFfmpeg(this);
            dir = media.tmpDir();
        });

        after(() => dir && media.rmDir(dir));

        it('reads a VP8 + Opus file: streams, sizes, timestamps and key frames', async function () {
            this.timeout(30000);
            const file = path.join(dir, 'sample.webm');
            const sink = fileSink(file);
            const muxer = new MatroskaMuxer({
                docType: 'webm',
                video: { codec: 'vp8', width: 1280, height: 720 },
                audio: { channels: 2 },
                sink,
            });
            await writeSample(muxer);
            await sink.end();

            const info = await media.probe(file);
            const v = info.streams.find((s) => s.codec_type === 'video');
            const a = info.streams.find((s) => s.codec_type === 'audio');
            v.codec_name.should.equal('vp8');
            v.width.should.equal(1280);
            v.height.should.equal(720);
            a.codec_name.should.equal('opus');
            a.channels.should.equal(2);
            Number(a.sample_rate).should.equal(48000);

            const videoPackets = await media.streamPackets(file, 'v:0');
            videoPackets.should.have.length(180);
            videoPackets
                .filter((p) => p.key)
                .map((p) => p.pts)
                .should.deepEqual([0, 3]);
            videoPackets[1].pts.should.be.approximately(0.033, 0.001);
            const audioPackets = await media.streamPackets(file, 'a:0');
            audioPackets.should.have.length(300);
            // FFmpeg shows Opus packets 6.5 ms (the codec delay) before their block timestamp
            audioPackets[299].pts.should.be.approximately(5.98 - 0.0065, 0.001);
        });

        it('reads a H.264 file with its avcC record', async function () {
            this.timeout(30000);
            const file = path.join(dir, 'sample.mkv');
            const sps = gen.h264Sps({ width: 1920, height: 1080, profile: 100 });
            const pps = gen.h264Pps();
            const sink = fileSink(file);
            const muxer = new MatroskaMuxer({
                video: { codec: 'h264', width: 1920, height: 1080, codecPrivate: h264.buildAvcC(sps, pps) },
                sink,
            });
            await muxer.start();
            for (let i = 0; i < 20; i++) {
                const nal = gen.h264Nal(i % 10 === 0 ? 5 : 1, 2000, { seed: i });
                const au = Buffer.alloc(4 + nal.length); // length prefixed access unit
                au.writeUInt32BE(nal.length, 0);
                nal.copy(au, 4);
                await muxer.writeFrame({ track: 'video', tsMs: i * 33, key: i % 10 === 0, data: au });
            }
            await muxer.finish();
            await sink.end();
            const info = await media.probe(file);
            const v = info.streams[0];
            v.codec_name.should.equal('h264');
            v.width.should.equal(1920);
            v.height.should.equal(1080);
            v.profile.should.equal('High');
            Number(v.extradata_size).should.be.above(0);
        });

        it('lets FFmpeg copy it into a WebM with a cue index and the duration', async function () {
            this.timeout(30000);
            const input = path.join(dir, 'in.mkv');
            const output = path.join(dir, 'out.webm');
            const sink = fileSink(input);
            await writeSample(
                new MatroskaMuxer({ video: { codec: 'vp8', width: 1280, height: 720 }, audio: { channels: 2 }, sink })
            );
            await sink.end();
            const result = await media.run('ffmpeg', [
                '-v',
                'error',
                '-i',
                input,
                '-c',
                'copy',
                '-cues_to_front',
                '1',
                '-f',
                'webm',
                '-y',
                output,
            ]);
            result.code.should.equal(0, result.stderr);
            const info = await media.probe(output);
            Number(info.format.duration).should.be.approximately(6, 0.1);
            const bytes = fs.readFileSync(output);
            const mkv = parseMkv(bytes);
            mkv.docType.should.equal('webm');
            mkv.segmentSize.should.be.above(0); // FFmpeg knows the size once it is done
            // Cues (1C53BB6B) sit before the first cluster: seeking works from the start of the file
            const cues = bytes.indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]));
            const cluster = bytes.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
            cues.should.be.above(0);
            cues.should.be.below(cluster);
        });

        it('keeps an Opus track decodable when the gaps are filled with silence frames', async function () {
            this.timeout(30000);
            const file = path.join(dir, 'gaps.mkv');
            const sink = fileSink(file);
            const muxer = new MatroskaMuxer({
                video: { codec: 'vp8', width: 320, height: 180 },
                audio: { channels: 2 },
                sink,
            });
            await muxer.start();
            await muxer.writeFrame({
                track: 'video',
                tsMs: 0,
                key: true,
                data: gen.vp8Frame({ key: true, size: 100, width: 320, height: 180 }),
            });
            for (let i = 0; i < 10; i++)
                await muxer.writeFrame({ track: 'audio', tsMs: i * 20, key: true, data: OPUS_SILENCE_FRAME });
            await muxer.finish();
            await sink.end();
            const packets = await media.streamPackets(file, 'a:0');
            packets.should.have.length(10);
        });
    });
});
