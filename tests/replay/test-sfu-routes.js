'use strict';

require('should');

const http = require('node:http');
const express = require('express');
const { createReplayRouter } = require('../../app/src/replay/ReplayRoutes');
const { ReplayAccess, COOKIE_NAME } = require('../../app/src/replay/ReplayAccess');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function setupServer() {
    const access = new ReplayAccess({
        secret: 'test-secret-12345678901234567890',
        roomPassword: 'correct-password',
    });

    const client = {
        clips: [
            {
                id: 'clip-12345678',
                requestedByHash: access.hashPeer('user-1'),
                sharerHash: access.hashPeer('user-2'),
                files: { original: { name: 'clip.webm' }, mp4: null },
            },
        ],
        async listClips() {
            return { clips: this.clips };
        },
        async deleteClip(id) {
            this.clips = this.clips.filter((c) => c.id !== id);
            return { ok: true };
        },
        async getClip(id) {
            return this.clips.find((c) => c.id === id);
        },
    };

    const singleRoom = {
        enabled: true,
        roomId: 'room-1',
        matches: (pwd) => pwd === 'correct-password',
    };

    const hub = {
        handleRecorderEvent: () => {},
        sseStream: (req, res) => res.end(),
    };

    const router = createReplayRouter({
        hub,
        access,
        client,
        singleRoom,
        pageFile: __filename,
        dataDir: __dirname,
        log: silent,
    });

    const app = express();
    app.use(express.json());
    app.use('/replay', router);

    const server = http.createServer(app);
    return { server, access, client };
}

describe('test-sfu-routes (Replay HTTP endpoints and permissions)', () => {
    let server;
    let access;
    let client;
    let baseUrl;

    before((done) => {
        const s = setupServer();
        server = s.server;
        access = s.access;
        client = s.client;
        server.listen(0, '127.0.0.1', () => {
            baseUrl = `http://127.0.0.1:${server.address().port}/replay`;
            done();
        });
    });

    after((done) => {
        server.close(done);
    });

    it('rejects /api/me without a cookie', async () => {
        const res = await fetch(`${baseUrl}/api/me`);
        res.status.should.equal(401);
    });

    it('creates a session with a valid ticket', async () => {
        const { ticket } = access.issueTicket();
        const res = await fetch(`${baseUrl}/api/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket }),
        });
        res.status.should.equal(200);
        const cookie = res.headers.get('set-cookie');
        (!!cookie).should.be.true();
        cookie.should.containEql(COOKIE_NAME);

        // Access /api/me with that cookie
        const meRes = await fetch(`${baseUrl}/api/me`, {
            headers: { Cookie: cookie.split(';')[0] },
        });
        meRes.status.should.equal(200);
    });

    it('authenticates with the room password via /api/login', async () => {
        const badRes = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'wrong' }),
        });
        badRes.status.should.equal(401);

        const goodRes = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'correct-password' }),
        });
        goodRes.status.should.equal(200);
        const cookie = goodRes.headers.get('set-cookie');
        (!!cookie).should.be.true();
    });

    it('lists clips and marks ownership for requester or sharer', async () => {
        const token = access.signAccess();
        const res = await fetch(`${baseUrl}/api/clips`, {
            headers: {
                Cookie: `${COOKIE_NAME}=${token}`,
                'x-replay-peer': 'user-1',
            },
        });
        res.status.should.equal(200);
        const data = await res.json();
        data.clips.length.should.equal(1);
        data.clips[0].mine.should.be.true();
        (data.clips[0].requestedByHash === undefined).should.be.true(); // stripped
    });

    it('only lets the owner or sharer delete a clip', async () => {
        const token = access.signAccess();

        // Stranger tries to delete
        const strangerRes = await fetch(`${baseUrl}/api/clips/clip-12345678`, {
            method: 'DELETE',
            headers: {
                Cookie: `${COOKIE_NAME}=${token}`,
                'x-replay-peer': 'stranger-user',
            },
        });
        strangerRes.status.should.equal(403);

        // Owner deletes
        const ownerRes = await fetch(`${baseUrl}/api/clips/clip-12345678`, {
            method: 'DELETE',
            headers: {
                Cookie: `${COOKIE_NAME}=${token}`,
                'x-replay-peer': 'user-1',
            },
        });
        ownerRes.status.should.equal(200);
        client.clips.length.should.equal(0);
    });
});
