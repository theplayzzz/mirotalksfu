'use strict';

const { randomInt, randomUUID } = require('node:crypto');
const KINDS = Object.freeze({ d6: 6, d10: 10, d20: 20, coin: 2 });
const HISTORY_LIMIT = 50;
const COOLDOWN_MS = 1200;

class RoomUtilities {
    constructor({ now = Date.now, draw = randomInt } = {}) {
        this.rooms = new WeakMap();
        this.now = now;
        this.draw = draw;
    }

    state(room) {
        if (!this.rooms.has(room)) {
            this.rooms.set(room, { session: room.sessionId || randomUUID(), sequence: 0, rolls: [] });
        }
        return this.rooms.get(room);
    }

    bind(socket, getRoom) {
        let lastRollAt = -Infinity;
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
            callback({ session: state.session, rolls: state.rolls.slice() });
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
            const previous = state.rolls.find((roll) => roll.requestId === requestId && roll.peerId === socket.id);
            if (previous) return callback({ roll: previous, session: state.session });
            const now = this.now();
            if (now - lastRollAt < COOLDOWN_MS) {
                return callback({ error: 'Espere um instante antes de rolar novamente.', code: 'COOLDOWN' });
            }
            lastRollAt = now;
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
            };
            state.rolls.push(roll);
            if (state.rolls.length > HISTORY_LIMIT) state.rolls.shift();
            context.room.sendToAll('utilityRolled', { session: state.session, roll });
            callback({ session: state.session, roll });
        });
    }
}

module.exports = { RoomUtilities, HISTORY_LIMIT, COOLDOWN_MS };
