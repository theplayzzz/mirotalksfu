'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomInt, randomUUID, createHash } = require('node:crypto');

const fault = (message, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { code });
const number = (value, min, max, label) => {
    if (!Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max)
        throw fault(`${label}: escolha entre ${min} e ${max}.`);
    return Number(value);
};
const roomKey = (value) => {
    if (typeof value !== 'string' || !/^[\w.-]{1,100}$/.test(value)) throw fault('Sala inválida.');
    return value;
};

// Controls only game assignments and UI messages. It never owns media transports,
// meeting membership, authentication of a room, or moderation/disconnect actions.
class CaptchaControl {
    constructor({
        enabled = false,
        rooms = new Map(),
        sockets,
        catalog = [],
        dataDir,
        now = Date.now,
        draw = randomInt,
    } = {}) {
        this.enabled = enabled;
        this.rooms = rooms;
        this.sockets = sockets;
        this.catalog = catalog;
        this.now = now;
        this.draw = draw;
        this.capable = new Set();
        this.active = new Map();
        this.votes = new Map();
        this.attempts = new Map();
        this.ratings = new Map();
        this.lastTriggered = new Map();
        this.nextRandom = new Map();
        this.events = [];
        this.storageError = null;
        this.writes = Promise.resolve();
        this.configWrites = Promise.resolve();
        this.settings = {
            games: Object.fromEntries(
                catalog.map((g) => [g.id, { enabled: true, duration: g.seconds, intensity: 0.9 }])
            ),
            rooms: {},
        };
        if (enabled && dataDir) {
            this.dataDir = dataDir;
            try {
                fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
            } catch {
                this.enabled = false;
                this.storageError = 'Armazenamento indisponível. CAPTCHA desativado.';
                return;
            }
            try {
                const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
                this.validateSettings(settings);
                this.settings = settings;
            } catch (error) {
                if (error.code !== 'ENOENT') this.storageError = 'Configuração anterior não pôde ser carregada.';
            }
            try {
                for (const line of fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').split('\n')) {
                    if (!line) continue;
                    try {
                        this.restore(JSON.parse(line));
                    } catch {
                        /* A torn last line does not hide earlier records. */
                    }
                }
            } catch (error) {
                if (error.code !== 'ENOENT') this.storageError = 'Histórico anterior não pôde ser carregado.';
            }
            for (const attempt of this.attempts.values()) {
                if (!attempt.outcome) {
                    attempt.outcome = 'abandoned';
                    attempt.completedAt = now();
                    attempt.reason = 'server_restart';
                    this.record({ kind: 'attempt', attempt });
                }
            }
        }
    }

    restore(event) {
        if (event.kind === 'attempt' && event.attempt?.id) this.attempts.set(event.attempt.id, event.attempt);
        else if (event.kind === 'rating' && event.rating?.key) this.ratings.set(event.rating.key, event.rating);
        else {
            this.events.push(event);
            this.events = this.events.slice(-300);
        }
    }

    record(event) {
        const entry = JSON.parse(JSON.stringify({ ...event, at: this.now() }));
        this.restore(entry);
        if (!this.dataDir) return;
        this.writes = this.writes
            .then(() =>
                fs.promises.appendFile(path.join(this.dataDir, 'events.jsonl'), JSON.stringify(entry) + '\n', {
                    mode: 0o600,
                })
            )
            .catch(() => {
                this.storageError = 'Não foi possível gravar o histórico. As chamadas continuam disponíveis.';
            });
    }

    peers(roomId) {
        const room = this.rooms.get(roomId);
        const peers = room?.getPeers?.() || room?.peers;
        return peers instanceof Map ? [...peers.entries()].filter(([, p]) => !p.closed && !p.peer_lobby) : [];
    }

    member(roomId, peerId) {
        return this.peers(roomId).find(([id]) => id === peerId)?.[1];
    }
    emit(peerId, event, data) {
        this.sockets?.get(peerId)?.emit(event, data);
    }
    broadcast(roomId, event, data) {
        for (const [id] of this.peers(roomId)) this.emit(id, event, data);
    }
    userKey(roomId, peer) {
        return createHash('sha256')
            .update(`${roomId}\0${peer.peer_uuid || peer.id || peer.peer_name}`)
            .digest('hex')
            .slice(0, 32);
    }

