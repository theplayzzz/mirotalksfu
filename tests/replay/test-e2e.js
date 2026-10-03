'use strict';

require('should');

const fs = require('node:fs');
const path = require('node:path');

const { startRecorder } = require('./lib/service');
const { RtpFeed } = require('./lib/rtpfeed');
const { settle, sleep } = require('./lib/feed');
const media = require('./lib/media');
const sync = require('./lib/sync');

/**
 * End to end with FFmpeg as the sender: FFmpeg encodes a test pattern and a tone in real time, sends real RTP
 * (VP8 or H.264 + Opus, one `-f rtp` output per stream), a forwarder sends everything to the recorder from one
 * UDP socket as mediasoup does, and clips are checked with ffprobe and by decoding them.
 */
describe('replay: end to end with FFmpeg RTP', function () {
    this.timeout(180000);
    let svc;
    let feed;

    before(function () {
        media.requireFfmpeg(this);
    });

    afterEach(async () => {
        if (feed) feed.stop();
        feed = null;
        if (svc) await svc.stop();
        svc = null;
    });

    async function run(options, { shareId = 's1', register = true, dataDir } = {}) {
        svc = svc || (await startRecorder(dataDir ? { dataDir } : {}));
        feed = new RtpFeed(options);
        const streams = await feed.prepare();
        if (register) {
            const response = await svc.api.post('/v1/shares', {
                shareId,
                roomId: 'link',
                peerName: 'Beltrano',
                ...streams,
            });
            response.status.should.equal(200);
            feed.setTarget(response.body.port);
        }
        return streams;
    }

    const clipBody = (seconds, shareId = 's1') => ({
        shareId,
        seconds,
        requestedByName: 'Fulano',
        requestedByHash: 'rh',
        sharerHash: 'sh',
        requestId: `r-${Math.random().toString(36).slice(2)}`,
    });

    for (const codec of ['vp8', 'h264']) {
        it(`${codec === 'vp8' ? 'VP8' : 'H.264'} + Opus: a clip with the requested length, starting at a key frame, with audio, that decodes cleanly`, async () => {
            await run({ codec, seconds: 11, sr: 'ffmpeg' });
            await feed.run();
            await settle(svc.api, 's1', { minFrames: 300, quietMs: 300 });
            const shares = (await svc.api.get('/v1/shares')).body.shares;
            shares[0].bufferSeconds.should.be.within(9, 11);
            const stats = shares[0].stats;
            stats.video.clock.should.equal('sr'); // the Sender Reports of FFmpeg were used
            stats.audio.clock.should.equal('sr');
            stats.video.lost.should.equal(0);
            stats.audio.lost.should.equal(0);

            const response = await svc.api.post('/v1/clips', clipBody(6));
            response.status.should.equal(200, response.text);
            const meta = response.body;
            meta.codec.should.equal(codec);
            meta.hasAudio.should.be.true();
            const name = codec === 'vp8' ? 'clip.webm' : 'clip.mp4';
            const file = path.join(svc.clipDir(meta.id), name);
            fs.existsSync(file).should.be.true();

            const info = await media.probe(file);
            // the duration: the 6 seconds asked for plus the lead-in before the key frame, within half a second
            Number(info.format.duration).should.be.approximately(6 + meta.startOffsetS, 0.5);
            meta.durationS.should.be.approximately(6 + meta.startOffsetS, 0.5);
            meta.startOffsetS.should.be.within(0, 1.2); // a key frame every second
            const names = info.streams.map((s) => s.codec_name).sort();
            names.should.deepEqual(codec === 'vp8' ? ['opus', 'vp8'] : ['aac', 'h264']);
            const video = info.streams.find((s) => s.codec_type === 'video');
            video.width.should.equal(640);
            video.height.should.equal(360);
            (await media.streamPackets(file, 'v:0'))[0].key.should.be.true();
            const audio = await media.streamPackets(file, 'a:0');
            audio.length.should.be.above(200); // 6+ seconds of audio
            (await media.decodeErrors(file)).should.equal('');

            if (codec === 'h264') {
                meta.files.mp4.name.should.equal('clip.mp4');
            } else {
                (meta.files.mp4 === null).should.be.true();
            }
            const thumb = await media.probe(path.join(svc.clipDir(meta.id), 'thumb.jpg'));
            thumb.streams[0].width.should.equal(640);
        });
    }

    describe('audio/video sync (a flash and a beep at the same instants)', () => {
        // One second of the source is 30 frames and 50 audio packets. The offset is measured in the clip.
        for (const [mode, limitMs] of [
            ['sfu', 80], // Sender Reports built like mediasoup does: from the arrival time of the packets
            ['ideal', 80], // reports that describe the capture times exactly
            ['ffmpeg', 80], // the reports of FFmpeg's own RTP muxer
        ]) {
            it(`stays under ${limitMs} ms with Sender Reports of kind "${mode}"`, async () => {
                await run({
                    codec: 'vp8',
                    seconds: 13,
                    sr: mode,
                    videoSource: sync.FLASH_VIDEO(320, 180, 30),
                    audioSource: sync.BEEP_AUDIO,
                    gop: 30,
                });
                await feed.run();
                await settle(svc.api, 's1', { minFrames: 300, quietMs: 300 });
                const response = await svc.api.post('/v1/clips', clipBody(10));
                response.status.should.equal(200, response.text);
                const file = path.join(svc.clipDir(response.body.id), 'clip.webm');
                const flashes = await sync.flashOnsets(file);
                const beeps = await sync.beepOnsets(file);
                const differences = sync.offsets(flashes, beeps);
                differences.length.should.be.above(3, `flashes ${flashes} beeps ${beeps}`);
                if (process.env.REPLAY_TEST_VERBOSE)
                    console.log(`      sync offsets (${mode}):`, differences.map((d) => d.toFixed(1)).join(' '));
                for (const d of differences)
                    Math.abs(d).should.be.below(limitMs, `offsets ${differences.map((x) => x.toFixed(1))}`);
                (await media.decodeErrors(file)).should.equal('');
            });
        }

        it('stays under 120 ms even with no Sender Reports at all (arrival times, after waiting up to 3 s for a report)', async () => {
            await run({
                codec: 'vp8',
                seconds: 13,
                sr: 'none',
                videoSource: sync.FLASH_VIDEO(320, 180, 30),
                audioSource: sync.BEEP_AUDIO,
            });
            await feed.run();
            await settle(svc.api, 's1', { minFrames: 300, quietMs: 300 });
            const stats = (await svc.api.get('/v1/shares')).body.shares[0].stats;
            stats.video.clock.should.equal('arrival');
            stats.audio.clock.should.equal('arrival');
            const response = await svc.api.post('/v1/clips', clipBody(10));
            response.status.should.equal(200, response.text);
            const file = path.join(svc.clipDir(response.body.id), 'clip.webm');
            const differences = sync.offsets(await sync.flashOnsets(file), await sync.beepOnsets(file));
            differences.length.should.be.above(3);
            if (process.env.REPLAY_TEST_VERBOSE)
                console.log('      sync offsets (none):', differences.map((d) => d.toFixed(1)).join(' '));
            for (const d of differences) Math.abs(d).should.be.below(120);
        });
    });

    describe('what happens on the way', () => {
        it('lost and reordered packets: the recorder repairs, drops what it must, asks rarely for key frames, and the clip decodes', async () => {
            // 1 packet in 120 is lost for good (the SFU does not answer), 1 in 9 swaps places with the next
            await run({
                codec: 'vp8',
                seconds: 12,
                sr: 'sfu',
                retransmit: false,
                drop: (kind, i) => kind === 'video' && i % 120 === 60,
                reorder: (kind, i) => i % 9 === 4,
            });
            await feed.run();
            await settle(svc.api, 's1', { minFrames: 300, quietMs: 400 });
            const stats = (await svc.api.get('/v1/shares')).body.shares[0].stats;
            stats.video.lost.should.be.above(0);
            stats.video.lossEvents.should.be.above(0);
            // PLI at most once every 10 s (12 s of media)
            feed.stats.plis.should.be.within(1, 2);
            const response = await svc.api.post('/v1/clips', clipBody(10));
            response.status.should.equal(200, response.text);
            const file = path.join(svc.clipDir(response.body.id), 'clip.webm');
            (await media.decodeErrors(file)).should.equal('');
            (await media.streamPackets(file, 'v:0'))[0].key.should.be.true();
        });

        it('lost packets that the SFU sends again are repaired: no PLI', async () => {
            await run({
                codec: 'vp8',
                seconds: 9,
                sr: 'sfu',
                retransmit: true,
                drop: (kind, i) => kind === 'video' && i % 50 === 25,
            });
            await feed.run();
            await sleep(300);
            await settle(svc.api, 's1', { minFrames: 200, quietMs: 400 });
            const stats = (await svc.api.get('/v1/shares')).body.shares[0].stats;
            feed.stats.nacks.should.be.above(0);
            feed.stats.retransmitted.should.be.above(0);
            stats.video.recovered.should.be.above(0);
            stats.video.lost.should.equal(0);
            feed.stats.plis.should.equal(0);
        });

        it('a restart of the recorder in the middle: clips survive, the share is registered again and a new clip works', async () => {
            const dataDir = media.tmpDir('replay-e2e-restart-');
            try {
                await run({ codec: 'vp8', seconds: 16, sr: 'sfu' }, { dataDir });
                const running = feed.run();
                await sleep(6000);
                // a clip of the first part
                const first = await svc.api.post('/v1/clips', clipBody(4));
                first.status.should.equal(200, first.text);
                // the recorder is restarted (as an update would do)
                await svc.stop({ keepDir: true });
                svc = await startRecorder({ dataDir });
                (await svc.api.get('/v1/shares')).body.shares.should.have.length(0);
                (await svc.api.get('/v1/clips')).body.clips.map((c) => c.id).should.deepEqual([first.body.id]);
                // the SFU notices and registers the share again; the stream goes on to the new port
                const streams = feed.streams;
                const again = await svc.api.post('/v1/shares', {
                    shareId: 's1',
                    roomId: 'link',
                    peerName: 'Beltrano',
                    ...streams,
                });
                feed.setTarget(again.body.port);
                await running;
                await settle(svc.api, 's1', { minFrames: 100, quietMs: 400 });
                const second = await svc.api.post('/v1/clips', clipBody(4));
                second.status.should.equal(200, second.text);
                // the second clip only has what came after the restart, and plays
                const file = path.join(svc.clipDir(second.body.id), 'clip.webm');
                (await media.streamPackets(file, 'v:0'))[0].key.should.be.true();
                (await media.decodeErrors(file)).should.equal('');
                // the first clip is untouched
                (await media.decodeErrors(path.join(svc.clipDir(first.body.id), 'clip.webm'))).should.equal('');
                // the new share waits for a key frame (the stream has one every second) and asks for one only if none comes
                feed.stats.plis.should.be.below(3);
            } finally {
                if (svc) await svc.stop({ keepDir: true });
                svc = null;
                media.rmDir(dataDir);
            }
        });
    });
});
