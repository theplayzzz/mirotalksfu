'use strict';

require('should');

const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');

const { createRecorder, optionsFromEnv } = require('../../app/src/replay/Recorder');
const { startRecorder, SECRET } = require('./lib/service');
const gen = require('./lib/gen');
const media = require('./lib/media');

const video = { codec: 'VP8', payloadType: 101, ssrc: 1111, clockRate: 90000 };
const audio = { codec: 'opus', payloadType: 100, ssrc: 3333, clockRate: 48000, channels: 2 };
const { eventually } = require('./lib/feed');

describe('replay: recorder control API', function () {
    this.timeout(30000);
    let svc;

    beforeEach(async () => {
        svc = await startRecorder({ housekeepingMs: 150 });
    });

    afterEach(async () => {
        if (svc) await svc.stop();
        svc = null;
    });

    describe('authentication and errors', () => {
        it('needs the secret on every request, and compares it exactly', async () => {
            (await svc.api.get('/v1/health', { secret: null })).status.should.equal(401);
            (await svc.api.get('/v1/health', { secret: 'wrong' })).status.should.equal(401);
            (await svc.api.get('/v1/health', { secret: SECRET + 'x' })).status.should.equal(401);
            (await svc.api.get('/v1/health', { secret: SECRET.slice(0, -1) })).status.should.equal(401);
            (await svc.api.get('/v1/health', { secret: '' })).status.should.equal(401);
            const denied = await svc.api.get('/v1/shares', { secret: 'nope' });
            denied.body.should.deepEqual({ error: 'missing or wrong secret', code: 'UNAUTHORIZED' });
            // even endpoints that do not exist say nothing to the unauthenticated
            (await svc.api.get('/v1/whatever', { secret: 'nope' })).status.should.equal(401);
            (await svc.api.get('/v1/health')).status.should.equal(200);
        });

        it('answers errors as { error, code } with a 4xx status', async () => {
            const unknown = await svc.api.get('/v1/nothing');
            unknown.status.should.equal(404);
            unknown.body.code.should.equal('NOT_FOUND');
            unknown.body.error.should.be.a.String();
            const method = await svc.api.request('PUT', '/v1/shares', {});
            method.status.should.equal(405);
            method.body.code.should.equal('METHOD_NOT_ALLOWED');
            const bad = await svc.api.request('POST', '/v1/shares', undefined, { raw: '{not json' });
            bad.status.should.equal(400);
            bad.body.code.should.equal('BAD_JSON');
            const array = await svc.api.request('POST', '/v1/shares', undefined, { raw: '[1,2]' });
            array.status.should.equal(400);
            const huge = await svc.api.request('POST', '/v1/shares', undefined, {
                raw: JSON.stringify({ shareId: 'x'.repeat(200000) }),
            });
            huge.status.should.equal(413);
            huge.body.code.should.equal('TOO_LARGE');
            (await svc.api.get('/v1/shares/abc')).status.should.equal(405); // the path exists, GET is not allowed on it
            (await svc.api.delete('/v1/shares/%E0%A4%A')).status.should.equal(400); // bad percent encoding
        });
    });

    describe('health', () => {
        it('reports what the SFU and the operators need', async () => {
            const { status, body } = await svc.api.get('/v1/health');
            status.should.equal(200);
            body.ok.should.be.true();
            body.version.should.be.a.String();
            body.diskFreeGb.should.be.a.Number();
            body.diskFreeGb.should.be.above(0);
            body.shares.should.equal(0);
            body.conversions.should.deepEqual({ running: 0, queued: 0 });
            body.cpuPercent.should.be.a.Number();
            body.bootId.should.be.a.String();
            body.startedAt.should.be.above(0);
        });

        it('counts the active shares', async () => {
            await svc.api.post('/v1/shares', { shareId: 's1', roomId: 'link', peerName: 'A', video });
            await svc.api.post('/v1/shares', {
                shareId: 's2',
                roomId: 'link',
                peerName: 'B',
                video: { ...video, ssrc: 5 },
            });
            (await svc.api.get('/v1/health')).body.shares.should.equal(2);
            await svc.api.delete('/v1/shares/s1');
            (await svc.api.get('/v1/health')).body.shares.should.equal(1);
        });
    });

    describe('shares', () => {
        it('registers a share and answers the UDP port to send to', async () => {
            const { status, body } = await svc.api.post('/v1/shares', {
                shareId: 'abc-123',
                roomId: 'link',
                peerName: 'Beltrano',
                video,
                audio,
            });
            status.should.equal(200);
            body.port.should.be.a.Number();
            body.port.should.be.within(1, 65535);
            fs.existsSync(path.join(svc.dir, 'buffers', 'abc-123')).should.be.true();
            const list = (await svc.api.get('/v1/shares')).body.shares;
            list.should.have.length(1);
            list[0].should.containDeep({
                shareId: 'abc-123',
                roomId: 'link',
                peerName: 'Beltrano',
                ended: false,
                codec: 'vp8',
                hasAudio: true,
                bufferSeconds: 0,
                bytes: 0,
            });
            list[0].startedAt.should.be.within(Date.now() - 10000, Date.now() + 1000);
        });

        it('gives each share its own port', async () => {
            const a = (await svc.api.post('/v1/shares', { shareId: 'a', video })).body.port;
            const b = (await svc.api.post('/v1/shares', { shareId: 'b', video: { ...video, ssrc: 2 } })).body.port;
            a.should.not.equal(b);
        });

        it('is idempotent: registering again gives the same port; audio can come later', async () => {
            const first = await svc.api.post('/v1/shares', { shareId: 's', roomId: 'link', peerName: 'A', video });
            const again = await svc.api.post('/v1/shares', { shareId: 's', roomId: 'link', peerName: 'A', video });
            again.body.port.should.equal(first.body.port);
            (await svc.api.get('/v1/shares')).body.shares[0].hasAudio.should.be.false();
            (await svc.api.patch('/v1/shares/s', { audio })).body.should.deepEqual({ ok: true });
            (await svc.api.get('/v1/shares')).body.shares[0].hasAudio.should.be.true();
            (await svc.api.patch('/v1/shares/s', { audio })).body.should.deepEqual({ ok: true }); // a retry changes nothing
        });

        it('validates what it is given', async () => {
            const post = (body) => svc.api.post('/v1/shares', body);
            const code = async (body) => (await post(body)).body.code;
            (await code({ video })).should.equal('BAD_REQUEST'); // no shareId
            (await code({ shareId: '../etc', video })).should.equal('BAD_REQUEST');
            (await code({ shareId: 'a/b', video })).should.equal('BAD_REQUEST');
            (await code({ shareId: 'x'.repeat(101), video })).should.equal('BAD_REQUEST');
            (await code({ shareId: 'ok' })).should.equal('BAD_STREAM'); // no video
            (await code({ shareId: 'ok', video: { ...video, codec: 'VP9' } })).should.equal('UNSUPPORTED_CODEC');
            (await code({ shareId: 'ok', video: { ...video, codec: 'opus' } })).should.equal('UNSUPPORTED_CODEC');
            (await code({ shareId: 'ok', video, audio: { ...audio, codec: 'VP8' } })).should.equal('UNSUPPORTED_CODEC');
            (await code({ shareId: 'ok', video: { ...video, ssrc: 0 } })).should.equal('BAD_STREAM');
            (await code({ shareId: 'ok', video: { ...video, ssrc: 2 ** 32 } })).should.equal('BAD_STREAM');
            (await code({ shareId: 'ok', video: { ...video, payloadType: 200 } })).should.equal('BAD_STREAM');
            (await code({ shareId: 'ok', video: { ...video, payloadType: 'x' } })).should.equal('BAD_STREAM');
            (await code({ shareId: 'ok', video, audio: { ...audio, ssrc: video.ssrc } })).should.equal('BAD_STREAM');
            (await post({ shareId: 'ok', video: { ...video, codec: 'video/VP8' } })).status.should.equal(200); // mime style names work
            (
                await post({ shareId: 'ok2', video: { ...video, codec: 'h264', fmtp: { 'packetization-mode': 1 } } })
            ).status.should.equal(200);
            (await svc.api.get('/v1/shares')).body.shares.should.have.length(2); // the bad ones left nothing behind
            fs.readdirSync(path.join(svc.dir, 'buffers')).sort().should.deepEqual(['ok', 'ok2']);
        });

        it('pauses and resumes, and rejects bad patches', async () => {
            await svc.api.post('/v1/shares', { shareId: 's', video });
            (await svc.api.patch('/v1/shares/s', { paused: true })).body.should.deepEqual({ ok: true });
            (await svc.api.get('/v1/shares')).body.shares[0].stats.paused.should.be.true();
            (await svc.api.patch('/v1/shares/s', { paused: false })).body.should.deepEqual({ ok: true });
            (await svc.api.get('/v1/shares')).body.shares[0].stats.paused.should.be.false();
            (await svc.api.patch('/v1/shares/s', {})).body.code.should.equal('BAD_REQUEST');
            (await svc.api.patch('/v1/shares/s', { paused: 'yes' })).body.code.should.equal('BAD_REQUEST');
            (await svc.api.patch('/v1/shares/s', { audio: 'no' })).body.code.should.equal('BAD_STREAM');
            (await svc.api.patch('/v1/shares/nope', { paused: true })).status.should.equal(404);
        });

        it('ends a share: its buffer stays for a while, nothing more is accepted', async () => {
            await svc.api.post('/v1/shares', { shareId: 's', video });
            (await svc.api.delete('/v1/shares/s')).body.should.deepEqual({ ok: true });
            const share = (await svc.api.get('/v1/shares')).body.shares[0];
            share.ended.should.be.true();
            fs.existsSync(path.join(svc.dir, 'buffers', 's')).should.be.true();
            (await svc.api.delete('/v1/shares/s')).body.should.deepEqual({ ok: true }); // again is fine
            (await svc.api.patch('/v1/shares/s', { paused: true })).status.should.equal(409);
            (await svc.api.delete('/v1/shares/unknown')).status.should.equal(404);
            // the same id can be registered again: a new life, a new buffer
            const again = await svc.api.post('/v1/shares', { shareId: 's', video });
            again.status.should.equal(200);
            (await svc.api.get('/v1/shares')).body.shares[0].ended.should.be.false();
        });

        it('deletes the buffer of an ended share after REPLAY_KEEP_AFTER_END_S', async () => {
            await svc.stop();
            svc = await startRecorder({ housekeepingMs: 100, keepAfterEndS: 0.3 });
            await svc.api.post('/v1/shares', { shareId: 's', video });
            await svc.api.delete('/v1/shares/s');
            fs.existsSync(path.join(svc.dir, 'buffers', 's')).should.be.true();
            await eventually(
                async () =>
                    (await svc.api.get('/v1/shares')).body.shares.length === 0 &&
                    !fs.existsSync(path.join(svc.dir, 'buffers', 's')),
                { timeoutMs: 10000, message: 'the buffer of the ended share to be deleted' }
            );
        });

        it('refuses too many shares', async () => {
            for (let i = 0; i < 32; i++)
                (await svc.api.post('/v1/shares', { shareId: `s${i}`, video })).status.should.equal(200);
            const extra = await svc.api.post('/v1/shares', { shareId: 'one-more', video });
            extra.status.should.equal(503);
            extra.body.code.should.equal('TOO_MANY_SHARES');
        });
    });

    describe('events', () => {
        it('sends a buffers event with the active shares and the free disk space', async () => {
            await svc.api.post('/v1/shares', { shareId: 's', roomId: 'link', peerName: 'A', video, audio });
            const event = await svc.waitForEvent((e) => e.type === 'buffers' && e.shares.length === 1, 3000);
            event.shares[0].should.deepEqual({ shareId: 's', bufferSeconds: 0, codec: 'vp8', hasAudio: true });
            event.diskFreeGb.should.be.a.Number();
            // a share that ended is not offered for replay any more
            await svc.api.delete('/v1/shares/s');
            const later = await svc.waitForEvent(
                (e) =>
                    e.type === 'buffers' && e.shares.length === 0 && svc.events.indexOf(e) > svc.events.indexOf(event),
                3000
            );
            later.shares.should.have.length(0);
            // every 5 s in production; here the housekeeping runs faster
            svc.events.filter((e) => e.type === 'buffers').length.should.be.above(1);
        });
    });

    describe('robustness', () => {
        it('survives garbage on the UDP port: malformed packets, unknown SSRCs, bad RTCP, truncated RTP', async () => {
            const { body } = await svc.api.post('/v1/shares', { shareId: 's', video, audio });
            const socket = dgram.createSocket('udp4');
            const send = (buf) => new Promise((resolve) => socket.send(buf, body.port, '127.0.0.1', resolve));
            const unknown = gen.vp8Packets(gen.vp8Frame({ key: true, size: 300 }), {
                timestamp: 1,
                ssrc: 99999,
                firstSeq: 1,
            })[0];
            const truncated = gen
                .vp8Packets(gen.vp8Frame({ key: true, size: 300 }), { timestamp: 1, ssrc: 1111, firstSeq: 1 })[0]
                .subarray(0, 14);
            const garbage = [
                Buffer.alloc(0),
                Buffer.from([1]),
                Buffer.from([0x80]),
                Buffer.alloc(7, 0x80),
                Buffer.alloc(40, 0xff),
                Buffer.from([0x80, 200, 0, 99, 0, 0, 0, 0, 0, 0, 0, 0]), // RTCP claiming more words than it has
                Buffer.from([0x80, 205, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2]),
                Buffer.from([0x40, 96, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 3, 4, 5]), // wrong RTP version
                unknown,
                truncated,
                Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff)),
            ];
            for (let round = 0; round < 20; round++) for (const g of garbage) await send(g);
            // UDP on a loaded machine: wait until the recorder has taken what it is going to take
            let last = -1;
            const detail = await eventually(
                async () => {
                    const stats = (await svc.api.get('/v1/shares')).body.shares[0].stats;
                    const settled = stats.datagrams === last && stats.datagrams > 100;
                    last = stats.datagrams;
                    return settled ? stats : null;
                },
                { timeoutMs: 10000, intervalMs: 150, message: 'the datagrams to arrive' }
            );
            socket.close();
            (await svc.api.get('/v1/health')).status.should.equal(200);
            detail.datagrams.should.be.above(100);
            (detail.malformed + detail.unknownSsrc).should.be.above(50);
        });

        it('refuses to be created or started without a secret, and reads its settings from the environment', () => {
            (() => createRecorder({ dataDir: svc.dir })).should.throw(/secret/);
            (() => createRecorder({ secret: 'x' })).should.throw(/dataDir/);
            const options = optionsFromEnv({
                REPLAY_LISTEN_PORT: '7100',
                REPLAY_BUFFER_SECONDS: '120',
                REPLAY_QUOTA_GB: '1.5',
                REPLAY_INTERNAL_SECRET: 's',
                REPLAY_MP4_HEIGHT: '480',
            });
            options.listenPort.should.equal(7100);
            options.bufferSeconds.should.equal(120);
            options.quotaGb.should.equal(1.5);
            options.mp4Height.should.equal(480);
            options.secret.should.equal('s');
            options.leadInSeconds.should.equal(90); // the documented defaults
            options.keepAfterEndS.should.equal(120);
            options.retentionDays.should.equal(7);
            options.minFreeGb.should.equal(10);
            options.ffmpegThreads.should.equal(2);
            options.dataDir.should.equal('/data/replays');
            options.listenPort.should.not.equal(optionsFromEnv({}).listenPort);
            optionsFromEnv({}).listenPort.should.equal(7000);
        });
    });
});

