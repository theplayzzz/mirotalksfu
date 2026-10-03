'use strict';

/*
 * Everything between the room and the recorder that is not mediasoup (that is ReplayBridge): the socket events of
 * docs/REPLAY.md section 6, the state the browsers see (which screens are being kept and for how long), the events the
 * recorder reports, and the Server-Sent Events of the gallery.
 *
 * Nothing in here throws into the room: a recorder that is down or slow only means that replay is not offered.
 */

const crypto = require('node:crypto');

const MIN_SECONDS = 10;
const REQUEST_EVERY_MS = 3000;
const BUFFERS_EVERY_MS = 5000;
const ANNOUNCED_KEEP_MS = 10 * 60 * 1000;
const MAX_SSE_CLIENTS = 200;

class ReplayError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

class ReplayHub {
    /**
     * @param {object} o
     * @param {object} o.io socket.io server
     * @param {ReplayAccess} o.access
     * @param {ReplayClient} o.client
     * @param {function} o.getRoom (roomId) => Room | undefined
     * @param {object} [o.settings] { maxSeconds, options, uiEnabled }
     * @param {object} [o.log]
     * @param {function} [o.now]
     */
    constructor({ io, access, client, getRoom, settings = {}, log = console, now = Date.now }) {
        this.io = io;
        this.access = access;
        this.client = client;
        this.getRoom = getRoom;
        this.log = log;
        this.now = now;
        this.settings = {
            maxSeconds: 300,
            options: [60, 120, 180, 300],
            uiEnabled: true,
            ...settings,
        };

        this.bridge = null; // set when the bridge is up
        this.buffers = new Map(); // shareId -> { bufferSeconds, codec, hasAudio } as reported by the recorder
        this.sseClients = new Set();
        this.announcedRooms = new Set(); // rooms that were last told about at least one screen
        this.lastRequestAt = new Map(); // socket id -> time
        this.announced = new Map(); // clip id -> time, so a clip is announced to the room once
        this.requests = new Map(); // requestId -> { socketId, uuid, at }
        this.changeTimer = null;
        this.timer = null;
    }

    attachBridge(bridge) {
        this.bridge = bridge;
        bridge.on('changed', () => this.scheduleBuffers());
        bridge.on('availability', () => this.scheduleBuffers());
        this.timer = setInterval(() => this.broadcastBuffers(), BUFFERS_EVERY_MS);
        this.timer.unref?.();
    }

    // What the browsers are told in /config
    publicConfig() {
        return {
            enabled: Boolean(this.settings.uiEnabled && this.bridge),
            maxSeconds: this.settings.maxSeconds,
            options: this.settings.options.filter((seconds) => seconds <= this.settings.maxSeconds),
        };
    }

    // ---- the room ---------------------------------------------------------------------------------------------------

    /*
     * A person is in the room: gives them a ticket for the gallery cookie and the current state, and listens to their
     * replayRequest. It is called from every way a person gets in (the join itself, and the first thing a person who
     * joined a locked room or waited in the lobby asks for, because their join was not answered with the room), so it
     * does its work once per socket.
     */
    attachSocket(socket, room, peer) {
        if (!this.bridge || socket.replayAttached) return;
        socket.replayAttached = true;
        const ticket = this.access.issueTicket();
        socket.emit('replayTicket', ticket);
        socket.emit('replayBuffers', this.buffersPayload(room.id));

        socket.on('replayRequest', async (data, callback) => {
            const reply = typeof callback === 'function' ? callback : () => {};
            try {
                reply(await this.requestClip({ socket, room, peer, producerId: data && data.producerId, seconds: data && data.seconds }));
            } catch (error) {
                reply({ error: error.message, code: error.code || 'ERROR' });
            }
        });
    }

    detachSocket(socket) {
        this.lastRequestAt.delete(socket.id);
    }

