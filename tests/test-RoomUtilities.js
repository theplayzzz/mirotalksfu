'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { RoomUtilities, HISTORY_LIMIT, COOLDOWN_MS, ROLL_DURATION_MS } = require('../app/src/RoomUtilities');

function fixture() {
    let clock = 10000;
    const service = new RoomUtilities({ now: () => clock, draw: (min, max) => max - 1 });
    const events = [];
    const peers = new Map([
        ['alice', { peer_name: 'Alice' }],
        ['bob', { peer_name: 'Bob' }],
    ]);
    const room = {
        sessionId: 'room-session',
        getPeers: () => peers,
        getPeer: (id) => peers.get(id),
        send: (id, event, data) => events.push({ id, event, data }),
    };
    function socket(id, provider = () => room) {
        const handlers = new Map();
        service.bind({ id, on: (event, fn) => handlers.set(event, fn) }, provider);
        return (event, data = {}) => {
            let answer;
            handlers.get(event)(data, (value) => {
                answer = value;
            });
            return answer;
        };
    }
    return {
        service,
        events,
        peers,
        room,
        socket,
        advance: (ms = COOLDOWN_MS) => {
            clock += ms;
        },
    };
}

describe('RoomUtilities', () => {
    it('chooses the result and identity on the server, then broadcasts exactly the acknowledged roll', () => {
        const f = fixture();
        const alice = f.socket('alice');
        const reply = alice('utilityRoll', {
            kind: 'd20',
            requestId: 'r1',
            value: 1,
            peerName: 'Bob',
            peerId: 'bob',
            room: 'other',
        });
        assert.equal(reply.roll.value, 20);
        assert.equal(reply.roll.peerName, 'Alice');
        assert.equal(reply.roll.peerId, 'alice');
        assert.equal(f.events.length, 2);
        assert.equal(f.events[0].event, 'utilityRolled');
        assert.deepEqual(f.events[0].data, reply);
        assert.deepEqual(
            f.events.map((event) => event.id),
            ['alice', 'bob']
        );
        assert.deepEqual(f.socket('bob')('utilityHistory').rolls, [reply.roll]);
    });

    it('supports precisely d6, d10, d20 and the two coin outcomes', () => {
        const f = fixture();
        const alice = f.socket('alice');
        for (const [kind, value] of [
            ['d6', 6],
            ['d10', 10],
            ['d20', 20],
            ['coin', 2],
        ]) {
            assert.equal(alice('utilityRoll', { kind, requestId: kind }).roll.value, value);
            f.advance();
        }
        assert.equal(alice('utilityRoll', { kind: 'd100', requestId: 'x' }).code, 'INVALID_ROLL');
        assert.equal(alice('utilityRoll', null).code, 'INVALID_ROLL');
        assert.equal(alice('utilityRoll', { kind: 'constructor', requestId: 'y' }).code, 'INVALID_ROLL');
    });

    it('rejects outsiders, closed peers and people waiting in the lobby without exposing history', () => {
        const f = fixture();
        for (const id of ['outside', 'lobby', 'closed']) {
            if (id === 'lobby') f.peers.set(id, { peer_name: 'Lobby', peer_lobby: true });
            if (id === 'closed') f.peers.set(id, { peer_name: 'Closed', closed: true });
            const caller = f.socket(id);
            assert.equal(caller('utilityHistory').code, 'NOT_JOINED');
            assert.equal(caller('utilityRoll', { kind: 'd6', requestId: 'r' }).code, 'NOT_JOINED');
        }
        assert.equal(f.socket('alice', () => null)('utilityHistory').code, 'NOT_JOINED');
        assert.equal(f.events.length, 0);
    });

    it('sends live rolls only to admitted, open peers using the actual Room membership API', () => {
        const Room = require('../app/src/Room');
        const seen = [];
        const room = Object.create(Room.prototype);
        room.sessionId = 'membership-room';
        room.peers = new Map([
            ['alice', { peer_name: 'Alice' }],
            ['bob', { peer_name: 'Bob' }],
            ['lobby', { peer_name: 'Lobby', peer_lobby: true }],
            ['closed', { peer_name: 'Closed', closed: true }],
        ]);
        room.io = { to: (id) => ({ emit: (event, data) => seen.push({ id, event, data }) }) };
        const f = fixture(),
            caller = f.socket('alice', () => room);
        const reply = caller('utilityRoll', { kind: 'd6', requestId: 'live-membership' });
        assert.ok(reply.roll);
        assert.deepEqual(
            seen.map((message) => message.id),
            ['alice', 'bob']
        );
        for (const message of seen) {
            assert.deepEqual(message.data.roll, reply.roll);
            assert.equal(message.data.selfBusyUntil, message.id === 'alice' ? reply.roll.revealAt : 0);
            assert.equal(Object.hasOwn(message.data, 'selfRollId'), message.id === 'alice');
        }
        const history = f.socket('bob', () => room)('utilityHistory');
        assert.deepEqual(history.rolls, [reply.roll]);
        assert.equal(f.socket('lobby', () => room)('utilityHistory').code, 'NOT_JOINED');
        room.peers.get('lobby').peer_lobby = false;
        assert.deepEqual(f.socket('lobby', () => room)('utilityHistory').rolls, [reply.roll]);
    });

    it('deduplicates a repeated request and rate-limits separate rolls per participant', () => {
        const f = fixture();
        const alice = f.socket('alice');
        const first = alice('utilityRoll', { kind: 'd6', requestId: 'same' });
        assert.deepEqual(alice('utilityRoll', { kind: 'd6', requestId: 'same' }), first);
        assert.equal(f.events.length, 2);
        assert.equal(alice('utilityRoll', { kind: 'd6', requestId: 'next' }).code, 'COOLDOWN');
        assert.ok(f.socket('bob')('utilityRoll', { kind: 'd6', requestId: 'bob' }).roll);
        f.advance();
        assert.ok(alice('utilityRoll', { kind: 'd6', requestId: 'next' }).roll);
    });

    it('keeps the last 50 results, shares them on reconnect, and isolates separate room instances', () => {
        const f = fixture();
        const alice = f.socket('alice');
        for (let i = 0; i < HISTORY_LIMIT + 3; i++) {
            alice('utilityRoll', { kind: 'd10', requestId: `r${i}` });
            f.advance();
        }
        const history = f.socket('alice')('utilityHistory');
        assert.equal(history.rolls.length, HISTORY_LIMIT);
        assert.equal(history.rolls[0].sequence, 4);
        assert.equal(history.rolls.at(-1).sequence, 53);
        const other = { sessionId: 'another-session', getPeer: () => ({ peer_name: 'Alice' }), sendToAll: () => {} };
        const empty = f.socket('alice', () => other)('utilityHistory');
        assert.equal(empty.session, 'another-session');
        assert.deepEqual(empty.rolls, []);
        assert.ok(Number.isFinite(empty.now));
    });

    it('keeps cooldown and request deduplication across tabs without exposing the stable identity', () => {
        const f = fixture();
        f.peers.get('alice').peer_uuid = 'same-user';
        f.peers.set('copy', { peer_uuid: 'same-user', peer_name: 'Alice' });
        const a = f.socket('alice'),
            b = f.socket('copy');
        const first = a('utilityRoll', { kind: 'd20', requestId: 'one' });
        assert.equal(first.roll.revealAt - first.roll.at, ROLL_DURATION_MS);
        assert.equal(b('utilityRoll', { kind: 'd20', requestId: 'one' }).roll.id, first.roll.id);
        assert.equal(b('utilityRoll', { kind: 'd6', requestId: 'two' }).code, 'COOLDOWN');
        assert.ok(!Object.hasOwn(b('utilityHistory').rolls[0], 'owner'));
    });

    it('blocks a spammed participant for the complete reveal interval but permits other people independently', () => {
        const f = fixture(),
            alice = f.socket('alice'),
            bob = f.socket('bob');
        const first = alice('utilityRoll', { kind: 'd6', requestId: 'first' });
        assert.equal(first.selfBusyUntil, first.roll.revealAt);
        for (let i = 0; i < 50; i++) {
            const reply = alice('utilityRoll', { kind: 'coin', requestId: `spam-${i}` });
            assert.equal(reply.code, 'COOLDOWN');
            assert.equal(reply.retryAt, first.roll.revealAt);
            assert.equal(reply.selfBusyUntil, first.roll.revealAt);
        }
        assert.ok(bob('utilityRoll', { kind: 'coin', requestId: 'bob' }).roll);
        f.advance(ROLL_DURATION_MS - 1);
        assert.equal(alice('utilityRoll', { kind: 'd20', requestId: 'late' }).code, 'COOLDOWN');
        assert.equal(alice('utilityRoll', { kind: 'd6', requestId: 'first' }).roll.id, first.roll.id);
        f.advance(1);
        const next = alice('utilityRoll', { kind: 'd20', requestId: 'late' });
        assert.ok(next.roll);
        assert.equal(next.roll.at, first.roll.revealAt);
        assert.equal(alice('utilityHistory').rolls.length, 3);
    });

    it('restores the same identity lock from history and live events in a second tab, without locking other people', () => {
        const f = fixture();
        f.peers.get('alice').peer_uuid = 'private-stable-identity';
        f.peers.set('copy', { peer_name: 'Alice second tab', peer_uuid: 'private-stable-identity' });
        const first = f.socket('alice')('utilityRoll', { kind: 'd10', requestId: 'original' });
        assert.equal(f.socket('copy')('utilityHistory').selfBusyUntil, first.roll.revealAt);
        assert.equal(f.socket('bob')('utilityHistory').selfBusyUntil, 0);
        assert.deepEqual(f.socket('copy')('utilityHistory').selfRollIds, [first.roll.id]);
        assert.deepEqual(f.socket('bob')('utilityHistory').selfRollIds, []);
        const copyEvent = f.events.find((event) => event.id === 'copy').data;
        assert.equal(copyEvent.selfBusyUntil, first.roll.revealAt);
        assert.equal(copyEvent.selfRollId, first.roll.id);
        assert.equal(f.events.find((event) => event.id === 'bob').data.selfBusyUntil, 0);
        assert.equal(Object.hasOwn(f.events.find((event) => event.id === 'bob').data, 'selfRollId'), false);
        assert.equal(first.selfRollId, first.roll.id);
        assert.ok(!JSON.stringify(copyEvent).includes('private-stable-identity'));
        assert.equal(f.socket('copy')('utilityRoll', { kind: 'coin', requestId: 'copy' }).code, 'COOLDOWN');
    });
});