describe('replay: startup cleanup', function () {
    this.timeout(30000);

    it('deletes the buffers a previous run left, and half written clips, but keeps the finished clips', async () => {
        const dir = media.tmpDir('replay-start-');
        try {
            fs.mkdirSync(path.join(dir, 'buffers', 'old-share'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'buffers', 'old-share', '00000001.log'), 'x'.repeat(1000));
            fs.mkdirSync(path.join(dir, 'clips', '.tmp-20260101-000000-aaaaaaaa-bbbb'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'clips', '.tmp-20260101-000000-aaaaaaaa-bbbb', 'clip.webm'), 'partial');
            fs.mkdirSync(path.join(dir, 'clips', '20260101-000000-cccccccc-dddd'), { recursive: true }); // no meta.json
            fs.writeFileSync(path.join(dir, 'clips', '20260101-000000-cccccccc-dddd', 'clip.webm'), 'orphan');
            fs.mkdirSync(path.join(dir, 'clips', 'not-a-clip-dir'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'clips', 'not-a-clip-dir', 'meta.json'), '{ broken');
            const id = '20260102-000000-eeeeeeee-ffff';
            fs.mkdirSync(path.join(dir, 'clips', id), { recursive: true });
            fs.writeFileSync(path.join(dir, 'clips', id, 'clip.webm'), 'media');
            fs.writeFileSync(path.join(dir, 'clips', id, 'clip.mp4.part'), 'half converted');
            const meta = {
                id,
                shareId: 's',
                roomId: 'link',
                createdAt: Date.now() - 1000,
                expiresAt: Date.now() + 86400000,
                codec: 'vp8',
                seconds: 60,
                durationS: 61,
                startOffsetS: 1,
                hasAudio: false,
                files: { original: { name: 'clip.webm', mime: 'video/webm', bytes: 5 }, mp4: null },
            };
            fs.writeFileSync(path.join(dir, 'clips', id, 'meta.json'), JSON.stringify(meta));

            const svc = await startRecorder({ dataDir: dir });
            try {
                fs.readdirSync(path.join(dir, 'buffers')).should.deepEqual([]);
                fs.readdirSync(path.join(dir, 'clips')).should.deepEqual([id]);
                fs.readdirSync(path.join(dir, 'clips', id))
                    .sort()
                    .should.deepEqual(['clip.webm', 'meta.json']);
                const list = (await svc.api.get('/v1/clips')).body.clips;
                list.map((c) => c.id).should.deepEqual([id]);
                (await svc.api.get(`/v1/clips/${id}`)).body.shareId.should.equal('s');
                (await svc.api.get('/v1/shares')).body.shares.should.have.length(0);
            } finally {
                await svc.stop({ keepDir: true });
            }
        } finally {
            media.rmDir(dir);
        }
    });
});
