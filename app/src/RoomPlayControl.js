'use strict';

const { randomUUID } = require('node:crypto');
const { CaptchaControl, fault } = require('./CaptchaControl');

const RULES = Object.freeze({
    voteSeconds: 25,
    proposalCooldownMs: 90000,
    targetCooldownMs: 180000,
    waitMs: 120000,
    queueMs: 90000,
    voteGapMs: 5000,
    queueLimit: 3,
});
const countGames = new Set(['rhythm', 'paddle', 'shelter', 'slash', 'juggle', 'climb', 'gravity']);
const courseGames = new Set(['web', 'stretch']);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : 0));
const initials = (value) =>
    String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 3) || 'JOG';
const rulesKey = (a) => `${a.revision}:${a.duration}:${a.intensity}`;

// One local player per identity, one pending verification, one public ballot per room.
// This service never calls media transports, room permissions or disconnect/moderation methods.
class RoomPlayControl extends CaptchaControl {
    constructor(options = {}) {
        super(options);
        this.policy = { ...RULES, ...options.policy };
        this.pending = new Map();
        this.cooldowns = new Map();
        this.proposalAt = new Map();
        this.nextVoteAt = new Map();
        this.requests = new Map();
        this.profiles ||= new Map();
        this.version = 1;
        this.settings.interactions = { participantVotes: true, ...this.settings.interactions };
    }
    restore(event) {
        if (event.kind === 'profile' && event.profile?.key) {
            this.profiles ||= new Map();
            this.profiles.set(event.profile.key, event.profile);
        } else super.restore(event);
    }
    validateSettings(value) {
        super.validateSettings(value);
        if (value.interactions && typeof value.interactions.participantVotes !== 'boolean')
            throw fault('Escolha se participantes podem propor votações.');
    }
    async configure(value) {
        const interactions = {
            participantVotes:
                value.interactions?.participantVotes ?? this.settings.interactions?.participantVotes ?? true,
        };
        await super.configure({ ...value, interactions });
        this.changed();
        return this.snapshot();
    }
    changed(roomId) {
        this.version++;
        for (const id of roomId ? [roomId] : this.rooms.keys())
            this.broadcast(id, 'playChanged', { version: this.version });
    }
    identity(roomId, peerId) {
        const peer = this.member(roomId, peerId);
        if (!peer) throw fault('Participante indisponível.', 'NOT_JOINED');
        return this.userKey(roomId, peer);
    }
    context(peerId) {
        for (const roomId of this.rooms.keys()) {
            const peer = this.member(roomId, peerId);
            if (peer) return { roomId, peer, key: this.userKey(roomId, peer) };
        }
        throw fault('Entre na sala para usar jogos e utilidades.', 'NOT_JOINED');
    }
    uniquePeers(roomId) {
        const byKey = new Map();
        for (const [id, peer] of this.peers(roomId)) {
            const key = this.userKey(roomId, peer);
            const owner = this.occupied(key) || [...this.active.values()].find((a) => a.userKey === key);
            if (
                !byKey.has(key) ||
                id === owner?.peerId ||
                (byKey.get(key).id !== owner?.peerId && this.capable.has(id))
            )
                byKey.set(key, { id, peer, key });
        }
        return [...byKey.values()];
    }
    occupied(key) {
        return [...this.active.values()].find((a) => a.userKey === key && a.phase !== 'result');
    }
    waitingFor(key) {
        return [...this.pending.values()].find((a) => a.userKey === key);
    }
    cooldownFor(assignment) {
        return Math.max(
            this.policy.targetCooldownMs,
            (this.settings.rooms[assignment.roomId]?.cooldownSeconds || 0) * 1000
        );
    }
    canTarget(roomId, peerId) {
        if (!this.member(roomId, peerId) || !this.capable.has(peerId)) return false;
        const key = this.identity(roomId, peerId),
            active = [...this.active.values()].find((a) => a.userKey === key);
        return (
            !this.waitingFor(key) &&
            (!active || active.source === 'manual') &&
            (this.cooldowns.get(key) || 0) <= this.now()
        );
    }
    publicAssignment(a) {
        return {
            ...super.publicAssignment(a),
            source: a.source,
            gameId: a.gameId,
            currentAttempt: a.currentAttempt || null,
        };
    }
    trigger({ roomId, peerId, gameId = 'random', source = 'admin' }) {
        if (!this.enabled) throw fault('Recurso indisponível.', 'DISABLED');
        if (!this.canTarget(roomId, peerId))
            throw fault('Esse participante já está em uma verificação ou no intervalo de proteção.', 'BUSY');
        const key = this.identity(roomId, peerId);
        const active = this.occupied(key) || [...this.active.values()].find((a) => a.userKey === key);
        if (active) peerId = active.peerId;
        let assigned;
        if (active?.source === 'manual') {
            const config = this.choose(gameId),
                peer = this.member(roomId, peerId);
            assigned = {
                id: randomUUID(),
                roomId,
                peerId,
                userKey: key,
                name: String(peer.peer_name || 'Participante'),
                config,
                gameId: config.id,
                source,
                phase: active.phase === 'result' ? 'assigned' : 'waiting',
                createdAt: this.now(),
                expiresAt: this.now() + this.policy.waitMs,
                attempts: [],
                currentAttempt: null,
            };
            this.pending.set(peerId, assigned);
            this.record({
                kind: 'assigned',
                id: assigned.id,
                roomId,
                peerId,
                name: assigned.name,
                gameId: config.id,
                source,
                waiting: assigned.phase === 'waiting',
            });
        } else {
            super.trigger({ roomId, peerId, gameId, source });
            assigned = this.active.get(peerId);
        }
        for (const v of this.votes.values())
            if (v.targetKey === key && ['open', 'queued'].includes(v.status)) this.cancelVote(v.id, 'superseded');
        this.changed(roomId);
        return this.publicAssignment(assigned);
    }
    randomTargets(roomId, mode = 'one', gameId = 'random', source = 'admin') {
        const peers = this.uniquePeers(roomId).filter(
            (p) => this.canTarget(roomId, p.id) && (source !== 'random' || !this.occupied(p.key))
        );
        const targets = mode === 'all' ? peers : peers.length ? [peers[this.draw(peers.length)]] : [];
        return targets.map((p) => this.trigger({ roomId, peerId: p.id, gameId, source }));
    }
    manual(peerId, gameId) {
        const { roomId, key } = this.context(peerId);
        if (this.occupied(key))
            throw fault('Sua partida já está em andamento. Retome-a ou encerre pela janela.', 'BUSY');
        if (this.waitingFor(key)) throw fault('Há uma verificação disponível nesta janela.', 'PENDING');
        const old = [...this.active.values()].find((a) => a.userKey === key);
        for (const [id, a] of this.active) if (a.userKey === key) super.release(id, 'next_game');
        super.trigger({ roomId, peerId, gameId, source: 'manual' });
        if (old?.currentAttempt && old.gameId === gameId) this.active.get(peerId).retryOf = old.currentAttempt;
        this.changed(roomId);
        return this.publicAssignment(this.active.get(peerId));
    }
    activate(peerId) {
        const { roomId } = this.context(peerId),
            pending = this.pending.get(peerId),
            active = this.active.get(peerId);
        if (!pending) {
            if (active && active.source !== 'manual') return this.publicAssignment(active);
            throw fault('Nenhuma verificação disponível.', 'STALE');
        }
        if (pending.expiresAt <= this.now()) {
            this.cancelPending(peerId, 'expired');
            throw fault('A verificação expirou.', 'STALE');
        }
        if (active && active.phase !== 'result') throw fault('A verificação aguarda sua partida atual.', 'BUSY');
        if (active) super.release(peerId, 'next_game');
        this.pending.delete(peerId);
        pending.phase = 'assigned';
        pending.expiresAt = this.now() + 300000;
        this.active.set(peerId, pending);
        this.changed(roomId);
        return this.publicAssignment(pending);
    }
    startAttempt(peerId, id) {
        const a = this.assignment(peerId, id);
        const other = this.occupied(a.userKey);
        if (other && other.id !== id) throw fault('Sua partida já está aberta em outra aba.', 'BUSY');
        if (a.phase === 'paused') return { attempt: this.attempts.get(a.currentAttempt), config: a.config };
        const result = super.startAttempt(peerId, id);
        if (a.retryOf && !result.attempt.retryOf) {
            result.attempt.retryOf = a.retryOf;
            result.attempt.number = (this.attempts.get(a.retryOf)?.number || 1) + 1;
            this.record({ kind: 'attempt', attempt: result.attempt });
        }
        this.changed(a.roomId);
        return result;
    }
    pause(peerId, id, paused) {
        const a = this.assignment(peerId, id);
        if (a.phase === 'result' || a.phase === 'assigned') return { phase: a.phase };
        a.phase = paused ? 'paused' : 'playing';
        this.changed(a.roomId);
        return { phase: a.phase };
    }
    finishAttempt(peerId, data) {
        const a = this.assignment(peerId, data.assignmentId),
            existing = this.attempts.get(data.attemptId);
        if (existing?.outcome && existing.assignmentId === a.id)
            return { attempt: existing, ranking: this.ranking(peerId, existing.gameId) };
        const result = super.finishAttempt(peerId, data);
        let attempt = result.attempt;
        if (['won', 'lost'].includes(attempt.outcome)) {
            const m = data.metrics || {},
                seconds = Math.round(attempt.elapsed * 1000) / 1000;
            let value = seconds,
                label = `${seconds.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} s`,
                type = 'survival';
            if (countGames.has(attempt.gameId)) {
                value = Math.floor(clamp(m.score, 0, attempt.elapsed * 250 + 30));
                const unit = {
                    rhythm: 'expulsões',
                    paddle: 'rebatidas',
                    shelter: 'bloqueios',
                    slash: 'cortes',
                    juggle: 'afastamentos',
                    climb: 'plataformas',
                    gravity: 'colunas',
                }[attempt.gameId];
                label = `${value} ${unit}`;
                type = 'count';
            } else if (courseGames.has(attempt.gameId)) {
                type = 'course';
                value = attempt.outcome === 'won' ? seconds : clamp(m.progress, 0, 0.999);
                label = attempt.outcome === 'won' ? label : `${Math.round(value * 100)}% do percurso`;
            }
            attempt.score = { value, label, type, rules: rulesKey(attempt) };
            this.record({ kind: 'attempt', attempt });
            attempt = this.attempts.get(attempt.id);
            if (a.source !== 'manual') this.cooldowns.set(a.userKey, this.now() + this.cooldownFor(a));
        }
        const pending = this.pending.get(peerId);
        if (pending) pending.phase = 'assigned';
        this.changed(a.roomId);
        return { ...result, attempt, ranking: this.ranking(peerId, attempt.gameId) };
    }
    cancelPending(peerId, reason) {
        const p = this.pending.get(peerId);
        if (!p) return false;
        this.pending.delete(peerId);
        this.cooldowns.set(p.userKey, this.now() + this.cooldownFor(p));
        this.record({ kind: 'released', id: p.id, roomId: p.roomId, name: p.name, reason, attempts: 0 });
        this.changed(p.roomId);
        return true;
    }
    release(peerId, reason = 'released') {
        const a = this.active.get(peerId);
        const removed = this.cancelPending(peerId, reason);
        const result = super.release(peerId, reason);
        if (a && reason !== 'next_game') this.cooldowns.set(a.userKey, this.now() + this.cooldownFor(a));
        if (a) this.changed(a.roomId);
        return { released: result.released || removed };
    }
    profile(peerId, value) {
        const { key, peer, roomId } = this.context(peerId);
        if (value !== undefined) {
            if (typeof value !== 'string' || !/^[a-zA-Z0-9]{1,3}$/.test(value))
                throw fault('Use de uma a três letras ou números para sua sigla.');
            this.record({ kind: 'profile', profile: { key, initials: initials(value) } });
            this.changed(roomId);
        }
        return this.profiles.get(key) || { key, initials: initials(peer.peer_name) };
    }
    ranking(peerId, gameId) {
        const { roomId, key } = this.context(peerId),
            game = this.catalog.find((g) => g.id === gameId),
            settings = this.settings.games[gameId];
        if (!game || !settings) throw fault('Jogo indisponível.');
        const config = {
                id: game.id,
                title: game.title,
                revision: game.revision,
                duration: settings.duration,
                intensity: settings.intensity,
            },
            currentRules = rulesKey(config);
        const best = new Map();
        const compare = (a, b) => {
            if (a.score.type === 'course') {
                if (a.outcome !== b.outcome) return a.outcome === 'won' ? -1 : 1;
                return a.outcome === 'won' ? a.score.value - b.score.value : b.score.value - a.score.value;
            }
            return b.score.value - a.score.value;
        };
        for (const a of this.attempts.values()) {
            if (
                a.roomId !== roomId ||
                a.gameId !== gameId ||
                !a.score ||
                !['won', 'lost'].includes(a.outcome) ||
                a.score.rules !== currentRules
            )
                continue;
            const prior = best.get(a.userKey);
            if (!prior || compare(a, prior) < 0) best.set(a.userKey, a);
        }
        let rank = 0,
            last;
        const rows = [...best.values()].sort(compare).map((a, i) => {
            if (!last || compare(a, last) !== 0) rank = i + 1;
            last = a;
            return {
                rank,
                initials: this.profiles.get(a.userKey)?.initials || initials(a.name),
                name: a.name,
                value: a.score.value,
                label: a.score.label,
                mine: a.userKey === key,
                attemptId: a.id,
            };
        });
        return { gameId, config, rows: rows.slice(0, 30), mine: rows.find((r) => r.mine) || null, total: rows.length };
    }
    openVote({
        roomId,
        peerId,
        gameId = 'random',
        mode = 'percent',
        required = 30,
        seconds = this.policy.voteSeconds,
        authorPeerId,
    }) {
        if (!this.canTarget(roomId, peerId))
            throw fault('Participante indisponível ou no intervalo de proteção.', 'BUSY');
        const targetKey = this.identity(roomId, peerId),
            authorKey = authorPeerId ? this.identity(roomId, authorPeerId) : null;
        const duplicate = [...this.votes.values()].find(
            (v) => v.roomId === roomId && v.targetKey === targetKey && ['open', 'queued'].includes(v.status)
        );
        if (duplicate) {
            if (authorPeerId && duplicate.status === 'open')
                this.castVote(authorPeerId, { voteId: duplicate.id, choice: 'yes' });
            return this.publicVote(duplicate);
        }
        this.choose(gameId);
        if (
            !['percent', 'count'].includes(mode) ||
            !Number.isFinite(Number(required)) ||
            Number(required) < 1 ||
            Number(required) > (mode === 'percent' ? 99 : this.uniquePeers(roomId).length)
        )
            throw fault('Regra de votação inválida.');
        if (!Number.isFinite(Number(seconds)) || seconds < 10 || seconds > 120)
            throw fault('Prazo de votação inválido.');
        const unfinished = [...this.votes.values()].filter(
            (v) => v.roomId === roomId && ['open', 'queued'].includes(v.status)
        );
        if (authorKey) {
            if (!this.settings.interactions.participantVotes)
                throw fault('As propostas de participantes estão desativadas.');
            if ((this.proposalAt.get(authorKey) || 0) > this.now())
                throw fault('Aguarde antes de propor outra votação.', 'COOLDOWN');
            if (unfinished.some((v) => v.authorKey === authorKey))
                throw fault('Você já tem uma proposta ativa ou na fila.', 'BUSY');
        }
        if (unfinished.filter((v) => v.status === 'queued').length >= this.policy.queueLimit)
            throw fault('A fila está cheia. Aguarde a próxima votação.', 'QUEUE_FULL');
        const v = {
            id: randomUUID(),
            roomId,
            peerId,
            targetKey,
            name: String(this.member(roomId, peerId).peer_name),
            gameId,
            mode,
            required: Number(required),
            seconds: Number(seconds),
            authorKey,
            authorName: authorPeerId ? String(this.member(roomId, authorPeerId).peer_name) : 'Líder',
            eligible: [],
            choices: {},
            status: 'queued',
            createdAt: this.now(),
            expiresAt: this.now() + this.policy.queueMs,
            threshold: null,
        };
        this.votes.set(v.id, v);
        if (authorKey) this.proposalAt.set(authorKey, this.now() + this.policy.proposalCooldownMs);
        this.publishVote(v);
        this.advanceVotes(roomId);
        return this.publicVote(v);
    }
    advanceVotes(roomId) {
        if (
            (this.nextVoteAt.get(roomId) || 0) > this.now() ||
            [...this.votes.values()].some((v) => v.roomId === roomId && v.status === 'open')
        )
            return;
        const queue = [...this.votes.values()].filter((v) => v.roomId === roomId && v.status === 'queued');
        for (const v of queue) {
            const members = this.uniquePeers(roomId);
            if (
                v.expiresAt <= this.now() ||
                !this.canTarget(roomId, v.peerId) ||
                (v.authorKey && !members.some((p) => p.key === v.authorKey))
            ) {
                this.cancelVote(v.id, 'unavailable');
                continue;
            }
            v.eligible = members.map((p) => p.key);
            v.threshold = v.mode === 'count' ? v.required : Math.floor((v.eligible.length * v.required) / 100) + 1;
            if (v.threshold > v.eligible.length) {
                this.cancelVote(v.id, 'unreachable');
                continue;
            }
            v.status = 'open';
            v.expiresAt = this.now() + v.seconds * 1000;
            if (v.authorKey) v.choices[v.authorKey] = 'yes';
            this.publishVote(v, true);
            if (Object.values(v.choices).filter((c) => c === 'yes').length >= v.threshold) this.approve(v);
            break;
        }
    }
    publicVote(v) {
        const base = super.publicVote(v);
        return {
            ...base,
            authorName: v.authorName,
            queuePosition:
                v.status === 'queued'
                    ? [...this.votes.values()]
                          .filter((x) => x.roomId === v.roomId && x.status === 'queued')
                          .findIndex((x) => x.id === v.id) + 1
                    : null,
            mode: v.mode,
            required: v.required,
        };
    }
    sendVote(v, id, announce = false) {
        const peer = this.member(v.roomId, id);
        if (!peer) return;
        const key = this.userKey(v.roomId, peer);
        this.emit(id, 'captchaVote', {
            ...this.publicVote(v),
            eligible: v.eligible.includes(key),
            choice: v.choices[key] || null,
            announce,
        });
    }
    publishVote(v, announce = false) {
        for (const [id] of this.peers(v.roomId)) this.sendVote(v, id, announce);
        this.record({ kind: 'vote', vote: this.publicVote(v) });
        this.changed(v.roomId);
    }
    cancelVote(id, reason = 'cancelled') {
        const v = this.votes.get(id);
        if (v && ['open', 'queued'].includes(v.status)) {
            if (v.status === 'open') this.nextVoteAt.set(v.roomId, this.now() + this.policy.voteGapMs);
            v.status = reason;
            this.publishVote(v);
        }
        return { cancelled: true };
    }
    approve(v) {
        v.status = 'approved';
        try {
            this.trigger({ roomId: v.roomId, peerId: v.peerId, gameId: v.gameId, source: 'vote' });
        } catch {
            v.status = 'unavailable';
        }
        this.nextVoteAt.set(v.roomId, this.now() + this.policy.voteGapMs);
        this.publishVote(v);
    }
    castVote(peerId, data) {
        const v = this.votes.get(data.voteId);
        if (!v || v.status !== 'open' || v.expiresAt <= this.now()) throw fault('Votação encerrada.', 'STALE');
        const key = this.identity(v.roomId, peerId);
        if (!v.eligible.includes(key)) throw fault('Você não participa desta votação.', 'FORBIDDEN');
        if (!['yes', 'no'].includes(data.choice)) throw fault('Voto inválido.');
        if (v.choices[key]) return this.publicVote(v);
        v.choices[key] = data.choice;
        if (Object.values(v.choices).filter((c) => c === 'yes').length >= v.threshold) this.approve(v);
        else this.publishVote(v);
        return this.publicVote(v);
    }
    userState(peerId) {
        const { roomId, key } = this.context(peerId),
            active = this.active.get(peerId),
            pending = this.pending.get(peerId);
        return {
            version: this.version,
            enabled: this.enabled,
            selfId: peerId,
            profile: this.profile(peerId),
            busyElsewhere: !!this.occupied(key) && this.occupied(key).peerId !== peerId,
            catalog: this.catalog.map((g) => ({
                ...g,
                config: this.settings.games[g.id]?.enabled ? this.config(g.id) : null,
            })),
            active: active ? this.publicAssignment(active) : null,
            pending: pending ? this.publicAssignment(pending) : null,
            users: this.uniquePeers(roomId).map((p) => ({
                id: p.id,
                name: String(p.peer.peer_name || 'Participante'),
                ready: this.capable.has(p.id),
                canChallenge: this.canTarget(roomId, p.id),
                mine: p.key === key,
            })),
            votes: [...this.votes.values()]
                .filter((v) => v.roomId === roomId && ['open', 'queued'].includes(v.status))
                .map((v) => ({
                    ...this.publicVote(v),
                    eligible: v.eligible.includes(key),
                    choice: v.choices[key] || null,
                })),
            participantVotes: this.settings.interactions.participantVotes,
            rules: { percentage: 30, strict: true, ...this.policy },
            storageError: this.storageError,
        };
    }
    bind(socket, getRoom) {
        super.bind(socket, getRoom);
        if (!this.enabled) {
            for (const event of ['playHello', 'playState'])
                socket.on(event, (_, callback) => {
                    if (typeof callback === 'function') callback({ enabled: false });
                });
            return;
        }
        const handler = (event, fn, mutates = false) =>
            socket.on(event, (data, callback) => {
                if (typeof callback !== 'function') return;
                try {
                    const { key } = this.context(socket.id);
                    const d = data && typeof data === 'object' ? data : {};
                    let cacheKey;
                    if (mutates) {
                        if (typeof d.requestId !== 'string' || !/^[\w-]{1,80}$/.test(d.requestId))
                            throw fault('Solicitação inválida.');
                        cacheKey = `${key}:${event}:${d.requestId}`;
                        const cached = this.requests.get(cacheKey);
                        if (cached && cached.until > this.now())
                            return callback({ ...cached.value, state: this.userState(socket.id) });
                    }
                    const value = fn(d) || {};
                    const reply = { ...value, ...(mutates ? { state: this.userState(socket.id) } : {}) };
                    if (cacheKey)
                        this.requests.set(cacheKey, {
                            until: this.now() + 300000,
                            value: JSON.parse(JSON.stringify(reply)),
                        });
                    callback(reply);
                } catch (error) {
                    callback({ error: error.message, code: error.code || 'INVALID_REQUEST' });
                }
            });
        handler('playHello', () => {
            this.capable.add(socket.id);
            this.changed(this.context(socket.id).roomId);
            return this.userState(socket.id);
        });
        handler('playState', () => this.userState(socket.id));
        handler('playManualStart', (d) => ({ assignment: this.manual(socket.id, d.gameId) }), true);
        handler('playActivate', () => ({ assignment: this.activate(socket.id) }), true);
        handler('playClose', () => this.release(socket.id, 'closed'), true);
        handler('playPause', (d) => this.pause(socket.id, d.assignmentId, !!d.paused), true);
        handler(
            'playPropose',
            (d) => {
                const { roomId } = this.context(socket.id);
                return {
                    vote: this.openVote({
                        roomId,
                        peerId: d.peerId,
                        gameId: d.gameId || 'random',
                        authorPeerId: socket.id,
                    }),
                };
            },
            true
        );
        handler('playProfile', (d) => ({ profile: this.profile(socket.id, d.initials) }), true);
        handler('playRanking', (d) => this.ranking(socket.id, d.gameId));
        socket.on('disconnect', () => this.changed());
    }
    tick() {
        if (!this.enabled) return;
        for (const [id, p] of this.pending)
            if (!this.member(p.roomId, id) || p.expiresAt <= this.now()) this.cancelPending(id, 'expired');
        for (const [id, a] of this.active)
            if (!this.member(a.roomId, id) || a.expiresAt <= this.now()) this.release(id, 'expired');
        for (const v of this.votes.values()) {
            if (!['open', 'queued'].includes(v.status)) continue;
            if (!this.member(v.roomId, v.peerId)) this.cancelVote(v.id, 'target_left');
            else if (v.expiresAt <= this.now()) this.cancelVote(v.id, 'expired');
            else if (v.status === 'open') {
                const online = new Set(this.uniquePeers(v.roomId).map((p) => p.key));
                const yes = Object.values(v.choices).filter((c) => c === 'yes').length;
                const undecided = v.eligible.filter((k) => online.has(k) && !v.choices[k]).length;
                if (yes + undecided < v.threshold) this.cancelVote(v.id, 'unreachable');
            }
        }
        for (const roomId of this.rooms.keys()) this.advanceVotes(roomId);
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
                /* UI only. */
            }
            this.nextRandom.set(id, this.nextTime(settings));
        }
        for (const [id, v] of this.votes)
            if (!['open', 'queued'].includes(v.status) && this.now() - v.createdAt > 300000) this.votes.delete(id);
        for (const [key, r] of this.requests) if (r.until <= this.now()) this.requests.delete(key);
        for (const [key, until] of this.cooldowns) if (until <= this.now()) this.cooldowns.delete(key);
        for (const [key, until] of this.proposalAt) if (until <= this.now()) this.proposalAt.delete(key);
        while (this.requests.size > 4000) this.requests.delete(this.requests.keys().next().value);
    }
    snapshot() {
        const result = super.snapshot();
        result.settings = this.settings;
        result.active.push(
            ...[...this.pending.values()].map((p) => ({ ...this.publicAssignment(p), peerId: p.peerId, name: p.name }))
        );
        for (const room of result.rooms) {
            const unique = new Set(this.uniquePeers(room.id).map((p) => p.id));
            room.users = room.users.filter((user) => unique.has(user.id));
            for (const user of room.users) {
                user.source = this.active.get(user.id)?.source || null;
                user.pending = this.pending.has(user.id);
                user.canChallenge = this.canTarget(room.id, user.id);
            }
        }
        return result;
    }
}
module.exports = { RoomPlayControl, RULES };
