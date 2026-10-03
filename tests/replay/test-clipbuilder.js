'use strict';

require('should');

const fs = require('node:fs');
const path = require('node:path');

const { FrameStore, KIND_VIDEO } = require('../../app/src/replay/FrameStore');
const clip = require('../../app/src/replay/ClipBuilder');
const gen = require('./lib/gen');
const media = require('./lib/media');
const real = require('./lib/real');

const T0 = 1791036902000;
const log = { info() {}, warn() {}, error() {}, debug() {} };

/** A snapshot like FrameStore.snapshot() makes, for the selection tests. */
function fakeSnapshot({ keysMs, chunkMs = 10000, newestMs, audioRanges = [] }) {
    const chunks = [];
    for (const keyMs of keysMs) {
        const index = Math.floor(keyMs / chunkMs);
        chunks[index] = chunks[index] || {
            path: `chunk${index}`,
            startTs: T0 + index * chunkMs,
            endTs: T0 + index * chunkMs,
            bytes: 1e6,
            keys: [],
        };
        chunks[index].keys.push({ ts: T0 + keyMs, off: 1000 + chunks[index].keys.length * 5000, end: 5000 });
    }
    const filled = chunks.filter(Boolean);
    return {
        chunks: filled,
        newestTs: T0 + newestMs,
        audioRanges: audioRanges.map(([a, b]) => ({ from: T0 + a, to: T0 + b })),
    };
}

describe('replay: clip selection', () => {
    it('ends at the newest frame and starts at the last key frame at or before the start', () => {
        const snapshot = fakeSnapshot({ keysMs: [0, 3000, 6000, 9000, 12000], newestMs: 14000 });
        const plan = clip.selectRange(snapshot, 5);
        plan.endTs.should.equal(T0 + 14000);
        plan.startTs.should.equal(T0 + 9000);
        plan.key.ts.should.equal(T0 + 9000); // a key frame exactly at the start
        plan.startOffsetMs.should.equal(0);
        plan.durationMs.should.equal(5020);

        const lead = clip.selectRange(snapshot, 6);
        lead.startTs.should.equal(T0 + 8000);
        lead.key.ts.should.equal(T0 + 6000);
        lead.startOffsetMs.should.equal(2000); // two seconds of lead-in to hide
        lead.fileStartTs.should.equal(T0 + 6000);
        lead.durationMs.should.equal(8020);
    });

    it('starts at the first key frame when the share is shorter than the clip', () => {
        const snapshot = fakeSnapshot({ keysMs: [2500, 5500, 8500], newestMs: 10000 });
        const plan = clip.selectRange(snapshot, 60);
        plan.key.ts.should.equal(T0 + 2500);
        plan.startOffsetMs.should.equal(0);
        plan.durationMs.should.equal(7520);
    });

    it('works on a share that has ended: the end is the last frame it ever had', () => {
        const snapshot = fakeSnapshot({ keysMs: [0, 4000], newestMs: 5000 });
        const plan = clip.selectRange(snapshot, 3);
        plan.endTs.should.equal(T0 + 5000);
        plan.key.ts.should.equal(T0 + 0); // 2000 is the start; the last key at or before it is 0
        plan.startOffsetMs.should.equal(2000);
    });

    it('finds nothing to build from when there is no key frame', () => {
        (clip.selectRange(fakeSnapshot({ keysMs: [], newestMs: 5000 }), 10) === null).should.be.true();
    });

    it('takes the key frame in other chunks and keeps their order', () => {
        const snapshot = fakeSnapshot({ keysMs: [31000, 1000, 22000, 12000], newestMs: 35000 });
        const plan = clip.selectRange(snapshot, 20);
        plan.key.ts.should.equal(T0 + 12000);
        snapshot.chunks[plan.key.chunkIndex].keys.some((k) => k.ts === T0 + 12000).should.be.true();
    });

    it('picks the thumbnail key frame closest to one second into the visible clip', () => {
        const snapshot = fakeSnapshot({ keysMs: [0, 1500, 4000, 9000, 12000], newestMs: 14000 });
        const plan = clip.selectRange(snapshot, 6); // starts at 8000, key frame 4000 is the lead-in start
        plan.key.ts.should.equal(T0 + 4000);
        plan.thumbKey.ts.should.equal(T0 + 9000);
        const sparse = clip.selectRange(fakeSnapshot({ keysMs: [0], newestMs: 30000 }), 10);
        sparse.thumbKey.ts.should.equal(T0);
    });

    it('tells whether the audio of the ring overlaps the clip', () => {
        const ranges = [
            { from: 100, to: 200 },
            { from: 500, to: 900 },
        ];
        clip.audioInRange(ranges, 150, 160).should.be.true();
        clip.audioInRange(ranges, 201, 499).should.be.false();
        clip.audioInRange(ranges, 880, 5000).should.be.true();
        clip.audioInRange([], 0, 10).should.be.false();
    });

    it('makes clip ids that fit the documented pattern, in time order', () => {
        const a = clip.generateClipId(Date.UTC(2026, 9, 3, 14, 15, 2));
        const b = clip.generateClipId(Date.UTC(2026, 9, 3, 14, 15, 3));
        a.should.match(/^[a-z0-9-]{8,64}$/);
        a.should.startWith('20261003-141502-');
        (a < b).should.be.true();
        clip.generateClipId().should.not.equal(clip.generateClipId());
    });

    it('reads the codec parameters of the first frame', () => {
        const key = gen.vp8Frame({ key: true, size: 400, width: 1920, height: 1080 });
        clip.videoParams('vp8', key).should.deepEqual({ codec: 'vp8', width: 1920, height: 1080 });
        (() => clip.videoParams('vp8', gen.vp8Frame({ key: false }))).should.throw(/not a VP8 key frame/);
        const sps = gen.h264Sps({ width: 1920, height: 1080, profile: 100 });
        const pps = gen.h264Pps();
        const prefixed = [sps, pps, gen.h264Nal(5, 300)].map((n) => {
            const p = Buffer.alloc(4);
            p.writeUInt32BE(n.length);
            return Buffer.concat([p, n]);
        });
        const params = clip.videoParams('h264', Buffer.concat(prefixed));
        params.width.should.equal(1920);
        params.height.should.equal(1080);
        params.codecPrivate[0].should.equal(1);
        (() => clip.videoParams('h264', Buffer.concat(prefixed.slice(2)))).should.throw(/parameter sets/);
    });
});