    validateSettings(value) {
        if (!value || typeof value !== 'object' || !value.games || !value.rooms) throw fault('Configuração inválida.');
        for (const game of this.catalog) {
            const settings = value.games[game.id];
            if (!settings || typeof settings.enabled !== 'boolean') throw fault('Selecione os jogos disponíveis.');
            number(settings.duration, 8, 40, 'Duração');
            number(settings.intensity, 0.7, 1.5, 'Intensidade');
        }
        if (Object.keys(value.games).some((id) => !this.catalog.some((g) => g.id === id)))
            throw fault('Jogo desconhecido.');
        for (const [id, settings] of Object.entries(value.rooms)) {
            roomKey(id);
            if (typeof settings.enabled !== 'boolean' || !['one', 'all'].includes(settings.mode))
                throw fault('Automação inválida.');
            number(settings.intervalSeconds, 30, 86400, 'Intervalo');
            number(settings.cooldownSeconds, 30, 86400, 'Pausa por participante');
            number(settings.jitterPercent, 0, 50, 'Variação do intervalo');
        }
    }

    async configure(value) {
        this.validateSettings(value);
        const clean = {
            games: Object.fromEntries(
                this.catalog.map((g) => [
                    g.id,
                    {
                        enabled: value.games[g.id].enabled,
                        duration: Number(value.games[g.id].duration),
                        intensity: Number(value.games[g.id].intensity),
                    },
                ])
            ),
            rooms: Object.fromEntries(
                Object.entries(value.rooms).map(([id, r]) => [
                    id,
                    {
                        enabled: r.enabled,
                        mode: r.mode,
                        intervalSeconds: Number(r.intervalSeconds),
                        cooldownSeconds: Number(r.cooldownSeconds),
                        jitterPercent: Number(r.jitterPercent),
                    },
                ])
            ),
        };
        const save = this.configWrites
            .catch(() => {})
            .then(async () => {
                if (this.dataDir) {
                    const file = path.join(this.dataDir, 'settings.json');
                    await fs.promises.writeFile(file + '.tmp', JSON.stringify(clean), { mode: 0o600 });
                    await fs.promises.rename(file + '.tmp', file);
                }
                for (const id of Object.keys(clean.rooms))
                    if (JSON.stringify(clean.rooms[id]) !== JSON.stringify(this.settings.rooms[id]))
                        this.nextRandom.delete(id);
                this.settings = clean;
                this.record({ kind: 'configuration' });
                return this.snapshot();
            });
        this.configWrites = save;
        return save;
    }

    config(gameId) {
        const game = this.catalog.find((g) => g.id === gameId),
            settings = this.settings.games[gameId];
        if (!game || !settings?.enabled) throw fault('Esse jogo está desativado.');
        return {
            id: game.id,
            title: game.title,
            revision: game.revision,
            duration: settings.duration,
            intensity: settings.intensity,
        };
    }

    choose(gameId) {
        if (gameId && gameId !== 'random') return this.config(gameId);
        const games = this.catalog.filter((g) => this.settings.games[g.id]?.enabled);
        if (!games.length) throw fault('Ative pelo menos um jogo.');
        return this.config(games[this.draw(games.length)].id);
    }

    trigger({ roomId, peerId, gameId = 'random', source = 'admin' }) {
        if (!this.enabled) throw fault('Recurso indisponível.', 'DISABLED');
        roomKey(roomId);
        const peer = this.member(roomId, peerId);
        if (!peer || !this.capable.has(peerId))
            throw fault('Participante indisponível ou com a página desatualizada.', 'NOT_READY');
        if (this.active.has(peerId)) throw fault('Esse participante já está com um jogo ou resultado aberto.', 'BUSY');
        const config = this.choose(gameId);
        const assignment = {
            id: randomUUID(),
            roomId,
            peerId,
            name: String(peer.peer_name || 'Participante').slice(0, 100),
            userKey: this.userKey(roomId, peer),
            gameId: config.id,
            config,
            source,
            createdAt: this.now(),
            expiresAt: this.now() + 300000,
            phase: 'assigned',
            attempts: [],
            currentAttempt: null,
        };
        this.active.set(peerId, assignment);
        this.lastTriggered.set(peerId, this.now());
        this.record({
            kind: 'assigned',
            id: assignment.id,
            roomId,
            peerId,
            name: assignment.name,
            gameId: config.id,
            source,
        });
        this.emit(peerId, 'captchaAssigned', this.publicAssignment(assignment));
        return this.publicAssignment(assignment);
    }

    publicAssignment(a) {
        return { id: a.id, roomId: a.roomId, config: a.config, phase: a.phase, expiresAt: a.expiresAt };
    }