function browserFixture() {
    let clock = 10000,
        timerId = 0,
        requestId = 0;
    const timers = new Map(),
        handlers = new Map(),
        sent = [];
    const socket = {
        id: 'alice',
        connected: true,
        on: (event, fn) => handlers.set(event, fn),
        off: (event) => handlers.delete(event),
        emit: (event, data, callback) => sent.push({ event, data, callback }),
    };
    const context = {
        window: {},
        crypto: { randomUUID: () => `request-${++requestId}` },
        Date: { now: () => clock },
        setTimeout: (fn, ms) => {
            timers.set(++timerId, { fn, at: clock + ms });
            return timerId;
        },
        clearTimeout: (id) => timers.delete(id),
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/RoomUtilities.js'), 'utf8'), context);
    const utilities = context.window.RoomUtilities;
    const reply = (event, value) => {
        const request = sent.find((item) => item.event === event && !item.answered);
        assert.ok(request, `an outstanding ${event} request is required`);
        request.answered = true;
        request.callback(value);
    };
    const history = (extra = {}) =>
        reply('utilityHistory', { session: 'room', now: clock, rolls: [], selfBusyUntil: 0, ...extra });
    utilities.connect(socket);
    return {
        utilities,
        socket,
        sent,
        reply,
        history,
        receive: (event, value) => handlers.get(event)?.(value),
        now: () => clock,
        advance: (ms) => {
            const until = clock + ms;
            for (;;) {
                const due = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= until);
                if (!due) break;
                timers.delete(due[0]);
                clock = due[1].at;
                due[1].fn();
            }
            clock = until;
        },
    };
}
function browserRoll(at, fields = {}) {
    return {
        id: 'roll-1',
        sequence: 1,
        peerId: 'alice',
        peerName: 'Alice',
        kind: 'd6',
        value: 4,
        at,
        revealAt: at + ROLL_DURATION_MS,
        ...fields,
    };
}

