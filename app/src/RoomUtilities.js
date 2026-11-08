'use strict';

const { randomInt, randomUUID } = require('node:crypto');
const KINDS = Object.freeze({ d6: 6, d10: 10, d20: 20, coin: 2 });
const HISTORY_LIMIT = 50;
const ROLL_DURATION_MS = 6000;
const COOLDOWN_MS = ROLL_DURATION_MS;
const ownBusyUntil = (state, owner) => (state.lastRollAt.get(owner) ?? -COOLDOWN_MS) + COOLDOWN_MS;

class RoomUtilities {
    constructor({ now = Date.now, draw = randomInt } = {}) {
        this.rooms = new WeakMap();
        this.now = now;
        this.draw = draw;
    }

    state(room) {
        if (!this.rooms.has(room)) {
            this.rooms.set(room, {
                session: room.sessionId || randomUUID(),
                sequence: 0,
                rolls: [],
                lastRollAt: new Map(),
            });
        }
        return this.rooms.get(room);
    }

    bind(socket, getRoom) {
        const member = () => {
            const room = getRoom(socket);
            const peer = room?.getPeer(socket.id);
            return peer && !peer.peer_lobby && !peer.closed ? { room, peer } : null;
        };

        socket.on('utilityHistory', (_, callback) => {
            if (typeof callback !== 'function') return;
            const context = member();
            if (!context) return callback({ error: 'Entre na sala para ver as rolagens.', code: 'NOT_JOINED' });
            const state = this.state(context.room);
            const owner = context.peer.peer_uuid || socket.id;
            callback({
                session: state.session,
                now: this.now(),
                selfBusyUntil: ownBusyUntil(state, owner),
                selfRollIds: state.rolls.filter((roll) => roll.owner === owner).map((roll) => roll.id),
                rolls: state.rolls.map(({ owner: _owner, ...roll }) => roll),
            });
        });

        socket.on('utilityRoll', (request, callback) => {
            if (typeof callback !== 'function') return;
            const context = member();
            if (!context) return callback({ error: 'Entre na sala para rolar.', code: 'NOT_JOINED' });
            const kind = request?.kind;
            const requestId = request?.requestId;
            if (!Object.hasOwn(KINDS, kind) || typeof requestId !== 'string' || !/^[\w-]{1,80}$/.test(requestId)) {
                return callback({ error: 'Escolha d6, d10, d20 ou cara ou coroa.', code: 'INVALID_ROLL' });
            }
            const state = this.state(context.room);
            const owner = context.peer.peer_uuid || socket.id;
            const previous = state.rolls.find((roll) => roll.requestId === requestId && roll.owner === owner);
            const publicRoll = ({ owner: _owner, ...roll }) => roll;
            if (previous)
                return callback({
                    roll: publicRoll(previous),
                    now: this.now(),
                    session: state.session,
                    selfBusyUntil: ownBusyUntil(state, owner),
                    selfRollId: previous.id,
                });
            const now = this.now();
            if (now - (state.lastRollAt.get(owner) ?? -Infinity) < COOLDOWN_MS) {
                const retryAt = state.lastRollAt.get(owner) + COOLDOWN_MS;
                return callback({
                    error: 'Sua rolagem ainda está em andamento. Espere ela terminar.',
                    code: 'COOLDOWN',
                    now,
                    session: state.session,
                    retryAt,
                    selfBusyUntil: retryAt,
                });
            }
            state.lastRollAt.set(owner, now);
            if (state.lastRollAt.size > 2000)
                for (const [key, at] of state.lastRollAt) if (now - at > 60000) state.lastRollAt.delete(key);
            // Ignore names, room IDs and results supplied by the browser. Identity and randomness are server-owned.
            const roll = {
                id: randomUUID(),
                requestId,
                sequence: ++state.sequence,
                peerId: socket.id,
                peerName: String(context.peer.peer_name || 'Participante').slice(0, 100),
                kind,
                value: this.draw(1, KINDS[kind] + 1),
                at: now,
                revealAt: now + ROLL_DURATION_MS,
            };
            state.rolls.push({ ...roll, owner });
            if (state.rolls.length > HISTORY_LIMIT) state.rolls.shift();
            // Use the admitted membership, just like history access. Room.sendToAll also
            // reaches peers waiting in the lobby, who must not receive room roll data.
            const peers = context.room.getPeers?.() || context.room.peers;
            for (const [id, peer] of peers || []) {
                if (!peer.closed && !peer.peer_lobby) {
                    const recipient = peer.peer_uuid || id;
                    context.room.send(id, 'utilityRolled', {
                        session: state.session,
                        now,
                        roll,
                        selfBusyUntil: ownBusyUntil(state, recipient),
                        ...(recipient === owner ? { selfRollId: roll.id } : {}),
                    });
                }
            }
            callback({ session: state.session, now, roll, selfBusyUntil: roll.revealAt, selfRollId: roll.id });
        });
    }
}

module.exports = { RoomUtilities, HISTORY_LIMIT, COOLDOWN_MS, ROLL_DURATION_MS };