    randomTargets(roomId, mode = 'one', gameId = 'random', source = 'admin') {
        const cooldown = source === 'random' ? (this.settings.rooms[roomId]?.cooldownSeconds || 120) * 1000 : 0;
        const peers = this.peers(roomId).filter(
            ([id]) =>
                this.capable.has(id) &&
                !this.active.has(id) &&
                this.now() - (this.lastTriggered.get(id) ?? -Infinity) >= cooldown
        );
        const targets = mode === 'all' ? peers : peers.length ? [peers[this.draw(peers.length)]] : [];
        return targets.map(([peerId]) => this.trigger({ roomId, peerId, gameId, source }));
    }

    assignment(peerId, id) {
        const a = this.active.get(peerId);
        if (!a || a.id !== id || !this.member(a.roomId, peerId)) throw fault('Esse jogo já foi encerrado.', 'STALE');
        if (this.now() >= a.expiresAt) {
            this.release(peerId, 'expired');
            throw fault('O jogo expirou.', 'STALE');
        }
        return a;
    }

    startAttempt(peerId, id) {
        const a = this.assignment(peerId, id);
        if (a.phase === 'playing') return { attempt: this.attempts.get(a.currentAttempt), config: a.config };
        if (a.attempts.length >= 30) throw fault('Encerre este desafio antes de jogar mais vezes.');
        a.config = this.config(a.gameId);
        const attempt = {
            id: randomUUID(),
            assignmentId: a.id,
            roomId: a.roomId,
            userKey: a.userKey,
            name: a.name,
            gameId: a.gameId,
            revision: a.config.revision,
            duration: a.config.duration,
            intensity: a.config.intensity,
            source: a.source,
            number: a.attempts.length + 1,
            startedAt: this.now(),
            outcome: null,
        };
        a.attempts.push(attempt.id);
        a.currentAttempt = attempt.id;
        a.phase = 'playing';
        this.record({ kind: 'attempt', attempt });
        return { attempt, config: a.config };
    }

    finishAttempt(peerId, data) {
        const a = this.assignment(peerId, data.assignmentId),
            attempt = this.attempts.get(data.attemptId);
        if (!attempt || attempt.assignmentId !== a.id) throw fault('Tentativa inválida.');
        if (attempt.outcome) return { attempt };
        if (a.currentAttempt !== attempt.id || !['survived', 'impact', 'timeout', 'error'].includes(data.reason))
            throw fault('Resultado inválido.');
        const elapsed = number(data.elapsed, 0, attempt.duration + 0.1, 'Tempo');
        if (elapsed > (this.now() - attempt.startedAt) / 1000 + 2) throw fault('Tempo de jogo inválido.');
        Object.assign(attempt, {
            completedAt: this.now(),
            elapsed,
            reason: data.reason,
            outcome: data.reason === 'survived' ? 'won' : data.reason === 'error' ? 'error' : 'lost',
        });
        a.phase = 'result';
        this.record({ kind: 'attempt', attempt });
        this.emit(peerId, 'captchaReleased', { assignmentId: a.id, keepResult: true, reason: 'completed' });
        return { attempt };
    }

    rate(peerId, data) {
        const a = this.assignment(peerId, data.assignmentId),
            attempt = this.attempts.get(data.attemptId);
        if (!attempt || attempt.assignmentId !== a.id || !['won', 'lost'].includes(attempt.outcome))
            throw fault('Jogue antes de avaliar.');
        const value = number(data.value, 1, 5, 'Nota');
        if (!Number.isInteger(value)) throw fault('Escolha de uma a cinco estrelas.');
        if (this.ratings.get(`${a.userKey}:${a.gameId}`)?.value === value) return { value };
        const rating = {
            key: `${a.userKey}:${a.gameId}`,
            gameId: a.gameId,
            revision: attempt.revision,
            userKey: a.userKey,
            attemptId: attempt.id,
            value,
            at: this.now(),
        };
        this.record({ kind: 'rating', rating });
        return { value };
    }

    release(peerId, reason = 'released') {
        const a = this.active.get(peerId);
        if (!a) return { released: false };
        const attempt = this.attempts.get(a.currentAttempt);
        if (attempt && !attempt.outcome) {
            Object.assign(attempt, { outcome: 'abandoned', reason, completedAt: this.now() });
            this.record({ kind: 'attempt', attempt });
        }
        this.active.delete(peerId);
        this.record({
            kind: 'released',
            id: a.id,
            roomId: a.roomId,
            name: a.name,
            reason,
            attempts: a.attempts.length,
        });
        this.emit(peerId, 'captchaReleased', { assignmentId: a.id, keepResult: false, reason });
        return { released: true };
    }