    /*
     * A producer was created. Screens (and the audio that belongs to a screen) go to the recorder; everything else is
     * ignored. Never awaited by the live path.
     */
    onProduce({ room, peer, producerId, kind, appData }) {
        if (!this.bridge || !room || !peer) return;
        const producer = peer.producers && peer.producers.get(producerId);
        if (!producer) return;
        const peerUuid = peer.peer_info && peer.peer_info.peer_uuid;

        try {
            if (kind === 'video' && appData && appData.mediaType === 'screenType') {
                this.bridge.addScreen({ roomId: room.id, router: room.router, peerName: peer.peer_name, peerUuid, producer });
            } else if (kind === 'audio' && appData && appData.source === 'screen' && typeof appData.shareOf === 'string') {
                // Only the audio of a screen of the same person counts
                const screen = peer.producers.get(appData.shareOf);
                if (screen && screen.appData && screen.appData.mediaType === 'screenType') {
                    this.bridge.addScreenAudio({ shareId: screen.id, router: room.router, producer });
                }
            }
        } catch (error) {
            this.log.warn(`replay: could not start recording a producer: ${error.message}`);
        }
    }

    // ---- what the browsers see --------------------------------------------------------------------------------------

    buffersPayload(roomId) {
        const available = Boolean(this.bridge && this.bridge.available);
        const shares = [];
        if (this.bridge) {
            for (const share of this.bridge.list()) {
                if (share.roomId !== roomId) continue;
                const reported = this.buffers.get(share.shareId);
                // until the recorder reports (every 5 s) the time since the screen started is the best guess
                const estimate = Math.max(0, (this.now() - share.startedAt) / 1000 - 3);
                shares.push({
                    producerId: share.shareId,
                    peerName: share.peerName,
                    bufferSeconds: Math.min(this.settings.maxSeconds, Math.floor(reported ? reported.bufferSeconds : estimate)),
                    codec: share.codec,
                    hasAudio: reported ? Boolean(reported.hasAudio) : share.hasAudio,
                });
            }
        }
        const payload = { available, maxSeconds: this.settings.maxSeconds, shares };
        if (!available && this.bridge) payload.reason = this.bridge.reason || 'unavailable';
        return payload;
    }

    roomsWithShares() {
        const ids = new Set();
        if (this.bridge) for (const share of this.bridge.list()) ids.add(share.roomId);
        return ids;
    }

    sendToRoom(room, event, data) {
        if (!room) return;
        for (const [socketId, peer] of room.getPeers()) {
            if (peer && peer.peer_lobby === true) continue;
            this.io.to(socketId).emit(event, data);
        }
    }

    // Tells every room what is being kept. A room whose last screen just stopped is told once more, with an empty list:
    // otherwise its people would keep the screen that ended in their list for ever.
    broadcastBuffers() {
        if (!this.bridge) return;
        const rooms = new Set([...this.roomsWithShares(), ...this.announcedRooms]);
        this.announcedRooms = new Set();
        for (const roomId of rooms) {
            const payload = this.buffersPayload(roomId);
            this.sendToRoom(this.getRoom(roomId), 'replayBuffers', payload);
            if (payload.shares.length) this.announcedRooms.add(roomId);
        }
    }

    // Many small changes (a screen starts, its audio joins) become one message
    scheduleBuffers() {
        if (this.changeTimer) return;
        this.changeTimer = setTimeout(() => {
            this.changeTimer = null;
            this.broadcastBuffers();
        }, 250);
        this.changeTimer.unref?.();
    }

    // ---- a clip is asked for ----------------------------------------------------------------------------------------

    async requestClip({ socket, room, peer, producerId, seconds }) {
        if (!this.bridge || !this.bridge.available) throw new ReplayError('Replay is not available now', 'UNAVAILABLE');
        if (!peer || peer.peer_lobby === true) throw new ReplayError('Not allowed', 'NOT_ALLOWED');

        const share = typeof producerId === 'string' ? this.bridge.list().find((item) => item.shareId === producerId && item.roomId === room.id) : null;
        if (!share) throw new ReplayError('That screen is not being kept', 'NO_SUCH_SHARE');

        const length = Number(seconds);
        if (!Number.isInteger(length) || length < MIN_SECONDS || length > this.settings.maxSeconds) {
            throw new ReplayError('Invalid length', 'BAD_SECONDS');
        }

        const now = this.now();
        if (now - (this.lastRequestAt.get(socket.id) || 0) < REQUEST_EVERY_MS) {
            throw new ReplayError('Wait a moment before asking again', 'RATE_LIMIT');
        }
        this.lastRequestAt.set(socket.id, now);

        const requestId = crypto.randomBytes(8).toString('hex');
        const uuid = peer.peer_info && peer.peer_info.peer_uuid;
        this.requests.set(requestId, { socketId: socket.id, uuid, at: now });

        // the answer to the browser does not wait for the clip
        this.buildClip({ requestId, socket, room, peer, share, seconds: length, uuid }).catch((error) => {
            this.log.error(`replay: building a clip failed: ${error.message}`);
        });
        return { ok: true, requestId };
    }

