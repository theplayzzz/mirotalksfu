'use strict';

require('should');

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const sinon = require('sinon');

const { startRecorder } = require('./lib/service');
const { VirtualFeed, streamsFor, settle, sleep } = require('./lib/feed');
const media = require('./lib/media');
const real = require('./lib/real');

const CLIP_ID = /^[a-z0-9-]{8,64}$/;

describe('replay: recorder with real media (virtual time)', function () {
    this.timeout(180000);
    let work;
    const samples = {};
    let svc;
    let feeds = [];

    before(async function () {
        media.requireFfmpeg(this);
        work = media.tmpDir('replay-rec-');
        samples.vp8 = real.loadFrames(await real.encode({ dir: work, name: 'vp8', codec: 'vp8', seconds: 20 }));
        samples.h264 = real.loadFrames(await real.encode({ dir: work, name: 'h264', codec: 'h264', seconds: 12 }));
    });

    after(() => work && media.rmDir(work));

    afterEach(async () => {
        feeds.forEach((f) => f.close());
        feeds = [];
        if (svc) await svc.stop();
        svc = null;
    });

    /** Registers a share and sends it `frames` (all of them, or the options of VirtualFeed.send). */
    async function share(shareId, codec, { audio = true, send = {}, feed = {}, register = {} } = {}) {
        const streams = streamsFor(codec, { audio });
        const registration = await svc.api.post('/v1/shares', {
            shareId,
            roomId: 'link',
            peerName: 'Beltrano',
            ...streams,
            ...register,
        });
        registration.status.should.equal(200);
        const virtual = new VirtualFeed({ port: registration.body.port, frames: samples[codec], streams, ...feed });
        feeds.push(virtual);
        if (send !== false) {
            await virtual.send(send);
            await settle(svc.api, shareId);
        }
        return { feed: virtual, streams, port: registration.body.port };
    }

    const clipRequest = (shareId, seconds = 8, extra = {}) => ({
        shareId,
        seconds,
        requestedByName: 'Fulano',
        requestedByHash: 'hash-of-fulano',
        sharerHash: 'hash-of-beltrano',
        requestId: `req-${Math.random().toString(36).slice(2)}`,
        ...extra,
    });

    describe('clips of a VP8 + Opus share', () => {
        it('makes the clip of section 5: file, thumbnail, metadata, event, and what the share reports', async () => {
            svc = await startRecorder({ housekeepingMs: 100 });
            await share('s1', 'vp8');

            const listed = (await svc.api.get('/v1/shares')).body.shares[0];
            listed.bufferSeconds.should.be.within(18, 20);
            listed.bytes.should.be.above(10000);
            listed.hasAudio.should.be.true();

            const started = Date.now();
            const response = await svc.api.post('/v1/clips', clipRequest('s1', 8));
            response.status.should.equal(200, response.text);
            (Date.now() - started).should.be.below(5000);
            const meta = response.body;
            meta.id.should.match(CLIP_ID);
            meta.should.containDeep({
                shareId: 's1',
                roomId: 'link',
                sharer: 'Beltrano',
                requestedBy: 'Fulano',
                seconds: 8,
                codec: 'vp8',
                hasAudio: true,
            });
            meta.requestedByHash.should.equal('hash-of-fulano');
            meta.sharerHash.should.equal('hash-of-beltrano');
            meta.durationS.should.be.approximately(8 + meta.startOffsetS, 0.2);
            meta.startOffsetS.should.be.within(0, 1.05); // key frames every second
            meta.expiresAt.should.equal(meta.createdAt + 7 * 24 * 3600 * 1000);
            meta.files.original.should.containEql({ name: 'clip.webm', mime: 'video/webm' });
            (meta.files.mp4 === null).should.be.true();
            meta.thumb.should.equal('thumb.jpg');

            const dir = svc.clipDir(meta.id);
            fs.readdirSync(dir).sort().should.deepEqual(['clip.webm', 'meta.json', 'thumb.jpg']);
            fs.statSync(path.join(dir, 'clip.webm')).size.should.equal(meta.files.original.bytes);
            JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).should.deepEqual(meta);
            // nothing half written is left around
            fs.readdirSync(path.join(svc.dir, 'clips')).should.deepEqual([meta.id]);

            const info = await media.probe(path.join(dir, 'clip.webm'));
            Number(info.format.duration).should.be.approximately(meta.durationS, 0.2);
            info.streams
                .map((s) => s.codec_name)
                .sort()
                .should.deepEqual(['opus', 'vp8']);
            (await media.streamPackets(path.join(dir, 'clip.webm'), 'v:0'))[0].key.should.be.true();
            (await media.decodeErrors(path.join(dir, 'clip.webm'))).should.equal('');

            const event = svc.events.find((e) => e.type === 'clip.created');
            event.clip.should.deepEqual(meta);

            (await svc.api.get(`/v1/clips/${meta.id}`)).body.should.deepEqual(meta);
            (await svc.api.get('/v1/clips')).body.clips.map((c) => c.id).should.deepEqual([meta.id]);
        });

        it('lists clips newest first, deletes them, and tells the SFU', async () => {
            svc = await startRecorder();
            await share('s1', 'vp8');
            const first = (await svc.api.post('/v1/clips', clipRequest('s1', 4))).body;
            await sleep(1100); // ids and times differ by a second at least
            const second = (await svc.api.post('/v1/clips', clipRequest('s1', 6))).body;
            (await svc.api.get('/v1/clips')).body.clips.map((c) => c.id).should.deepEqual([second.id, first.id]);

            (await svc.api.delete(`/v1/clips/${first.id}`)).body.should.deepEqual({ ok: true });
            svc.events.find((e) => e.type === 'clip.deleted').should.deepEqual({ type: 'clip.deleted', id: first.id });
            fs.existsSync(svc.clipDir(first.id)).should.be.false();
            (await svc.api.get(`/v1/clips/${first.id}`)).status.should.equal(404);
            (await svc.api.delete(`/v1/clips/${first.id}`)).status.should.equal(404);
            (await svc.api.get('/v1/clips/not$an$id')).status.should.equal(404);
            (await svc.api.get('/v1/clips')).body.clips.should.have.length(1);
        });

        it('validates the request, and answers with reasons', async () => {
            svc = await startRecorder({ bufferSeconds: 60 });
            await share('s1', 'vp8');
            const code = async (body) => (await svc.api.post('/v1/clips', body)).body.code;
            (await code({ ...clipRequest('s1'), seconds: 0 })).should.equal('BAD_REQUEST');
            (await code({ ...clipRequest('s1'), seconds: 61 })).should.equal('BAD_REQUEST');
            (await code({ ...clipRequest('s1'), seconds: 'ten' })).should.equal('BAD_REQUEST');
            (await code({ ...clipRequest('s1'), seconds: null })).should.equal('BAD_REQUEST');
            (await code({ ...clipRequest('s1'), shareId: undefined })).should.equal('BAD_REQUEST');
            (await code({ ...clipRequest('s1'), requestedByName: 5 })).should.equal('BAD_REQUEST');
            (await code(clipRequest('nope'))).should.equal('SHARE_NOT_FOUND');
            (await svc.api.post('/v1/clips', clipRequest('nope'))).status.should.equal(404);
            (await svc.api.get('/v1/clips')).body.clips.should.have.length(0);
            fs.readdirSync(path.join(svc.dir, 'clips')).should.deepEqual([]);
        });

        it('says "not ready" while the share has no key frame yet', async () => {
            svc = await startRecorder();
            await share('s1', 'vp8', { send: false });
            const response = await svc.api.post('/v1/clips', clipRequest('s1'));
            response.status.should.equal(409);
            response.body.code.should.equal('NOT_READY');
            fs.readdirSync(path.join(svc.dir, 'clips')).should.deepEqual([]); // no leftovers
        });

        it('makes one clip for a request that arrives twice (same requestId), and a new one after a failure', async () => {
            svc = await startRecorder();
            await share('s1', 'vp8');
            const body = clipRequest('s1', 4);
            const [a, b] = await Promise.all([svc.api.post('/v1/clips', body), svc.api.post('/v1/clips', body)]);
            a.body.id.should.equal(b.body.id);
            const c = await svc.api.post('/v1/clips', body);
            c.body.id.should.equal(a.body.id);
            (await svc.api.get('/v1/clips')).body.clips.should.have.length(1);
            svc.events.filter((e) => e.type === 'clip.created').should.have.length(1);
        });

        it('builds several clips at once, two at a time, all complete', async () => {
            svc = await startRecorder();
            await share('s1', 'vp8');
            let peak = 0;
            const sampler = setInterval(() => (peak = Math.max(peak, svc.recorder.builds.active)), 5);
            const responses = await Promise.all(
                [4, 5, 6, 7, 8].map((seconds) => svc.api.post('/v1/clips', clipRequest('s1', seconds)))
            );
            clearInterval(sampler);
            responses.map((r) => r.status).should.deepEqual([200, 200, 200, 200, 200]);
            new Set(responses.map((r) => r.body.id)).size.should.equal(5);
            peak.should.be.within(1, 2);
            for (const r of responses)
                (await media.decodeErrors(path.join(svc.clipDir(r.body.id), 'clip.webm'))).should.equal('');
            svc.recorder.builds.active.should.equal(0);
        });

        it('makes a clip shorter than asked when the share is young, and clips of ended shares until their buffer expires', async () => {
            svc = await startRecorder({ housekeepingMs: 100, keepAfterEndS: 1 });
            await share('s1', 'vp8', { send: { to: 6000 } });
            const young = (await svc.api.post('/v1/clips', clipRequest('s1', 60))).body;
            young.startOffsetS.should.equal(0);
            young.durationS.should.be.within(4.8, 6.2);
            young.seconds.should.equal(60);

            await svc.api.delete('/v1/shares/s1');
            const afterEnd = await svc.api.post('/v1/clips', clipRequest('s1', 4));
            afterEnd.status.should.equal(200); // the buffer is kept for REPLAY_KEEP_AFTER_END_S
            afterEnd.body.durationS.should.be.approximately(4 + afterEnd.body.startOffsetS, 0.3);

            await sleep(1800);
            (await svc.api.post('/v1/clips', clipRequest('s1', 4))).status.should.equal(404);
            fs.existsSync(path.join(svc.dir, 'buffers', 's1')).should.be.false();
            (await svc.api.get('/v1/clips')).body.clips.should.have.length(2); // the clips themselves stay
        });

        it('keeps the buffer inside its limit while a long share runs (ring on disk)', async () => {
            svc = await startRecorder({ bufferSeconds: 6, leadInSeconds: 3, chunkMs: 2000 });
            // 20 s of media through a ring that keeps 9 s
            await share('s1', 'vp8');
            const detail = (await svc.api.get('/v1/shares')).body.shares[0];
            detail.bufferSeconds.should.be.within(5, 6); // never more than REPLAY_BUFFER_SECONDS
            const files = fs.readdirSync(path.join(svc.dir, 'buffers', 's1')).filter((f) => f.endsWith('.log'));
            files.length.should.be.within(4, 7); // about 9 s of 2 s chunks, not 10
            const clip = (await svc.api.post('/v1/clips', clipRequest('s1', 6))).body;
            clip.durationS.should.be.approximately(6 + clip.startOffsetS, 0.3);
            clip.startOffsetS.should.be.within(0, 1.05);
            (await svc.api.post('/v1/clips', clipRequest('s1', 7))).status.should.equal(400); // above the buffer
        });
    });

    describe('H.264 share', () => {
        it('makes the MP4 directly: files.mp4 is set and no conversion is needed', async () => {
            svc = await startRecorder();
            await share('h1', 'h264');
            const meta = (await svc.api.post('/v1/clips', clipRequest('h1', 5))).body;
            meta.codec.should.equal('h264');
            meta.files.original.name.should.equal('clip.mp4');
            meta.files.mp4.name.should.equal('clip.mp4');
            meta.files.mp4.bytes.should.equal(meta.files.original.bytes);
            meta.hasAudio.should.be.true();
            const file = path.join(svc.clipDir(meta.id), 'clip.mp4');
            const info = await media.probe(file);
            info.streams
                .map((s) => s.codec_name)
                .sort()
                .should.deepEqual(['aac', 'h264']);
            (await media.streamPackets(file, 'v:0'))[0].key.should.be.true();
            (await media.decodeErrors(file)).should.equal('');
            // asking for the MP4 answers "ready" at once
            (await svc.api.post(`/v1/clips/${meta.id}/mp4`)).body.should.deepEqual({
                state: 'ready',
                progress: 1,
                etaSeconds: 0,
            });
            svc.events.filter((e) => e.type.startsWith('mp4.')).should.have.length(0);
        });
    });

    describe('MP4 conversion of a VP8 clip', () => {
        it('converts on request with progress events, then answers "ready" at once', async () => {
            svc = await startRecorder();
            await share('s1', 'vp8');
            const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 12))).body;
            const answer = await svc.api.post(`/v1/clips/${meta.id}/mp4`);
            answer.status.should.equal(200);
            ['queued', 'running'].should.containEql(answer.body.state);
            answer.body.progress.should.be.within(0, 1);
            answer.body.etaSeconds.should.be.above(0);
            // asking again while it runs reports the same job
            (await svc.api.post(`/v1/clips/${meta.id}/mp4`)).body.state.should.be.oneOf(['queued', 'running']);

            const ready = await svc.waitForEvent((e) => e.type === 'mp4.ready' && e.id === meta.id, 60000);
            ready.mp4.name.should.equal('clip.mp4');
            ready.mp4.bytes.should.be.above(1000);
            const progress = svc.events.filter((e) => e.type === 'mp4.progress' && e.id === meta.id);
            progress.length.should.be.above(0);
            progress[0].should.have.properties(['progress', 'etaSeconds']);
            progress.forEach((e, i) => i > 0 && e.progress.should.not.be.below(progress[i - 1].progress));

            const after = (await svc.api.get(`/v1/clips/${meta.id}`)).body;
            after.files.mp4.should.containEql({ name: 'clip.mp4', mime: 'video/mp4', bytes: ready.mp4.bytes });
            JSON.parse(
                fs.readFileSync(path.join(svc.clipDir(meta.id), 'meta.json'), 'utf8')
            ).files.mp4.bytes.should.equal(ready.mp4.bytes);
            (await svc.api.post(`/v1/clips/${meta.id}/mp4`)).body.should.deepEqual({
                state: 'ready',
                progress: 1,
                etaSeconds: 0,
            });
            const mp4 = path.join(svc.clipDir(meta.id), 'clip.mp4');
            Number((await media.probe(mp4)).format.duration).should.be.approximately(12, 0.4); // the visible part only
            (await media.decodeErrors(mp4)).should.equal('');
            (await svc.api.get('/v1/health')).body.conversions.should.deepEqual({ running: 0, queued: 0 });
        });

        it('stops the conversion when the clip is deleted during it', async () => {
            svc = await startRecorder();
            await share('s1', 'vp8');
            const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 18))).body;
            await svc.api.post(`/v1/clips/${meta.id}/mp4`);
            await svc.waitForEvent((e) => e.type === 'mp4.progress' && e.id === meta.id, 30000);
            (await svc.api.get('/v1/health')).body.conversions.running.should.equal(1);
            const started = Date.now();
            (await svc.api.delete(`/v1/clips/${meta.id}`)).body.should.deepEqual({ ok: true });
            (Date.now() - started).should.be.below(5000);
            (await svc.api.get('/v1/health')).body.conversions.should.deepEqual({ running: 0, queued: 0 });
            fs.existsSync(svc.clipDir(meta.id)).should.be.false();
            await sleep(500);
            svc.events.filter((e) => e.type === 'mp4.ready' || e.type === 'mp4.error').should.have.length(0);
            (await svc.api.post(`/v1/clips/${meta.id}/mp4`)).status.should.equal(404);
        });

        it('reports the failure of a conversion as mp4.error', async () => {
            svc = await startRecorder();
            await share('s1', 'vp8');
            const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 5))).body;
            await fsp.writeFile(path.join(svc.clipDir(meta.id), 'clip.webm'), 'this is no longer a video');
            await svc.api.post(`/v1/clips/${meta.id}/mp4`);
            const error = await svc.waitForEvent((e) => e.type === 'mp4.error' && e.id === meta.id, 30000);
            error.message.should.be.a.String().and.not.be.empty();
            (await svc.api.get(`/v1/clips/${meta.id}`)).body.files.mp4 === null;
            fs.existsSync(path.join(svc.clipDir(meta.id), 'clip.mp4.part')).should.be.false();
            // it can be asked again
            (await svc.api.post(`/v1/clips/${meta.id}/mp4`)).body.state.should.be.oneOf(['queued', 'running']);
        });
    });

    describe('audio and video details', () => {
        it('records a share without audio: a clip with only video', async () => {
            svc = await startRecorder();
            await share('s1', 'vp8', { audio: false });
            const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 5))).body;
            meta.hasAudio.should.be.false();
            const file = path.join(svc.clipDir(meta.id), 'clip.webm');
            (await media.probe(file)).streams.map((s) => s.codec_type).should.deepEqual(['video']);
            (await media.decodeErrors(file)).should.equal('');
        });

        it('takes the audio that joins after the video (PATCH): the clip has audio from then on', async () => {
            svc = await startRecorder();
            const streams = streamsFor('vp8', { audio: true });
            const registration = await svc.api.post('/v1/shares', {
                shareId: 's1',
                roomId: 'link',
                peerName: 'B',
                video: streams.video,
            });
            const feed = new VirtualFeed({ port: registration.body.port, frames: samples.vp8, streams });
            feeds.push(feed);
            await feed.send({ to: 8000, audio: false });
            await settle(svc.api, 's1');
            (await svc.api.get('/v1/shares')).body.shares[0].hasAudio.should.be.false();
            (await svc.api.patch('/v1/shares/s1', { audio: streams.audio })).body.should.deepEqual({ ok: true });
            (await svc.api.get('/v1/shares')).body.shares[0].hasAudio.should.be.true();
            await feed.send({ from: 8000 });
            await settle(svc.api, 's1', { minFrames: 400 });
            const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 20))).body;
            meta.hasAudio.should.be.true();
            const file = path.join(svc.clipDir(meta.id), 'clip.webm');
            const audio = await media.streamPackets(file, 'a:0');
            audio[0].pts.should.be.approximately(8, 0.25); // starts when the audio joined
            (await media.decodeErrors(file)).should.equal('');
        });

        it('stops writing while paused and carries on after resume (waiting for a key frame)', async () => {
            svc = await startRecorder();
            const { feed } = await share('s1', 'vp8', { send: { to: 5000 } });
            await svc.api.patch('/v1/shares/s1', { paused: true });
            await feed.send({ from: 5000, to: 10000 });
            await settle(svc.api, 's1', { quietMs: 300 });
            const paused = (await svc.api.get('/v1/shares')).body.shares[0];
            paused.stats.framesDropped.should.be.above(100);
            await svc.api.patch('/v1/shares/s1', { paused: false });
            await feed.send({ from: 10000 });
            await settle(svc.api, 's1', { quietMs: 300 });
            const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 15))).body;
            const file = path.join(svc.clipDir(meta.id), 'clip.webm');
            // The clip starts at the key frame before 5 s (source time 4 s: pts 0): the second before the pause is
            // there, the paused part (source 5 s to 10 s, pts 1 to 6) is a gap, and the rest comes after the resume.
            const video = await media.streamPackets(file, 'v:0');
            video.filter((p) => p.pts < 1.0).length.should.be.within(28, 31);
            video.filter((p) => p.pts >= 5.9).length.should.be.above(280);
            video.filter((p) => p.pts > 1.1 && p.pts < 5.8).should.have.length(0);
            (await media.decodeErrors(file)).should.equal('');
        });
    });

    describe('lost and reordered packets', () => {
        it('puts reordered packets back in order: no frame is lost', async () => {
            svc = await startRecorder();
            const expected = samples.vp8.video.length;
            const { feed } = await share('s1', 'vp8', { feed: { swap: (kind, i) => i % 7 === 3 } });
            const stats = (await svc.api.get('/v1/shares')).body.shares[0].stats;
            stats.video.frames.should.equal(expected - 0); // every frame of the stream arrived
            stats.video.lost.should.equal(0);
            stats.video.lossEvents.should.equal(0);
            feed.received.filter((p) => p.type === 'pli').should.have.length(0);
            const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 18))).body;
            const file = path.join(svc.clipDir(meta.id), 'clip.webm');
            (await media.decodeErrors(file)).should.equal('');
        });

        it('repairs lost packets with NACKs (the SFU sends them again): no frame is lost, no key frame requested', async () => {
            svc = await startRecorder();
            const expected = samples.vp8.video.length;
            const lost = new Set([30, 31, 150, 300, 301, 302, 303]);
            const { feed } = await share('s1', 'vp8', {
                send: false,
                feed: { retransmit: true, drop: (kind, i) => kind === 'video' && lost.has(i) },
            });
            await feed.send();
            // the NACKs go out on the 10 ms tick, after the send is over: let them work
            await sleep(400);
            await settle(svc.api, 's1', { quietMs: 400 });
            const stats = (await svc.api.get('/v1/shares')).body.shares[0].stats;
            feed.received.filter((p) => p.type === 'nack').length.should.be.above(0);
            feed.retransmitted.should.be.above(0);
            stats.video.recovered.should.be.above(3);
            stats.video.lost.should.equal(0);
            stats.video.frames.should.equal(expected);
            feed.received.filter((p) => p.type === 'pli').should.have.length(0);
        });

        it('drops what it cannot repair, waits for a key frame, asks once for it, and the clip decodes cleanly', async () => {
            svc = await startRecorder();
            // a packet of the middle of the stream is lost and the SFU does not answer
            const { feed } = await share('s1', 'vp8', {
                send: false,
                feed: { retransmit: false, drop: (kind, i) => kind === 'video' && i === 150 },
            });
            await feed.send();
            await sleep(500);
            await settle(svc.api, 's1', { quietMs: 400 });
            const stats = (await svc.api.get('/v1/shares')).body.shares[0].stats;
            stats.video.lost.should.equal(1);
            stats.video.lossEvents.should.equal(1);
            stats.video.droppedWaitingKey.should.be.within(0, 40); // frames up to the next key frame (1 s) at most
            feed.received.filter((p) => p.type === 'pli').should.have.length(1);
            stats.video.frames.should.be.below(samples.vp8.video.length);
            stats.video.frames.should.be.above(samples.vp8.video.length - 60);
            const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 18))).body;
            (await media.decodeErrors(path.join(svc.clipDir(meta.id), 'clip.webm'))).should.equal('');
        });
    });

    describe('restart, quota, retention, disk guard', () => {
        it('keeps the clips over a restart and forgets the buffers (they are rebuilt from the SFU registration)', async () => {
            const dataDir = media.tmpDir('replay-restart-');
            try {
                svc = await startRecorder({ dataDir });
                await share('s1', 'vp8');
                const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 5))).body;
                await svc.stop();

                svc = await startRecorder({ dataDir });
                (await svc.api.get('/v1/shares')).body.shares.should.have.length(0);
                fs.readdirSync(path.join(dataDir, 'buffers')).should.deepEqual([]);
                (await svc.api.get('/v1/clips')).body.clips.map((c) => c.id).should.deepEqual([meta.id]);
                (await svc.api.get(`/v1/clips/${meta.id}`)).body.should.deepEqual(meta);
                (await svc.api.post('/v1/clips', clipRequest('s1', 5))).status.should.equal(404); // the share is not known
                // the SFU registers its shares again and recording resumes
                await share('s1', 'vp8');
                (await svc.api.post('/v1/clips', clipRequest('s1', 5))).status.should.equal(200);
                (await svc.api.get('/v1/clips')).body.clips.should.have.length(2);
                await svc.stop();
            } finally {
                svc = null;
                media.rmDir(dataDir);
            }
        });

        it('deletes the oldest clips when the quota is exceeded, never the one just made', async () => {
            svc = await startRecorder();
            await share('s1', 'vp8');
            const first = (await svc.api.post('/v1/clips', clipRequest('s1', 6))).body;
            const size = first.files.original.bytes;
            svc.recorder.opts.quotaGb = (size * 1.6) / 1024 ** 3; // room for one and a half clips
            await sleep(1100);
            const second = (await svc.api.post('/v1/clips', clipRequest('s1', 6))).body;
            const ids = (await svc.api.get('/v1/clips')).body.clips.map((c) => c.id);
            ids.should.deepEqual([second.id]);
            svc.events.find((e) => e.type === 'clip.deleted' && e.id === first.id).should.be.ok();
            fs.existsSync(svc.clipDir(first.id)).should.be.false();
            // a clip bigger than the whole quota is still kept (it is the one that was just asked for)
            svc.recorder.opts.quotaGb = 100 / 1024 ** 3;
            await sleep(1100);
            const third = (await svc.api.post('/v1/clips', clipRequest('s1', 6))).body;
            (await svc.api.get('/v1/clips')).body.clips.map((c) => c.id).should.deepEqual([third.id]);
        });

        it('deletes clips after REPLAY_RETENTION_DAYS (hourly sweep)', async () => {
            let clock = Date.now();
            svc = await startRecorder({ retentionDays: 2, now: () => clock });
            await share('s1', 'vp8');
            const meta = (await svc.api.post('/v1/clips', clipRequest('s1', 5))).body;
            meta.expiresAt.should.equal(meta.createdAt + 2 * 24 * 3600 * 1000);
            clock += 47 * 3600 * 1000;
            await svc.recorder._sweepClips();
            (await svc.api.get('/v1/clips')).body.clips.should.have.length(1);
            clock += 2 * 3600 * 1000;
            await svc.recorder._sweepClips();
            (await svc.api.get('/v1/clips')).body.clips.should.have.length(0);
            svc.events.find((e) => e.type === 'clip.deleted' && e.id === meta.id).should.be.ok();
            fs.existsSync(svc.clipDir(meta.id)).should.be.false();
        });

        it('guards the disk: deletes old clips first, then stops writing and refuses clips until there is room', async () => {
            svc = await startRecorder({ minFreeGb: 5 });
            const { feed } = await share('s1', 'vp8', { send: { to: 10000 } });
            const old = (await svc.api.post('/v1/clips', clipRequest('s1', 5))).body;
            await sleep(1100);
            const newer = (await svc.api.post('/v1/clips', clipRequest('s1', 5))).body;

            // statfs says: 1 GB free; deleting the first clip frees "2 GB", the second "9 GB" in this fiction
            let freed = 0;
            const free = (gb) => ({ bavail: (gb * 1024 ** 3) / 4096, bsize: 4096 });
            sinon.stub(fsp, 'statfs').callsFake(async () => free(1 + freed * 8));
            const before = svc.events.length;
            svc.recorder.opts.minFreeGb = 5;
            const remove = svc.recorder._removeClip.bind(svc.recorder);
            svc.recorder._removeClip = async (id) => {
                freed++;
                return remove(id);
            };
            await svc.recorder._guardDisk();
            // the oldest clip was deleted, and that was enough (1 + 8 GB >= 5 GB)
            svc.events
                .slice(before)
                .filter((e) => e.type === 'clip.deleted')
                .map((e) => e.id)
                .should.deepEqual([old.id]);
            svc.recorder.diskLow.should.be.false();
            (await svc.api.get('/v1/health')).body.diskFreeGb.should.be.approximately(9, 0.01);

            // now nothing helps: the disk stays low
            sinon.restore();
            sinon.stub(fsp, 'statfs').callsFake(async () => free(0.5));
            await svc.recorder._guardDisk();
            svc.recorder.diskLow.should.be.true();
            (await svc.api.get('/v1/health')).body.diskLow.should.be.true();
            (await svc.api.get('/v1/clips')).body.clips.should.have.length(0); // everything was reclaimed
            const refused = await svc.api.post('/v1/clips', clipRequest('s1', 5));
            refused.status.should.equal(503);
            refused.body.code.should.equal('DISK_LOW');
            // frames are not written while the disk is low
            const writtenBefore = (await svc.api.get('/v1/shares')).body.shares[0].stats.store.framesWritten;
            await feed.send({ from: 10000, to: 14000 });
            await settle(svc.api, 's1', { quietMs: 300 });
            const during = (await svc.api.get('/v1/shares')).body.shares[0].stats;
            during.store.framesWritten.should.equal(writtenBefore);
            during.framesDropped.should.be.above(50);
            // and when there is room again (with a margin) everything goes on
            sinon.restore();
            sinon.stub(fsp, 'statfs').callsFake(async () => free(20));
            await svc.recorder._guardDisk();
            svc.recorder.diskLow.should.be.false();
            newer.id.should.be.a.String();
            await feed.send({ from: 14000 });
            await settle(svc.api, 's1', { quietMs: 300 });
            (await svc.api.post('/v1/clips', clipRequest('s1', 5))).status.should.equal(200);
        });
    });
});
