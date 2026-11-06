'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RoomPlayControl } = require('../app/src/RoomPlayControl');
const catalog = require('../app/src/captcha-games.json');

function fixture(count = 10, options = {}) {
    let clock = 100000;
    const peers = new Map(),
        sockets = new Map(),
        handlers = new Map(),
        emitted = [];
    const room = { peers, getPeers: () => peers, getPeer: (id) => peers.get(id) };
    const rooms = new Map([['friends', room]]);
    const control = new RoomPlayControl({
        enabled: true,
        rooms,
        sockets,
        catalog,
        now: () => clock,
        draw: () => 0,
        ...options,
    });
    function add(id, uuid = id) {
        peers.set(id, { id, peer_name: id, peer_uuid: uuid });
        const events = new Map();
        const socket = {
            id,
            on: (e, fn) => events.set(e, [...(events.get(e) || []), fn]),
            emit: (event, data) => emitted.push({ id, event, data }),
        };
        sockets.set(id, socket);
        control.bind(socket, () => room);
        handlers.set(id, (event, data = {}) => {
            let reply;
            for (const fn of events.get(event) || []) fn(data, (r) => (reply = r));
            return reply;
        });
        handlers.get(id)('playHello');
    }
    for (let i = 0; i < count; i++) add(String(i));
    const call = (id, event, data = {}) =>
        handlers.get(id)(event, { requestId: require('node:crypto').randomUUID(), ...data });
    const finish = (id, a, { score = 12, progress = 0.5, reason = 'impact', elapsed = 3 } = {}) => {
        const { attempt } = control.startAttempt(id, a.id);
        clock += elapsed * 1000;
        return control.finishAttempt(id, {
            assignmentId: a.id,
            attemptId: attempt.id,
            reason,
            elapsed,
            metrics: { score, progress },
        });
    };
    return { control, peers, rooms, sockets, emitted, add, call, finish, advance: (ms) => (clock += ms) };
}

