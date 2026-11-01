'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { CaptchaControl } = require('../app/src/CaptchaControl');
const { captchaRoutes } = require('../app/src/CaptchaRoutes');
const catalog = require('../app/src/captcha-games.json');

function fixture(options = {}) {
    let clock = 100000;
    const peers = new Map(['a', 'b', 'c'].map((id) => [id, { id, peer_uuid: `uuid-${id}`, peer_name: id }]));
    const room = { peers, getPeers: () => peers, getPeer: (id) => peers.get(id) };
    const rooms = new Map([
        ['friends', room],
        ['other', { peers: new Map([['x', { id: 'x' }]]) }],
    ]);
    const emitted = [],
        sockets = new Map();
    const control = new CaptchaControl({
        enabled: true,
        rooms,
        sockets,
        catalog,
        now: () => clock,
        draw: () => 0,
        ...options,
    });
    const handlers = new Map();
    for (const id of ['a', 'b', 'c', 'x']) {
        const events = new Map();
        sockets.set(id, {
            id,
            emit: (event, data) => emitted.push({ id, event, data }),
            on: (event, fn) => events.set(event, fn),
        });
        control.bind(sockets.get(id), () => (id === 'x' ? rooms.get('other') : room));
        handlers.set(id, (event, data = {}) => {
            let result;
            events.get(event)(data, (r) => (result = r));
            return result;
        });
        handlers.get(id)('captchaHello');
    }
    const trigger = (peerId = 'a', gameId = 'rain') => control.trigger({ roomId: 'friends', peerId, gameId });
    const begin = () => {
        const a = trigger();
        const { attempt } = control.startAttempt('a', a.id);
        return { a, attempt };
    };
    return { control, peers, rooms, emitted, handlers, sockets, trigger, begin, advance: (ms) => (clock += ms) };
}
describe('Development CAPTCHA control', () => {
    it('starts with automation disabled and all fourteen game controls available', () => {
        const f = fixture();
        assert.equal(f.control.catalog.length, 14);
        assert.deepEqual(f.control.settings.rooms, {});
        f.advance(86400000);
        f.control.tick();
        assert.equal(f.control.active.size, 0);
    });
    it('sends only to the chosen peer and refuses overlap, unready users and other-room spoofing', () => {
        const f = fixture();
        f.emitted.length = 0;
        f.trigger();
        assert.deepEqual(
            f.emitted.map((e) => e.id),
            ['a']
        );
        assert.throws(() => f.trigger(), /já está/);
        assert.throws(() => f.trigger('x'), /indisponível/);
        f.control.capable.delete('b');
        assert.throws(() => f.trigger('b'), /indisponível/);
    });
    it('derives attempt ownership from the socket and never permits cross-user reporting', () => {
        const f = fixture(),
            a = f.trigger();
        const data = f.handlers.get('b')('captchaAttemptStart', { assignmentId: a.id, peerId: 'a', roomId: 'friends' });
        assert.equal(data.code, 'STALE');
        assert.equal(f.control.attempts.size, 0);
    });
    it('start/finish are idempotent; completion releases visuals and retry creates a separate attempt', () => {
        const f = fixture(),
            { a, attempt } = f.begin();
        assert.equal(f.control.startAttempt('a', a.id).attempt.id, attempt.id);
        f.advance(4000);
        const data = { assignmentId: a.id, attemptId: attempt.id, reason: 'impact', elapsed: 3 };
        f.control.finishAttempt('a', data);
        f.control.finishAttempt('a', data);
        assert.equal(f.control.snapshot().stats.find((g) => g.gameId === 'rain').losses, 1);
        assert.equal(f.emitted.at(-1).data.keepResult, true);
        const second = f.control.startAttempt('a', a.id).attempt;
        assert.equal(second.number, 2);
        assert.notEqual(second.id, attempt.id);
    });
    it('validates result timing and rating boundaries', () => {
        const f = fixture(),
            { a, attempt } = f.begin();
        assert.throws(
            () =>
                f.control.finishAttempt('a', {
                    assignmentId: a.id,
                    attemptId: attempt.id,
                    elapsed: 24,
                    reason: 'survived',
                }),
            /Tempo de jogo/
        );
        assert.throws(() => f.control.rate('a', { assignmentId: a.id, attemptId: attempt.id, value: 5 }), /Jogue/);
        f.advance(30000);
        f.control.finishAttempt('a', { assignmentId: a.id, attemptId: attempt.id, elapsed: 25, reason: 'survived' });
        for (const value of [0, 6, 2.5, NaN])
            assert.throws(() => f.control.rate('a', { assignmentId: a.id, attemptId: attempt.id, value }));
    });
    it('keeps a single latest rating per person/game and computes wins, losses, retries and means', () => {
        const f = fixture();
        for (const [id, value, reason] of [
            ['a', 3, 'impact'],
            ['b', 5, 'survived'],
        ]) {
            const a = f.trigger(id),
                { attempt } = f.control.startAttempt(id, a.id);
            f.advance(26000);
            f.control.finishAttempt(id, { assignmentId: a.id, attemptId: attempt.id, elapsed: 20, reason });
            f.control.rate(id, { assignmentId: a.id, attemptId: attempt.id, value });
            if (id === 'a') f.control.rate(id, { assignmentId: a.id, attemptId: attempt.id, value: 1 });
        }
        const stat = f.control.snapshot().stats.find((g) => g.gameId === 'rain');
        assert.equal(stat.ratings, 2);
        assert.equal(stat.averageRating, 3);
        assert.equal(stat.winRate, 0.5);
        assert.equal(stat.averageSeconds, 20);
    });
    it('release, expiry and disconnect abandon unfinished attempts without touching membership', () => {
        for (const mode of ['release', 'expired', 'disconnect']) {
            const f = fixture(),
                { attempt } = f.begin();
            if (mode === 'release') f.control.release('a');
            if (mode === 'expired') {
                f.advance(300001);
                f.control.tick();
            }
            if (mode === 'disconnect') f.handlers.get('a')('disconnect');
            assert.equal(f.control.attempts.get(attempt.id).outcome, 'abandoned');
            assert.equal(f.control.active.size, 0);
            assert.equal(f.peers.size, 3);
        }
    });
    it('votes snapshot all present members, reject outsiders, ignore duplicate/change votes and trigger once', () => {
        const f = fixture();
        f.control.capable.delete('c');
        const vote = f.control.openVote({ roomId: 'friends', peerId: 'a', mode: 'percent', required: 60 });
        assert.equal(vote.eligibleCount, 3);
        assert.equal(vote.threshold, 2);
        assert.throws(() => f.control.castVote('x', { voteId: vote.id, choice: 'yes' }), /não participa/);
        f.peers.set('late', { id: 'late' });
        assert.throws(() => f.control.castVote('late', { voteId: vote.id, choice: 'yes' }), /não participa/);
        f.control.castVote('b', { voteId: vote.id, choice: 'yes' });
        assert.equal(f.control.castVote('b', { voteId: vote.id, choice: 'no' }).yes, 1);
        f.control.castVote('c', { voteId: vote.id, choice: 'yes' });
        assert.equal(f.control.active.size, 1);
        assert.throws(() => f.control.castVote('a', { voteId: vote.id, choice: 'yes' }), /encerrada/);
        assert.equal([...f.control.active.values()][0].source, 'vote');
    });
    it('does not lower quorum on departure; closes unreachable, expired or target-left votes', () => {
        for (const kind of ['unreachable', 'expired', 'target_left']) {
            const f = fixture(),
                v = f.control.openVote({ roomId: 'friends', peerId: 'a', mode: 'count', required: 3, seconds: 10 });
            if (kind === 'unreachable') f.peers.delete('b');
            if (kind === 'expired') f.advance(10001);
            if (kind === 'target_left') f.peers.delete('a');
            f.control.tick();
            assert.equal(f.control.votes.get(v.id).status, kind);
            assert.equal(f.control.votes.get(v.id).threshold, 3);
            assert.equal(f.control.active.size, 0);
        }
    });
    it('accepts the panel 30–35 percent rule using the total room membership', () => {
        for (const percent of [30, 35]) {
            const f = fixture();
            for (let i = 3; i < 10; i++) f.peers.set(`peer-${i}`, { id: `peer-${i}`, peer_name: `Peer ${i}` });
            const vote = f.control.openVote({ roomId: 'friends', peerId: 'a', mode: 'percent', required: percent });
            assert.equal(vote.eligibleCount, 10);
            assert.equal(vote.threshold, percent === 30 ? 3 : 4);
            const voters = ['a', 'b', 'c', 'peer-3'];
            for (let i = 0; i < vote.threshold - 1; i++)
                f.control.castVote(voters[i], { voteId: vote.id, choice: 'yes' });
            assert.equal(f.control.active.size, 0);
            f.control.castVote(voters[vote.threshold - 1], { voteId: vote.id, choice: 'yes' });
            assert.equal(f.control.active.size, 1);
            assert.equal(f.control.active.get('a').phase, 'assigned');
        }
    });
    it('applies configuration to the next attempt and rejects disabled games/invalid ranges', async () => {
        const f = fixture(),
            { a } = f.begin();
        f.control.release('a');
        const settings = structuredClone(f.control.settings);
        settings.games.rain.duration = 8;
        settings.games.rain.intensity = 1.5;
        await f.control.configure(settings);
        const next = f.trigger();
        assert.equal(next.config.duration, 8);
        assert.equal(next.config.intensity, 1.5);
        settings.games.rain.duration = 41;
        await assert.rejects(f.control.configure(settings));
        settings.games.rain.duration = 8;
        settings.games.rain.enabled = false;
        await f.control.configure(settings);
        f.control.release('a');
        assert.throws(() => f.trigger(), /desativado/);
        assert.throws(() => f.control.startAttempt('a', a.id), /encerrado/);
    });
    it('random scheduler waits its interval, skips busy/cooldown peers, supports everyone and stays room-isolated', async () => {
        const f = fixture(),
            settings = structuredClone(f.control.settings);
        settings.rooms.friends = {
            enabled: true,
            mode: 'one',
            intervalSeconds: 30,
            cooldownSeconds: 120,
            jitterPercent: 0,
        };
        await f.control.configure(settings);
        f.control.tick();
        f.advance(29999);
        f.control.tick();
        assert.equal(f.control.active.size, 0);
        f.advance(1);
        f.control.tick();
        assert.equal(f.control.active.size, 1);
        f.control.release('a');
        f.advance(30000);
        f.control.tick();
        assert.equal(f.control.active.has('b'), true);
        assert.equal(f.control.active.has('x'), false);
        f.control.release('b');
        settings.rooms.friends.mode = 'all';
        await f.control.configure(settings);
        f.control.tick();
        f.advance(30000);
        f.control.tick();
        assert.deepEqual([...f.control.active.keys()], ['c']);
    });
    it('serializes configuration writes; restores ratings/history and abandons stale attempts after restart', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captcha-control-'));
        try {
            const f = fixture({ dataDir: dir }),
                { a, attempt } = f.begin();
            f.advance(9000);
            f.control.finishAttempt('a', { assignmentId: a.id, attemptId: attempt.id, elapsed: 8, reason: 'impact' });
            f.control.rate('a', { assignmentId: a.id, attemptId: attempt.id, value: 4 });
            f.control.startAttempt('a', a.id);
            const settings = structuredClone(f.control.settings);
            settings.games.rain.duration = 12;
            await Promise.all([f.control.configure(settings), f.control.configure(settings)]);
            await f.control.writes;
            fs.appendFileSync(path.join(dir, 'events.jsonl'), '{torn');
            const restored = fixture({ dataDir: dir }).control;
            assert.equal(restored.settings.games.rain.duration, 12);
            assert.equal(restored.ratings.size, 1);
            assert.equal([...restored.attempts.values()].filter((a) => a.outcome === 'abandoned').length, 1);
            assert.equal(restored.active.size, 0);
            await restored.writes;
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    it('disables cleanly if storage is unavailable, and disabled mode exposes no control events', () => {
        const disabled = fixture({ enabled: false });
        assert.equal(disabled.handlers.get('a')('captchaHello').enabled, false);
        assert.throws(() => disabled.trigger(), /indisponível/);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captcha-storage-')),
            file = path.join(dir, 'file');
        fs.writeFileSync(file, 'x');
        try {
            assert.equal(fixture({ dataDir: path.join(file, 'child') }).control.enabled, false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('CAPTCHA private HTTP panel', () => {
    let server, url, f;
    beforeEach(async () => {
        f = fixture();
        const app = express();
        app.use(express.json());
        app.use(
            ['/captcha', '/dev/captcha'],
            captchaRoutes({
                control: f.control,
                adminDir: path.resolve('app/captcha-admin'),
                playerDir: path.resolve('app/captcha-player'),
                adminKey: 'a-private-key-at-least-24-characters',
            })
        );
        server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        url = `http://127.0.0.1:${server.address().port}/dev/captcha`;
    });
    afterEach(() => new Promise((r) => server.close(r)));
    const post = (route, body, token) =>
        fetch(url + route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(body),
        });
    const login = async () =>
        (await (await post('/login', { key: 'a-private-key-at-least-24-characters' })).json()).token;
    it('requires a private token; rejects wrong keys, expires sessions and logs out', async () => {
        assert.equal((await fetch(url + '/api/state')).status, 401);
        assert.equal((await post('/login', { key: 'wrong' })).status, 401);
        const token = await login();
        assert.equal((await fetch(url + '/api/state', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
        await post('/api/logout', {}, token);
        assert.equal((await post('/api/trigger', { roomId: 'friends', peerId: 'a' }, token)).status, 401);
        const second = await login();
        f.advance(7200001);
        assert.equal((await post('/api/trigger', {}, second)).status, 401);
    });
    it('can trigger and emergency-release without removing users from their room', async () => {
        const token = await login();
        assert.equal((await post('/api/trigger', { roomId: 'friends', peerId: 'a' }, token)).status, 200);
        assert.equal(f.control.active.size, 1);
        assert.equal((await post('/api/pause-room', { roomId: 'friends' }, token)).status, 200);
        assert.equal(f.control.active.size, 0);
        assert.equal(f.peers.size, 3);
    });
    it('limits password guessing and protects player framing to the same origin', async () => {
        for (let i = 0; i < 8; i++) await post('/login', { key: 'bad' });
        assert.equal((await post('/login', { key: 'bad' })).status, 429);
        const player = await fetch(url + '/play/room.html');
        assert.equal(player.headers.get('x-frame-options'), 'SAMEORIGIN');
    });
    it('requires explicit CAPTCHA opt-in without enabling development room access', () => {
        const source = fs.readFileSync(path.resolve('app/src/Server.js'), 'utf8');
        assert.match(source, /enabled: process.env.CAPTCHA_ENABLED === 'true'/);
        assert.doesNotMatch(source, /process.env.APP_ENV\s*=(?!=)/);
        const app = express(),
            control = new CaptchaControl();
        app.use(captchaRoutes({ control }));
        assert.equal(control.enabled, false);
    });
    it('serves the production panel route with the same private session boundary', async () => {
        const productionUrl = url.replace('/dev/captcha', '/captcha');
        assert.equal((await fetch(productionUrl + '/api/state')).status, 401);
        const token = await login();
        const response = await fetch(productionUrl + '/api/state', { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(response.status, 200);
        const html = await (await fetch(productionUrl + '/')).text();
        assert.match(html, /src="\/captcha\/ui\/admin.js"/);
    });
});