    openVote({ roomId, peerId, gameId = 'random', mode = 'percent', required = 35, seconds = 30 }) {
        roomKey(roomId);
        if (!this.member(roomId, peerId) || !this.capable.has(peerId)) throw fault('Participante indisponível.');
        if (this.active.has(peerId)) throw fault('Esse participante já está em um jogo.');
        if ([...this.votes.values()].some((v) => v.status === 'open' && v.roomId === roomId))
            throw fault('Já existe uma votação aberta nessa sala.');
        this.choose(gameId);
        const eligible = this.peers(roomId).map(([id]) => id);
        if (!['count', 'percent'].includes(mode)) throw fault('Regra de votação inválida.');
        const threshold =
            mode === 'count'
                ? number(required, 1, eligible.length, 'Votos necessários')
                : Math.max(1, Math.ceil((eligible.length * number(required, 1, 100, 'Percentual')) / 100));
        if (!Number.isInteger(threshold)) throw fault('Escolha um número inteiro de votos.');
        const vote = {
            id: randomUUID(),
            roomId,
            peerId,
            name: String(this.member(roomId, peerId).peer_name),
            gameId,
            eligible,
            threshold,
            choices: {},
            status: 'open',
            createdAt: this.now(),
            expiresAt: this.now() + number(seconds, 10, 120, 'Prazo') * 1000,
        };
        this.votes.set(vote.id, vote);
        this.publishVote(vote);
        return this.publicVote(vote);
    }

    publicVote(v) {
        return {
            id: v.id,
            roomId: v.roomId,
            peerId: v.peerId,
            name: v.name,
            threshold: v.threshold,
            eligibleCount: v.eligible.length,
            yes: Object.values(v.choices).filter((c) => c === 'yes').length,
            no: Object.values(v.choices).filter((c) => c === 'no').length,
            status: v.status,
            expiresAt: v.expiresAt,
        };
    }

    sendVote(v, id) {
        this.emit(id, 'captchaVote', {
            ...this.publicVote(v),
            eligible: v.eligible.includes(id),
            choice: v.choices[id] || null,
        });
    }
    publishVote(v) {
        for (const [id] of this.peers(v.roomId)) this.sendVote(v, id);
        this.record({ kind: 'vote', vote: this.publicVote(v) });
    }
    cancelVote(id, reason = 'cancelled') {
        const vote = this.votes.get(id);
        if (vote?.status === 'open') {
            vote.status = reason;
            this.publishVote(vote);
        }
        return { cancelled: true };
    }

    castVote(peerId, data) {
        const vote = this.votes.get(data.voteId);
        if (!vote || vote.status !== 'open' || this.now() >= vote.expiresAt) throw fault('Votação encerrada.');
        if (!vote.eligible.includes(peerId) || !this.member(vote.roomId, peerId))
            throw fault('Você não participa desta votação.', 'FORBIDDEN');
        if (!['yes', 'no'].includes(data.choice)) throw fault('Voto inválido.');
        if (vote.choices[peerId]) return this.publicVote(vote);
        vote.choices[peerId] = data.choice;
        if (Object.values(vote.choices).filter((c) => c === 'yes').length >= vote.threshold) {
            vote.status = 'approved';
            try {
                this.trigger({ roomId: vote.roomId, peerId: vote.peerId, gameId: vote.gameId, source: 'vote' });
            } catch {
                vote.status = 'unavailable';
            }
        }
        this.publishVote(vote);
        return this.publicVote(vote);
    }

    tick() {
        if (!this.enabled) return;
        for (const [id, a] of this.active)
            if (!this.member(a.roomId, id) || this.now() >= a.expiresAt) this.release(id, 'expired');
        for (const v of this.votes.values()) {
            if (v.status !== 'open') continue;
            if (!this.member(v.roomId, v.peerId)) this.cancelVote(v.id, 'target_left');
            else if (this.now() >= v.expiresAt) this.cancelVote(v.id, 'expired');
            else {
                const possible = v.eligible.filter((id) => this.member(v.roomId, id) && v.choices[id] !== 'no').length;
                if (possible < v.threshold) this.cancelVote(v.id, 'unreachable');
            }
        }
        for (const [id, settings] of Object.entries(this.settings.rooms)) {
            if (!settings.enabled) {
                this.nextRandom.delete(id);
                continue;
            }
            if (!this.nextRandom.has(id)) this.nextRandom.set(id, this.nextTime(settings));
            if (this.now() < this.nextRandom.get(id)) continue;
            try {
                this.randomTargets(id, settings.mode, 'random', 'random');
            } catch {
                /* Disabled games / an empty room never affect the call. */
            }
            this.nextRandom.set(id, this.nextTime(settings));
        }
        for (const [id, v] of this.votes)
            if (v.status !== 'open' && this.now() - v.createdAt > 300000) this.votes.delete(id);
    }