describe('Room game hub coordination', () => {
    it('waits behind a manual match, including pauses, without replacing its attempt', () => {
        const f = fixture(),
            a = f.control.manual('0', 'slash'),
            { attempt } = f.control.startAttempt('0', a.id);
        f.control.pause('0', a.id, true);
        const p = f.control.trigger({ roomId: 'friends', peerId: '0', gameId: 'rain' });
        assert.equal(p.phase, 'waiting');
        assert.equal(f.control.active.get('0').id, a.id);
        assert.equal(f.control.active.get('0').currentAttempt, attempt.id);
        assert.throws(() => f.control.activate('0'), /aguarda/);
        assert.throws(() => f.control.trigger({ roomId: 'friends', peerId: '0' }), /já está/);
        f.advance(3000);
        f.control.finishAttempt('0', {
            assignmentId: a.id,
            attemptId: attempt.id,
            reason: 'impact',
            elapsed: 3,
            metrics: { score: 8 },
        });
        assert.equal(f.control.pending.get('0').phase, 'assigned');
        assert.equal(f.control.active.get('0').id, a.id, 'result remains on screen');
        assert.equal(f.control.ranking('0', 'slash').mine.value, 8);
        assert.equal(f.control.activate('0').id, p.id);
        assert.equal(f.control.active.get('0').phase, 'assigned', 'verification starts only on click');
    });
    it('closing cancels the manual match and waiting verification, without a false defeat or score', () => {
        const f = fixture(),
            a = f.control.manual('0', 'rain');
        f.control.startAttempt('0', a.id);
        f.control.trigger({ roomId: 'friends', peerId: '0' });
        const result = f.call('0', 'playClose');
        assert.equal(result.state.active, null);
        assert.equal(result.state.pending, null);
        assert.equal([...f.control.attempts.values()][0].outcome, 'abandoned');
        assert.equal(f.control.ranking('0', 'rain').total, 0);
        assert.throws(() => f.control.trigger({ roomId: 'friends', peerId: '0' }), /intervalo/);
        f.advance(180001);
        assert.ok(f.control.trigger({ roomId: 'friends', peerId: '0' }));
    });
    it('does not restart an assignment after an acknowledged command is retried following X', () => {
        const f = fixture();
        const first = f.call('0', 'playManualStart', { gameId: 'rain', requestId: 'one' });
        f.call('0', 'playClose');
        const replay = f.call('0', 'playManualStart', { gameId: 'rain', requestId: 'one' });
        assert.equal(replay.assignment.id, first.assignment.id);
        assert.equal(replay.state.active, null, 'fresh authoritative state defeats stale assignment payload');
        assert.equal(f.control.active.size, 0);
    });
    it('requires more than 30% and snapshots identities, including target and author, once', () => {
        const f = fixture(10),
            v = f.control.openVote({ roomId: 'friends', peerId: '0', authorPeerId: '1' });
        assert.equal(v.threshold, 4);
        f.add('copy', '2');
        f.add('late', 'late');
        f.peers.delete('8');
        f.control.castVote('2', { voteId: v.id, choice: 'yes' });
        f.control.castVote('copy', { voteId: v.id, choice: 'yes' });
        assert.equal(f.control.publicVote(f.control.votes.get(v.id)).yes, 2);
        assert.throws(() => f.control.castVote('late', { voteId: v.id, choice: 'yes' }), /não participa/);
        f.control.castVote('3', { voteId: v.id, choice: 'yes' });
        assert.equal(f.control.active.size, 0, '30% does not approve');
        f.control.castVote('0', { voteId: v.id, choice: 'yes' });
        assert.equal(f.control.active.size, 1);
        assert.equal(f.control.votes.get(v.id).threshold, 4);
    });
    it('serializes distinct proposals, merges the same target and revalidates the queue', () => {
        const f = fixture(20),
            v = f.control.openVote({ roomId: 'friends', peerId: '0', authorPeerId: '1' });
        assert.equal(f.control.openVote({ roomId: 'friends', peerId: '0', authorPeerId: '2' }).id, v.id);
        const queued = f.control.openVote({ roomId: 'friends', peerId: '3', authorPeerId: '4' });
        assert.equal(queued.status, 'queued');
        assert.equal(queued.yes, 0);
        assert.throws(
            () => f.control.openVote({ roomId: 'friends', peerId: '5', authorPeerId: '4' }),
            /Aguarde|já tem/
        );
        f.control.cancelVote(v.id);
        f.control.tick();
        assert.equal(f.control.votes.get(queued.id).status, 'queued');
        f.advance(5001);
        f.control.tick();
        assert.equal(f.control.votes.get(queued.id).status, 'open');
        assert.equal(f.control.publicVote(f.control.votes.get(queued.id)).yes, 1);
        const third = f.control.openVote({ roomId: 'friends', peerId: '6', authorPeerId: '7' });
        f.peers.delete('7');
        f.control.cancelVote(queued.id);
        f.advance(5001);
        f.control.tick();
        assert.equal(f.control.votes.get(third.id).status, 'unavailable');
        const announcements = f.emitted.filter((e) => e.id === '0' && e.event === 'captchaVote' && e.data.announce);
        assert.equal(announcements.length, 2, 'only ballot openings announce');
    });
    it('limits the queue, expires pending games, and automation skips occupied players', () => {
        const f = fixture(12);
        f.control.openVote({ roomId: 'friends', peerId: '0', authorPeerId: '1' });
        for (const [target, author] of [
            ['2', '3'],
            ['4', '5'],
            ['6', '7'],
        ])
            f.control.openVote({ roomId: 'friends', peerId: target, authorPeerId: author });
        assert.throws(
            () => f.control.openVote({ roomId: 'friends', peerId: '8', authorPeerId: '9' }),
            /fila está cheia/
        );
        const a = f.control.manual('10', 'rain');
        f.control.startAttempt('10', a.id);
        const sent = f.control.randomTargets('friends', 'all', 'rain', 'random');
        assert.ok(!sent.some((x) => x.id === a.id));
        assert.equal(f.control.pending.size, 0);
        f.control.trigger({ roomId: 'friends', peerId: '10' });
        f.advance(120001);
        f.control.tick();
        assert.equal(f.control.pending.size, 0);
        assert.equal(f.control.active.get('10').id, a.id);
    });
    it('keeps rankings from both entry points and preserves a natural result after closing', () => {
        const f = fixture(),
            a = f.control.manual('0', 'slash');
        f.finish('0', a, { score: 12 });
        const b = f.control.trigger({ roomId: 'friends', peerId: '1', gameId: 'slash' });
        f.finish('1', b, { score: 15 });
        f.control.profile('1', 'ABC');
        f.control.release('1', 'closed');
        assert.deepEqual(
            f.control.ranking('0', 'slash').rows.map((r) => [r.initials, r.value]),
            [
                ['ABC', 15],
                ['0', 12],
            ]
        );
        assert.equal(f.control.snapshot().stats.find((s) => s.gameId === 'slash').losses, 2);
        f.control.settings.games.slash.intensity = 1.5;
        assert.equal(f.control.ranking('0', 'slash').total, 0, 'different configurations have separate marks');
        assert.equal(f.control.attempts.size, 2, 'historical results remain');
    });
    it('persists scores and initials, rejects reporting for another user, and never calls media methods', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-play-'));
        try {
            const f = fixture(3, { dataDir: dir }),
                a = f.control.manual('0', 'rain');
            const result = f.finish('0', a, { elapsed: 3 });
            f.control.profile('0', 'XYZ');
            const other = f.control.manual('1', 'rain');
            assert.throws(
                () =>
                    f.control.finishAttempt('1', {
                        assignmentId: other.id,
                        attemptId: result.attempt.id,
                        reason: 'survived',
                        elapsed: 0,
                    }),
                /inválida/
            );
            await f.control.writes;
            const restored = fixture(3, { dataDir: dir });
            assert.equal(restored.control.ranking('0', 'rain').mine.label, '3 s');
            assert.equal(restored.control.profile('0').initials, 'XYZ');
            await restored.control.writes;
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    it('uses the same identity across tabs for active games and target cooldown', () => {
        const f = fixture();
        f.add('copy', '0');
        const a = f.control.manual('0', 'rain');
        assert.throws(() => f.control.manual('copy', 'rain'), /já está/);
        const p = f.control.trigger({ roomId: 'friends', peerId: 'copy', gameId: 'rain' });
        assert.equal(f.control.pending.get('0').id, p.id, 'the actual game owner receives the pending verification');
        f.control.release('0', 'closed');
        assert.throws(() => f.control.trigger({ roomId: 'friends', peerId: 'copy' }), /intervalo/);
        assert.equal(f.control.uniquePeers('friends').length, 10);
        assert.ok(a.id);
    });
    it('moves an identity to its new tab after a result, and counts retry across entry points', () => {
        const f = fixture();
        f.add('copy', '0');
        const a = f.control.manual('0', 'slash');
        f.finish('0', a);
        const b = f.control.manual('copy', 'slash');
        assert.equal(f.control.active.has('0'), false);
        const started = f.control.startAttempt('copy', b.id);
        assert.equal(started.attempt.number, 2);
        assert.ok(started.attempt.retryOf);
        f.control.trigger({ roomId: 'friends', peerId: '0', gameId: 'rain' });
        assert.ok(f.control.pending.has('copy'));
        assert.equal(f.control.pending.has('0'), false);
    });
    it('records a match even if its game was disabled while it was running', () => {
        const f = fixture(),
            a = f.control.manual('0', 'slash');
        f.control.startAttempt('0', a.id);
        f.control.settings.games.slash.enabled = false;
        const result = f.finish('0', a);
        assert.ok(result.attempt.score);
        assert.equal(result.ranking.total, 1);
    });
    it('grants a fresh play window after activating a nearly expired pending request', () => {
        const f = fixture(),
            a = f.control.manual('0', 'rain');
        f.control.trigger({ roomId: 'friends', peerId: '0' });
        f.finish('0', a);
        f.advance(116000);
        const active = f.control.activate('0');
        f.advance(4000);
        assert.ok(f.control.startAttempt('0', active.id).attempt);
    });
});
