'use strict';

const assert = require('node:assert/strict');
const { RoomUtilities, HISTORY_LIMIT, COOLDOWN_MS } = require('../app/src/RoomUtilities');

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
        getPeer: (id) => peers.get(id),
        sendToAll: (event, data) => events.push({ event, data }),
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
        advance: () => {
            clock += COOLDOWN_MS;
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
        assert.equal(f.events.length, 1);
        assert.equal(f.events[0].event, 'utilityRolled');
        assert.deepEqual(f.events[0].data, reply);
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

    it('deduplicates a repeated request and rate-limits separate rolls per participant', () => {
        const f = fixture();
        const alice = f.socket('alice');
        const first = alice('utilityRoll', { kind: 'd6', requestId: 'same' });
        assert.deepEqual(alice('utilityRoll', { kind: 'd6', requestId: 'same' }), first);
        assert.equal(f.events.length, 1);
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
        assert.equal(first.roll.revealAt - first.roll.at, 4000);
        assert.equal(b('utilityRoll', { kind: 'd20', requestId: 'one' }).roll.id, first.roll.id);
        assert.equal(b('utilityRoll', { kind: 'd6', requestId: 'two' }).code, 'COOLDOWN');
        assert.ok(!Object.hasOwn(b('utilityHistory').rolls[0], 'owner'));
    });
});