describe('replay: clip builder (with FFmpeg)', function () {
    this.timeout(120000);
    let dir;
    const samples = {};

    before(async function () {
        media.requireFfmpeg(this);
        dir = media.tmpDir('replay-clips-');
        samples.vp8 = real.loadFrames(await real.encode({ dir, name: 'vp8', codec: 'vp8', seconds: 12 }));
        samples.h264 = real.loadFrames(await real.encode({ dir, name: 'h264', codec: 'h264', seconds: 12 }));
    });

    after(() => dir && media.rmDir(dir));

    let stores = [];
    let n = 0;

    afterEach(async () => {
        for (const store of stores) await store.close();
        stores = [];
    });

    async function ring(frames, feedOptions) {
        const store = new FrameStore({ dir: path.join(dir, `ring${n++}`), retainMs: 600000, flushIntervalMs: 20 });
        stores.push(store);
        await store.open();
        real.feedStore(store, frames, T0, feedOptions);
        return store.snapshot();
    }

    async function build(snapshot, { seconds, codec, hasAudioStream = true, withAudio, ffmpegPath = 'ffmpeg' }) {
        const plan = clip.selectRange(snapshot, seconds);
        const stagingDir = path.join(dir, `staging${n++}`);
        fs.mkdirSync(stagingDir);
        const result = await clip.buildClip({
            snapshot,
            plan,
            share: { id: 'share1', roomId: 'link', peerName: 'Beltrano', codec, hasAudioStream, audioChannels: 2 },
            request: { seconds, requestedByName: 'Fulano', requestedByHash: 'rh', sharerHash: 'sh' },
            id: clip.generateClipId(),
            stagingDir,
            ffmpegPath,
            retentionDays: 7,
            log,
            withAudio,
        });
        return { ...result, plan, stagingDir };
    }

    it('builds a WebM from a VP8 + Opus share: starts at a key frame, has audio and an index, decodes cleanly', async () => {
        const snapshot = await ring(samples.vp8);
        const { meta, plan, stagingDir } = await build(snapshot, { seconds: 5, codec: 'vp8' });
        snapshot.release();

        meta.codec.should.equal('vp8');
        meta.hasAudio.should.be.true();
        meta.files.original.name.should.equal('clip.webm');
        meta.files.original.mime.should.equal('video/webm');
        (meta.files.mp4 === null).should.be.true();
        meta.thumb.should.equal('thumb.jpg');
        meta.sharer.should.equal('Beltrano');
        meta.requestedBy.should.equal('Fulano');
        meta.requestedByHash.should.equal('rh');
        meta.seconds.should.equal(5);
        meta.startOffsetS.should.be.within(0, 1.001); // key frame every second
        meta.durationS.should.be.approximately(5 + meta.startOffsetS, 0.1);
        meta.expiresAt.should.equal(meta.createdAt + 7 * 24 * 3600 * 1000);

        const file = path.join(stagingDir, 'clip.webm');
        fs.statSync(file).size.should.equal(meta.files.original.bytes);
        const info = await media.probe(file);
        info.streams
            .map((s) => s.codec_name)
            .sort()
            .should.deepEqual(['opus', 'vp8']);
        // the duration of the file: the clip plus the lead-in
        Number(info.format.duration).should.be.approximately(meta.durationS, 0.15);
        Number(info.format.duration).should.be.approximately(plan.durationMs / 1000, 0.15);
        const packets = await media.streamPackets(file, 'v:0');
        packets[0].key.should.be.true();
        packets[0].pts.should.be.within(0, 0.05);
        // the cue index sits before the first cluster, so a player can seek with Range requests
        const bytes = fs.readFileSync(file);
        const cues = bytes.indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]));
        const firstCluster = bytes.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
        cues.should.be.above(0);
        cues.should.be.below(firstCluster);
        (await media.decodeErrors(file)).should.equal('');
        // the thumbnail is a 640 px wide picture
        const thumb = await media.probe(path.join(stagingDir, 'thumb.jpg'));
        thumb.streams[0].width.should.equal(640);
        JSON.parse(fs.readFileSync(path.join(stagingDir, 'meta.json'), 'utf8')).id.should.equal(meta.id);
    });

    it('builds an MP4 with the moov atom first from an H.264 + Opus share (audio becomes AAC), no conversion needed', async () => {
        const snapshot = await ring(samples.h264);
        const { meta, stagingDir } = await build(snapshot, { seconds: 4, codec: 'h264' });
        snapshot.release();
        meta.codec.should.equal('h264');
        meta.files.original.name.should.equal('clip.mp4');
        meta.files.mp4.name.should.equal('clip.mp4');
        meta.files.mp4.bytes.should.equal(meta.files.original.bytes);
        meta.hasAudio.should.be.true();

        const file = path.join(stagingDir, 'clip.mp4');
        const info = await media.probe(file);
        info.streams
            .map((s) => s.codec_name)
            .sort()
            .should.deepEqual(['aac', 'h264']);
        Number(info.format.duration).should.be.approximately(meta.durationS, 0.15);
        const atoms = [];
        const fd = fs.openSync(file, 'r');
        try {
            let pos = 0;
            const head = Buffer.alloc(16);
            while (pos < fs.fstatSync(fd).size) {
                fs.readSync(fd, head, 0, 16, pos);
                let size = head.readUInt32BE(0);
                if (size === 1) size = Number(head.readBigUInt64BE(8));
                atoms.push(head.toString('ascii', 4, 8));
                pos += size;
            }
        } finally {
            fs.closeSync(fd);
        }
        atoms.indexOf('moov').should.be.within(0, atoms.indexOf('mdat') - 1);
        (await media.streamPackets(file, 'v:0'))[0].key.should.be.true();
        (await media.decodeErrors(file)).should.equal('');
    });

    it('makes a clip of a short share: as long as the share, nothing to hide', async () => {
        const snapshot = await ring(samples.vp8, { to: 6000 });
        const { meta } = await build(snapshot, { seconds: 120, codec: 'vp8' });
        snapshot.release();
        meta.startOffsetS.should.equal(0);
        meta.durationS.should.be.approximately(6, 0.1);
        meta.seconds.should.equal(120);
    });

    it('leaves the audio out when the share has none, and keeps going when the audio is only in the ring', async () => {
        const noAudio = await ring(samples.vp8, { audio: false });
        const first = await build(noAudio, { seconds: 4, codec: 'vp8', hasAudioStream: false });
        noAudio.release();
        first.meta.hasAudio.should.be.false();
        const info = await media.probe(path.join(first.stagingDir, 'clip.webm'));
        info.streams.map((s) => s.codec_type).should.deepEqual(['video']);
        (await media.decodeErrors(path.join(first.stagingDir, 'clip.webm'))).should.equal('');

        // the ring claims audio (ranges) that is not in the chunks read: the builder reports it so the caller can retry
        const snapshot = await ring(samples.vp8, { audio: false });
        snapshot.audioRanges = [{ from: T0, to: T0 + 20000 }];
        const failure = await build(snapshot, { seconds: 4, codec: 'vp8' }).catch((e) => e);
        snapshot.release();
        failure.should.be.instanceOf(Error);
        failure.retryWithoutAudio.should.be.true();
        const retried = await build(snapshot, { seconds: 4, codec: 'vp8', withAudio: false });
        retried.meta.hasAudio.should.be.false();
    });

    it('lets audio start late and fills the holes of a silent (DTX) track with silence frames', async () => {
        // audio only from 3 s to 5 s and from 8 s on
        const snapshot = await ring(samples.vp8, { skipAudio: (ts) => ts < 3000 || (ts >= 5000 && ts < 8000) });
        const { meta, stagingDir } = await build(snapshot, { seconds: 12, codec: 'vp8' });
        snapshot.release();
        meta.hasAudio.should.be.true();
        const file = path.join(stagingDir, 'clip.webm');
        const audio = await media.streamPackets(file, 'a:0');
        audio[0].pts.should.be.approximately(3, 0.1); // starts late, not padded
        // no hole bigger than ~one frame: the three seconds without audio were filled
        let widest = 0;
        for (let i = 1; i < audio.length; i++) widest = Math.max(widest, audio[i].pts - audio[i - 1].pts);
        widest.should.be.below(0.06);
        (audio[audio.length - 1].pts - audio[0].pts).should.be.approximately(8.9, 0.3);
        (await media.decodeErrors(file)).should.equal('');
    });

    it('reports the reason when FFmpeg cannot run', async () => {
        const snapshot = await ring(samples.vp8);
        const failure = await build(snapshot, {
            seconds: 4,
            codec: 'vp8',
            ffmpegPath: path.join(dir, 'no-such-ffmpeg'),
        }).catch((e) => e);
        snapshot.release();
        failure.should.be.instanceOf(Error);
        failure.message.should.match(/ENOENT|ffmpeg|no-such/i);
    });

    it('works while the ring keeps receiving frames (it reads what the snapshot saw)', async () => {
        const snapshot = await ring(samples.vp8, { to: 8000 });
        // more frames arrive during the build; the clip ends where the snapshot ended
        const building = build(snapshot, { seconds: 5, codec: 'vp8' });
        for (const f of samples.vp8.video.filter((v) => v.tsMs > 8000))
            stores[0].append(KIND_VIDEO, f.key, T0 + f.tsMs, f.data);
        const { meta } = await building;
        snapshot.release();
        meta.durationS.should.be.approximately(5 + meta.startOffsetS, 0.15);
    });
});
