'use strict';

require('should');

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createReplayRouter, createInternalEventsHandler, isInternalRequest, secretMatches, safeName, CLIP_ID } = require('../../app/src/replay/ReplayRoutes');
const { ReplayAccess, COOKIE_NAME } = require('../../app/src/replay/ReplayAccess');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const ID = '20261003-190600-aa5ba8cb-f18d';
const WEBM = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'.repeat(30)); // 1080 bytes
const SECRET = 'a-secret-that-is-not-the-default-one';

describe('test-sfu-routes-media (what the gallery serves, and to whom)', () => {
    let dir;
    let server;
    let access;
    let baseUrl;
    let cookie;
    const recorderEvents = [];
    let startedMp4 = [];
    let sse = 0;

    before((done) => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-media-'));
        const clipDir = path.join(dir, 'clips', ID);
        fs.mkdirSync(clipDir, { recursive: true });
        fs.writeFileSync(path.join(clipDir, 'clip.webm'), WEBM);
        fs.writeFileSync(path.join(clipDir, 'thumb.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        fs.writeFileSync(path.join(clipDir, 'meta.json'), JSON.stringify({ sharer: 'Béltrano ação', createdAt: Date.UTC(2026, 9, 3, 19, 6, 0) }));
        fs.writeFileSync(path.join(clipDir, 'secret.txt'), 'not a clip file');
        fs.writeFileSync(path.join(dir, 'outside.webm'), 'outside the clips');

        access = new ReplayAccess({ secret: SECRET, roomPassword: 'pw' });
        const client = {
            async listClips() {
                return { clips: [] };
            },
            async getClip() {
                return { id: ID, requestedByHash: access.hashPeer('saver'), sharerHash: access.hashPeer('sharer') };
            },
            async deleteClip() {
                return { ok: true };
            },
            async startMp4(id) {
                startedMp4.push(id);
                return { state: 'running', progress: 0.5, etaSeconds: 7 };
            },
        };
        const hub = {
            handleRecorderEvent: (event) => recorderEvents.push(event),
            subscribe: (req, res) => {
                sse++;
                res.end();
            },
        };
        const router = createReplayRouter({ hub, access, client, singleRoom: { enabled: true, roomId: 'link', matches: (p) => p === 'pw' }, pageFile: __filename, dataDir: dir, log: silent });

        const app = express();
        app.use(express.json());
        app.use('/replay', router);
        app.post('/internal/replay/events', createInternalEventsHandler({ hub, secret: SECRET }));
        cookie = `${COOKIE_NAME}=${access.signAccess()}`;
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
            baseUrl = `http://127.0.0.1:${server.address().port}`;
            done();
        });
    });

    after((done) => {
        fs.rmSync(dir, { recursive: true, force: true });
        server.close(done);
    });

    const get = (url, headers = {}) => fetch(baseUrl + url, { headers: { cookie, ...headers } });

    describe('the files of a clip', () => {
        it('are served to somebody with the session, with the right type and no sniffing', async () => {
            const res = await get(`/replay/media/${ID}/clip.webm`);
            res.status.should.equal(200);
            res.headers.get('content-type').should.equal('video/webm');
            res.headers.get('x-content-type-options').should.equal('nosniff');
            res.headers.get('cache-control').should.equal('private, max-age=3600');
            Buffer.from(await res.arrayBuffer()).equals(WEBM).should.be.true();
            (await get(`/replay/media/${ID}/thumb.jpg`)).headers.get('content-type').should.equal('image/jpeg');
        });

        it('need the session: without the cookie, or with a wrong one, it is 401 and nothing is read', async () => {
            (await fetch(`${baseUrl}/replay/media/${ID}/clip.webm`)).status.should.equal(401);
            (await fetch(`${baseUrl}/replay/media/${ID}/clip.webm`, { headers: { cookie: `${COOKIE_NAME}=forged` } })).status.should.equal(401);
        });

        it('can be played from the middle: a Range request gets 206 with exactly those bytes', async () => {
            const res = await get(`/replay/media/${ID}/clip.webm`, { range: 'bytes=100-199' });
            res.status.should.equal(206);
            res.headers.get('content-range').should.equal(`bytes 100-199/${WEBM.length}`);
            Buffer.from(await res.arrayBuffer()).equals(WEBM.subarray(100, 200)).should.be.true();
            res.headers.get('accept-ranges').should.equal('bytes');
        });

        it('answers a Range past the end with 416, not with garbage', async () => {
            (await get(`/replay/media/${ID}/clip.webm`, { range: 'bytes=99999-100000' })).status.should.equal(416);
        });

        it('offer a download with a readable ASCII name made of the sharer and the time', async () => {
            const res = await get(`/replay/media/${ID}/clip.webm?download=1`);
            res.headers.get('content-disposition').should.equal('attachment; filename="replay-Beltrano-acao-20261003-190600.webm"');
            await res.arrayBuffer();
        });

        it('only serve the four known names: not the metadata, not another file of the folder', async () => {
            (await get(`/replay/media/${ID}/meta.json`)).status.should.equal(404);
            (await get(`/replay/media/${ID}/secret.txt`)).status.should.equal(404);
            (await get(`/replay/media/${ID}/clip.mkv`)).status.should.equal(404); // known name, but not there
            (await get(`/replay/media/${ID}/__proto__`)).status.should.equal(404);
            (await get(`/replay/media/${ID}/constructor`)).status.should.equal(404);
        });

        it('cannot leave the clips folder with a clip id or a file name that climbs', async () => {
            for (const url of [
                '/replay/media/..%2f..%2fetc/clip.webm',
                '/replay/media/..%2foutside.webm/clip.webm',
                `/replay/media/${ID}/..%2foutside.webm`,
                `/replay/media/${ID}%2f..%2f../clip.webm`,
                '/replay/media/%2e%2e/clip.webm',
                '/replay/media/AAAA/clip.webm', // too short for an id
                `/replay/media/${ID.toUpperCase()}/clip.webm`, // ids are lower case
            ]) {
                const res = await get(url);
                [400, 404].should.containEql(res.status, url);
                await res.arrayBuffer();
            }
        });

        it('a clip that is not on the disk is a plain 404', async () => {
            (await get('/replay/media/20261003-000000-deadbeef-0000/clip.webm')).status.should.equal(404);
        });
    });

    describe('the clip id', () => {
        it('is what the recorder makes: lower case letters, digits and dashes, 8 to 64 long', () => {
            CLIP_ID.test(ID).should.be.true();
            for (const bad of ['', 'short', 'UPPERCASE-ID-123', 'has space in it', '../../etc/passwd', 'a'.repeat(65), 'ok-id-1234;rm', `${ID}\n`]) {
                CLIP_ID.test(bad).should.be.false();
            }
        });

        it('is checked before the recorder is asked anything', async () => {
            (await get('/replay/api/clips/NOT_AN_ID')).status.should.equal(404);
            (await fetch(`${baseUrl}/replay/api/clips/NOT_AN_ID/mp4`, { method: 'POST', headers: { cookie } })).status.should.equal(404);
            (await fetch(`${baseUrl}/replay/api/clips/NOT_AN_ID`, { method: 'DELETE', headers: { cookie } })).status.should.equal(404);
            startedMp4.should.deepEqual([]);
        });
    });

    describe('the MP4 and the live stream', () => {
        it('start the conversion for somebody with the session, and say how it goes', async () => {
            const res = await fetch(`${baseUrl}/replay/api/clips/${ID}/mp4`, { method: 'POST', headers: { cookie } });
            res.status.should.equal(200);
            (await res.json()).should.deepEqual({ state: 'running', progress: 0.5, etaSeconds: 7 });
            startedMp4.should.deepEqual([ID]);
        });

        it('do not start for somebody without it', async () => {
            startedMp4 = [];
            (await fetch(`${baseUrl}/replay/api/clips/${ID}/mp4`, { method: 'POST' })).status.should.equal(401);
            (await fetch(`${baseUrl}/replay/api/stream`)).status.should.equal(401);
            startedMp4.should.deepEqual([]);
        });

        it('the stream of events is for people with the session', async () => {
            const before = sse;
            await (await get('/replay/api/stream')).text();
            sse.should.equal(before + 1);
        });
    });

    describe('the door of the recorder\'s events', () => {
        const post = (headers, body = { type: 'buffers', shares: [] }) =>
            fetch(`${baseUrl}/internal/replay/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

        it('opens for the recorder: the secret, straight over the private network', async () => {
            const before = recorderEvents.length;
            (await post({ 'x-replay-secret': SECRET })).status.should.equal(200); // 127.0.0.1 is the private network here
            recorderEvents.should.have.length(before + 1);
        });

        it('is closed without the secret or with a wrong one', async () => {
            const before = recorderEvents.length;
            (await post({})).status.should.equal(401);
            (await post({ 'x-replay-secret': 'nope' })).status.should.equal(401);
            (await post({ 'x-replay-secret': SECRET + 'x' })).status.should.equal(401);
            recorderEvents.should.have.length(before);
        });

        it('is closed to a request that came through a proxy, even with the secret', async () => {
            const before = recorderEvents.length;
            (await post({ 'x-replay-secret': SECRET, 'x-forwarded-for': '203.0.113.9' })).status.should.equal(401);
            (await post({ 'x-replay-secret': SECRET, 'x-real-ip': '203.0.113.9' })).status.should.equal(401);
            (await post({ 'x-replay-secret': SECRET, forwarded: 'for=203.0.113.9' })).status.should.equal(401);
            recorderEvents.should.have.length(before);
        });
    });

    describe('isInternalRequest', () => {
        const from = (address, headers = {}) => ({ headers, socket: { remoteAddress: address } });

        it('accepts the private networks and the loopback, with or without the IPv4-in-IPv6 form', () => {
            for (const address of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.5', '172.16.0.1', '172.20.0.2', '172.31.255.254', '::ffff:172.20.0.2']) {
                isInternalRequest(from(address)).should.be.true(address);
            }
        });

        it('refuses public addresses and the ranges next to the private ones', () => {
            for (const address of ['8.8.8.8', '203.0.113.9', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '', undefined]) {
                isInternalRequest(from(address)).should.be.false(String(address));
            }
        });

        it('refuses anything that says it was forwarded', () => {
            for (const headers of [{ 'x-forwarded-for': '1.2.3.4' }, { 'x-real-ip': '1.2.3.4' }, { forwarded: 'for=1.2.3.4' }]) {
                isInternalRequest(from('172.20.0.2', headers)).should.be.false();
            }
        });
    });

    describe('secretMatches', () => {
        it('is exact, and false for anything empty or of another length', () => {
            secretMatches('abc', 'abc').should.be.true();
            secretMatches('abc', 'abd').should.be.false();
            secretMatches('abc', 'abcd').should.be.false();
            secretMatches('', '').should.be.false();
            secretMatches(undefined, 'abc').should.be.false();
            secretMatches('abc', undefined).should.be.false();
        });
    });

    describe('safeName', () => {
        it('makes a name that is safe in a header: ASCII, no quotes, no path, no control characters', () => {
            safeName('Béltrano ação').should.equal('Beltrano-acao');
            safeName('a"b\r\nSet-Cookie: x=1').should.equal('a-b-Set-Cookie-x-1');
            safeName('../../etc/passwd').should.equal('etc-passwd');
            safeName('').should.equal('replay');
            safeName(undefined).should.equal('replay');
            safeName('日本語').should.equal('replay');
            safeName('x'.repeat(100)).should.have.length(40);
        });
    });
});