    async buildClip({ requestId, socket, room, peer, share, seconds, uuid }) {
        const status = (data) => this.io.to(socket.id).emit('replayStatus', { requestId, ...data });
        status({ state: 'preparing' });
        try {
            const clip = await this.client.createClip({
                shareId: share.shareId,
                seconds,
                requestedByName: peer.peer_name,
                requestedByHash: this.access.hashPeer(uuid),
                sharerHash: this.access.hashPeer(share.peerUuid),
                requestId,
            });
            status({ state: 'done', clip: this.access.publicClip(clip, uuid) });
            this.announce(clip, { room, requestedBy: peer.peer_name, sharerSocketId: this.findSocketOf(room, share.peerUuid) });
        } catch (error) {
            this.log.warn(`replay: clip request failed: ${error.message}`);
            status({ state: 'error', code: error.code || 'ERROR' });
        } finally {
            this.requests.delete(requestId);
        }
    }

    findSocketOf(room, peerUuid) {
        for (const [socketId, peer] of room.getPeers()) {
            if (peer.peer_info && peer.peer_info.peer_uuid === peerUuid) return socketId;
        }
        return null;
    }

    // Tells the room, once per clip
    announce(clip, { room, requestedBy, sharerSocketId = null }) {
        const now = this.now();
        for (const [id, at] of this.announced) {
            if (now - at > ANNOUNCED_KEEP_MS) this.announced.delete(id);
        }
        if (this.announced.has(clip.id)) return;
        this.announced.set(clip.id, now);
        // `mine` depends on who asks, so it is left out of what is pushed to everybody
        const { mine, ...publicClip } = this.access.publicClip(clip, '');
        this.sendToRoom(room, 'replayCreated', { clip: publicClip, requestedBy: requestedBy || clip.requestedBy || '', sharerPeerId: sharerSocketId });
        this.sseSend('clip.created', { clip: publicClip });
    }

    // ---- events from the recorder -----------------------------------------------------------------------------------

    handleRecorderEvent(event) {
        if (!event || typeof event.type !== 'string') return;
        switch (event.type) {
            case 'clip.created': {
                if (!event.clip || typeof event.clip.id !== 'string') return;
                // normally already announced when the request was answered; this covers a clip made any other way
                const room = this.getRoom(event.clip.roomId);
                if (!this.announced.has(event.clip.id)) {
                    this.announce(event.clip, { room, requestedBy: event.clip.requestedBy });
                }
                break;
            }
            case 'clip.deleted':
                this.sseSend('clip.deleted', { id: event.id });
                break;
            case 'mp4.progress':
            case 'mp4.ready':
            case 'mp4.error': {
                const { type, ...payload } = event;
                this.sseSend(type, payload);
                break;
            }
            case 'buffers':
                this.buffers.clear();
                for (const share of Array.isArray(event.shares) ? event.shares : []) {
                    if (share && typeof share.shareId === 'string') this.buffers.set(share.shareId, share);
                }
                this.broadcastBuffers();
                break;
            default:
                break;
        }
    }

    // ---- Server-Sent Events of the gallery --------------------------------------------------------------------------

    subscribe(req, res) {
        if (this.sseClients.size >= MAX_SSE_CLIENTS) return res.status(503).end();
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.write('retry: 5000\n\n');
        res.flush?.();
        this.sseClients.add(res);

        const heartbeat = setInterval(() => {
            res.write(': ping\n\n');
            res.flush?.();
        }, 25000);
        req.on('close', () => {
            clearInterval(heartbeat);
            this.sseClients.delete(res);
        });
    }

    sseSend(type, payload) {
        if (!this.sseClients.size) return;
        const chunk = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
        for (const res of this.sseClients) {
            res.write(chunk);
            res.flush?.(); // the compression middleware buffers otherwise
        }
    }

    async stop() {
        clearInterval(this.timer);
        clearTimeout(this.changeTimer);
        for (const res of this.sseClients) res.end();
        this.sseClients.clear();
    }
}

module.exports = { ReplayHub, ReplayError, MIN_SECONDS, REQUEST_EVERY_MS };