describe('RoomUtilities browser coordination', () => {
    it('locks immediately before the RPC, rejects repeat clicks and unlocks automatically only at reveal time', async () => {
        const f = browserFixture();
        assert.equal(f.utilities.current().busy, true, 'initial history must synchronize first');
        f.history();
        assert.equal(f.utilities.current().busy, false);
        const result = browserRoll(f.now()),
            rolling = f.utilities.roll('d6');
        assert.equal(f.utilities.current().busy, true);
        await assert.rejects(f.utilities.roll('coin'), /andamento/);
        assert.equal(f.sent.filter((item) => item.event === 'utilityRoll').length, 1);
        f.receive('utilityRolled', { session: 'room', now: f.now(), roll: result, selfBusyUntil: result.revealAt });
        f.reply('utilityRoll', { session: 'room', now: f.now(), roll: result, selfBusyUntil: result.revealAt });
        await rolling;
        assert.equal(f.utilities.current().rolls.length, 1, 'broadcast and acknowledgment deduplicate');
        assert.equal(f.utilities.current().busyUntil, result.revealAt);
        f.advance(ROLL_DURATION_MS - 1);
        assert.equal(f.utilities.current().busy, true);
        f.advance(11);
        assert.equal(f.utilities.current().busy, false);
        f.utilities.disconnect();
    });

    it('keeps the shared history while other people roll and restores a cross-tab own lock after reconnect', () => {
        const f = browserFixture();
        f.history();
        const other = browserRoll(f.now(), { peerId: 'bob', peerName: 'Bob' });
        f.receive('utilityRolled', { session: 'room', now: f.now(), roll: other, selfBusyUntil: 0 });
        assert.equal(f.utilities.current().busy, false, 'another person cannot lock the local buttons');
        assert.equal(f.utilities.current().rolls[0].peerName, 'Bob');
        f.socket.connected = false;
        f.receive('disconnect');
        assert.equal(f.utilities.current().online, false);
        f.socket.connected = true;
        f.receive('connect');
        assert.equal(f.utilities.current().busy, true);
        const own = browserRoll(f.now(), { id: 'roll-2', sequence: 2, peerId: 'copy' });
        f.history({ rolls: [other, own], selfBusyUntil: own.revealAt });
        assert.equal(f.utilities.current().busy, true);
        assert.equal(f.utilities.current().busyUntil, own.revealAt);
        assert.equal(f.utilities.current().rolls.length, 2);
        f.advance(ROLL_DURATION_MS + 10);
        assert.equal(f.utilities.current().busy, false);
        f.utilities.disconnect();
    });

    it('recovers an accepted roll after a lost acknowledgment without duplicating or replaying historical animation', async () => {
        const f = browserFixture();
        f.history();
        const incoming = [];
        f.utilities.subscribe((_state, fresh) => incoming.push(...fresh));
        const rolling = f.utilities.roll('d6'),
            rejected = assert.rejects(rolling, /Sem confirmação/),
            result = browserRoll(f.now());
        f.receive('utilityRolled', { session: 'room', now: f.now(), roll: result, selfBusyUntil: result.revealAt });
        f.advance(8000);
        await rejected;
        assert.equal(f.utilities.current().busy, true, 'history recovery must complete before enabling a retry');
        f.history({ rolls: [result], selfBusyUntil: result.revealAt });
        assert.equal(f.utilities.current().busy, false);
        assert.equal(f.utilities.current().rolls.length, 1);
        assert.equal(incoming.length, 1);
        assert.equal(f.sent.filter((item) => item.event === 'utilityRoll').length, 1);
        f.utilities.disconnect();
    });

    it('does not rewind the clock when a delayed ACK arrives or leak old-room results after changing sockets', async () => {
        const f = browserFixture();
        f.history();
        const at = f.now(),
            result = browserRoll(at),
            rolling = f.utilities.roll('d6');
        f.receive('utilityRolled', { session: 'room', now: at, roll: result, selfBusyUntil: result.revealAt });
        f.advance(3000);
        f.reply('utilityRoll', { session: 'room', now: at, roll: result, selfBusyUntil: result.revealAt });
        await rolling;
        assert.equal(f.utilities.now(), at + 3000);
        f.advance(ROLL_DURATION_MS - 3000 + 10);
        assert.equal(f.utilities.current().busy, false);
        f.utilities.disconnect();
        assert.equal(f.utilities.current().rolls.length, 0);
        assert.equal(f.utilities.current().busyUntil, 0);
    });

    it('discards old-socket replies and timeouts without overwriting the new room history or lock', async () => {
        const f = browserFixture();
        f.history();
        const abandoned = f.utilities.roll('d6');
        f.socket.connected = false;
        f.receive('disconnect');
        f.socket.connected = true;
        f.receive('connect');
        f.history({ session: 'new-room' });
        assert.equal(f.utilities.current().session, 'new-room');
        assert.equal(f.utilities.current().busy, false);
        f.advance(8000);
        await abandoned;
        assert.equal(f.sent.filter((item) => item.event === 'utilityHistory').length, 2);
        assert.equal(f.utilities.current().busy, false);
        f.reply('utilityRoll', { session: 'room', now: 10000, roll: browserRoll(10000), selfBusyUntil: 16000 });
        assert.equal(f.utilities.current().session, 'new-room');
        assert.equal(f.utilities.current().rolls.length, 0);
        f.utilities.disconnect();
    });

    it('tracks only its personal recent roll IDs across tabs and prunes IDs absent from the 50-roll history', () => {
        const f = browserFixture(),
            own = browserRoll(f.now(), { peerId: 'copy' });
        f.history({ rolls: [own], selfRollIds: [own.id], selfBusyUntil: own.revealAt });
        assert.deepEqual(Array.from(f.utilities.current().selfRollIds), [own.id]);
        const next = browserRoll(f.now(), { id: 'roll-2', sequence: 2, peerId: 'other-copy' });
        f.receive('utilityRolled', { session: 'room', now: f.now(), roll: next, selfRollId: next.id });
        assert.deepEqual(Array.from(f.utilities.current().selfRollIds), [own.id, next.id]);
        for (let i = 3; i <= 52; i++) {
            const other = browserRoll(f.now(), { id: `roll-${i}`, sequence: i, peerId: 'bob' });
            f.receive('utilityRolled', { session: 'room', now: f.now(), roll: other });
        }
        assert.equal(f.utilities.current().rolls.length, 50);
        assert.deepEqual(Array.from(f.utilities.current().selfRollIds), []);
        const corrupt = browserRoll(f.now(), { id: 'invalid-date', sequence: 53, peerId: 'copy', at: NaN });
        f.receive('utilityRolled', { session: 'room', now: f.now(), roll: corrupt, selfRollId: corrupt.id });
        assert.equal(
            f.utilities.current().rolls.some((roll) => roll.id === corrupt.id),
            false
        );
        assert.deepEqual(Array.from(f.utilities.current().selfRollIds), []);
        f.utilities.disconnect();
    });
});