    nextTime(settings) {
        const variation = settings.jitterPercent / 100;
        return this.now() + settings.intervalSeconds * 1000 * (1 + (this.draw(10001) / 5000 - 1) * variation);
    }

    bind(socket, getRoom) {
        const member = () => {
            const room = getRoom(socket),
                peer = room?.getPeer(socket.id);
            if (!this.enabled || !peer || peer.closed || peer.peer_lobby)
                throw fault('Entre na sala para usar o jogo.', 'NOT_JOINED');
            return room;
        };
        const handler = (event, fn) =>
            socket.on(event, (data, callback) => {
                if (typeof callback !== 'function') return;
                try {
                    member();
                    callback(fn(data || {}));
                } catch (error) {
                    callback({ error: error.message, code: error.code || 'INVALID_REQUEST' });
                }
            });
        socket.on('captchaHello', (_, callback) => {
            if (typeof callback !== 'function') return;
            if (!this.enabled) return callback({ enabled: false });
            try {
                member();
                this.capable.add(socket.id);
                const active = this.active.get(socket.id);
                callback({ enabled: true, assignment: active ? this.publicAssignment(active) : null });
                for (const vote of this.votes.values()) if (vote.status === 'open') this.sendVote(vote, socket.id);
            } catch (error) {
                callback({ enabled: false, error: error.message });
            }
        });
        if (!this.enabled) return;
        handler('captchaAttemptStart', (d) => this.startAttempt(socket.id, d.assignmentId));
        handler('captchaAttemptFinish', (d) => this.finishAttempt(socket.id, d));
        handler('captchaRate', (d) => this.rate(socket.id, d));
        handler('captchaRelease', (d) => {
            this.assignment(socket.id, d.assignmentId);
            return this.release(socket.id);
        });
        handler('captchaVoteCast', (d) => this.castVote(socket.id, d));
        socket.on('disconnect', () => {
            this.capable.delete(socket.id);
            this.release(socket.id, 'disconnected');
            for (const vote of this.votes.values())
                if (vote.peerId === socket.id) this.cancelVote(vote.id, 'target_left');
        });
    }

    snapshot() {
        const attempts = [...this.attempts.values()],
            ratings = [...this.ratings.values()];
        const stats = this.catalog.map((game) => {
            const plays = attempts.filter((a) => a.gameId === game.id),
                done = plays.filter((a) => ['won', 'lost'].includes(a.outcome));
            const notes = ratings.filter((r) => r.gameId === game.id),
                wins = done.filter((a) => a.outcome === 'won').length;
            const users = new Set(plays.map((a) => a.userKey));
            return {
                gameId: game.id,
                starts: plays.length,
                completed: done.length,
                wins,
                losses: done.length - wins,
                abandoned: plays.filter((a) => a.outcome === 'abandoned').length,
                retries: plays.filter((a) => a.number > 1).length,
                users: users.size,
                winRate: done.length ? wins / done.length : null,
                averageSeconds: done.length ? done.reduce((s, a) => s + a.elapsed, 0) / done.length : null,
                averageRating: notes.length ? notes.reduce((s, r) => s + r.value, 0) / notes.length : null,
                ratings: notes.length,
            };
        });
        return {
            catalog: this.catalog,
            settings: this.settings,
            storageError: this.storageError,
            rooms: [...this.rooms.keys()].map((id) => ({
                id,
                nextRandomAt: this.nextRandom.get(id) || null,
                users: this.peers(id).map(([peerId, p]) => ({
                    id: peerId,
                    name: String(p.peer_name || 'Participante'),
                    ready: this.capable.has(peerId),
                    active: this.active.has(peerId),
                    phase: this.active.get(peerId)?.phase || null,
                })),
            })),
            active: [...this.active.values()].map((a) => ({
                ...this.publicAssignment(a),
                peerId: a.peerId,
                name: a.name,
            })),
            votes: [...this.votes.values()].map((v) => this.publicVote(v)),
            stats,
            attempts: attempts.toSorted((a, b) => b.startedAt - a.startedAt).slice(0, 150),
            events: this.events.slice(-100).reverse(),
        };
    }
}

module.exports = { CaptchaControl, fault };
