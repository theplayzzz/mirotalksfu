'use strict';

/*
 * The SFU's side of the replay recorder (docs/REPLAY.md, section 6): one more silent viewer of every shared screen,
 * living on a mediasoup worker of its own, whose output goes to the recorder container as plain RTP.
 *
 *   room router --pipe--> recorder router --PlainTransport (RTP + RTCP on one UDP socket)--> recorder container
 *
 * Why a worker of its own: the packets the recorder needs (NACK answers, key frame requests, RTCP) are handled there and
 * the room's worker, the one that saturates when many people watch, only sends one extra copy of each screen to a
 * local pipe. If the recorder worker dies, only the replay stops. Nothing here is ever awaited by the live path:
 * Server.js starts it after the producer exists and ignores the outcome.
 *
 * Safety: every few seconds the CPU of the room workers and the recorder's free disk are looked at. Above 85% for 10 s
 * (or a full disk, or a recorder that does not answer) the recorder's consumers are paused and the room is told that
 * replay is unavailable, until the load is under 70% for 20 s. The live path always wins.
 */

const dns = require('node:dns').promises;
const os = require('node:os');
const EventEmitter = require('node:events');

const DEFAULTS = {
    bindIp: '0.0.0.0', // the plain transports; the ports are not published outside the Docker network
    portMin: 52000,
    portMax: 52999,
    pipeIp: '127.0.0.1',
    pipePortMin: 51000,
    pipePortMax: 51999,
    sampleEveryMs: 5000,
    cpuHighPercent: 85,
    cpuLowPercent: 70,
    cpuHighForMs: 10000,
    cpuLowForMs: 20000,
    minFreeGb: 10,
    recorderFailures: 3, // samples in a row without an answer from the recorder
    keyFrameSafetyS: 0, // 0 = never ask for key frames (the first one is requested by mediasoup when the consumer starts)
    niceness: 10, // the recorder worker yields to the room's workers
};

const isRtx = (codec) => /\/rtx$/i.test(codec.mimeType);

/*
 * What the recorder tells mediasoup it can receive: the router's codecs, but NO bandwidth estimation (transport-cc and
 * goog-remb feedback) and no header extensions. The recorder never sends transport-wide feedback. When mediasoup is
 * told that a consumer takes part in bandwidth estimation, it keeps an estimate for the transport that starts at 600
 * kbps and, without feedback, never grows: the consumer is throttled to it (a screen with motion needs 5-12 Mbps), the
 * recorder gets a few seconds of picture and then only probing packets, and mediasoup asks the sender for a new
 * full picture again and again to get the consumer going (found 2026-10-03: a "time kept" stuck at 2-3 s on every
 * screen with real motion, and a key frame every second for the person sharing). Nack and PLI stay: the recorder uses them.
 */
function recorderCapabilities(routerCapabilities) {
    const bandwidth = new Set(['transport-cc', 'goog-remb']);
    return {
        codecs: (routerCapabilities.codecs || []).map((codec) => ({
            ...codec,
            rtcpFeedback: (codec.rtcpFeedback || []).filter((feedback) => !bandwidth.has(feedback.type)),
        })),
        headerExtensions: [],
    };
}

// What the recorder has to know about one stream a consumer sends it
function describeStream(consumer) {
    const { codecs, encodings } = consumer.rtpParameters;
    const media = codecs.find((codec) => !isRtx(codec));
    const rtxCodec = codecs.find(isRtx);
    const encoding = encodings[0];
    if (!media || !encoding || !encoding.ssrc) throw new Error('The consumer has no media codec or no SSRC');

    const stream = {
        codec: media.mimeType,
        payloadType: media.payloadType,
        ssrc: encoding.ssrc,
        clockRate: media.clockRate,
    };
    if (media.channels) stream.channels = media.channels;
    const fmtp = Object.entries(media.parameters || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(';');
    if (fmtp) stream.fmtp = fmtp;
    if (rtxCodec && encoding.rtx && encoding.rtx.ssrc) {
        stream.rtx = { ssrc: encoding.rtx.ssrc, payloadType: rtxCodec.payloadType };
    }
    return stream;
}

/*
 * Should the recorder be recording right now? Pure: the old state, what was just measured and the settings give the
 * new state, so it can be tested without a clock or a server.
 *   state:  { available, reason, highSince, lowSince, failures }
 *   sample: { cpuPercent (highest of the room workers, or null), diskFreeGb (or null), recorderOk }
 */
function decideAvailability(state, sample, options, now) {
    const next = { ...state };
    const { cpuPercent, diskFreeGb, recorderOk } = sample;

    next.failures = recorderOk ? 0 : state.failures + 1;
    const recorderDown = next.failures >= options.recorderFailures;
    const diskFull = diskFreeGb !== null && diskFreeGb !== undefined && diskFreeGb < options.minFreeGb;

    // load: high for long enough stops it, low for long enough lets it come back (hysteresis)
    if (cpuPercent !== null && cpuPercent > options.cpuHighPercent) {
        next.highSince = state.highSince || now;
    } else {
        next.highSince = 0;
    }
    if (cpuPercent !== null && cpuPercent < options.cpuLowPercent) {
        next.lowSince = state.lowSince || now;
    } else {
        next.lowSince = 0;
    }
    const overloaded = next.highSince && now - next.highSince >= options.cpuHighForMs;
    const calm = next.lowSince && now - next.lowSince >= options.cpuLowForMs;

    if (state.available) {
        if (recorderDown) return { ...next, available: false, reason: 'recorder' };
        if (diskFull) return { ...next, available: false, reason: 'disk' };
        if (overloaded) return { ...next, available: false, reason: 'load' };
        return next;
    }

    // unavailable: it comes back when whatever stopped it is over
    if (state.reason === 'recorder' && !recorderDown && !diskFull) return { ...next, available: true, reason: null };
    if (state.reason === 'disk' && recorderOk && !diskFull && diskFreeGb >= options.minFreeGb + 1) {
        return { ...next, available: true, reason: null };
    }
    if (state.reason === 'load' && calm && !diskFull && !recorderDown) return { ...next, available: true, reason: null };
    return next;
}

class ReplayBridge extends EventEmitter {
    /**
     * @param {object} o
     * @param {object} o.mediasoup the mediasoup module
     * @param {object} [o.workerSettings] logLevel, logTags
     * @param {Array} o.mediaCodecs the codecs of the rooms' routers
     * @param {ReplayClient} o.client the recorder control API
     * @param {object} [o.options] see DEFAULTS
     * @param {object} [o.log]
     * @param {function} [o.roomWorkers] () => the workers the rooms run on (their load is watched)
     * @param {function} [o.resolve] (host) => ip address of the recorder
     * @param {function} [o.now]
     */
    constructor({ mediasoup, workerSettings = {}, mediaCodecs, client, options = {}, log = console, roomWorkers = () => [], resolve, now = Date.now }) {
        super();
        this.mediasoup = mediasoup;
        this.workerSettings = workerSettings;
        this.mediaCodecs = mediaCodecs;
        this.client = client;
        // a setting that is undefined (not set in the environment) keeps its default
        this.options = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
        this.log = log;
        this.roomWorkers = roomWorkers;
        this.resolve = resolve || ((host) => dns.lookup(host, { family: 4 }).then((found) => found.address));
        this.now = now;

        this.worker = null;
        this.router = null;
        this.recorderCaps = null;
        this.shares = new Map(); // shareId (= id of the screen's video producer) -> share
        this.state = { available: false, reason: 'starting', highSince: 0, lowSince: 0, failures: 0 };
        this.cpuSamples = new Map();
        this.cpuPercent = null;
        this.diskFreeGb = null;
        this.timer = null;
        this.stopped = false;
    }

    get available() {
        return this.state.available;
    }

    get reason() {
        return this.state.reason;
    }

    async start() {
        await this.createWorker();
        this.state = { ...this.state, available: true, reason: null };
        this.timer = setInterval(() => this.sample().catch((error) => this.log.warn(`replay: sample failed: ${error.message}`)), this.options.sampleEveryMs);
        this.timer.unref?.();
        this.log.info('replay: bridge started', { workerPid: this.worker.pid });
    }

    async createWorker() {
        this.worker = await this.mediasoup.createWorker({
            logLevel: this.workerSettings.logLevel || 'warn',
            logTags: this.workerSettings.logTags || [],
            disableLiburing: Boolean(this.workerSettings.disableLiburing),
        });
        try {
            os.setPriority(this.worker.pid, this.options.niceness);
        } catch (error) {
            this.log.warn(`replay: could not lower the priority of the recorder worker: ${error.message}`);
        }
        this.router = await this.worker.createRouter({ mediaCodecs: this.mediaCodecs });
        this.recorderCaps = recorderCapabilities(this.router.rtpCapabilities);

        this.worker.once('died', () => {
            // Only the replay stops. The rooms' workers have their own handler that restarts the whole server.
            this.log.error('replay: the recorder worker died, replay is off until the server restarts');
            this.worker = null;
            this.router = null;
            this.setAvailability({ available: false, reason: 'worker' });
            for (const id of [...this.shares.keys()]) this.closeShare(id, 'worker died');
        });
    }

    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        for (const id of [...this.shares.keys()]) await this.closeShare(id, 'bridge stopped');
        try {
            this.worker?.close();
        } catch (error) {
            // already closed
        }
    }

    // ---- shares ---------------------------------------------------------------------------------------------------

    /*
     * A screen started. `router` is the room's router the producer lives on. Returns a promise that settles when the
     * recorder is receiving (or when it failed); the caller does not need to wait for it.
     */
    addScreen({ roomId, router, peerName, peerUuid, producer }) {
        const id = producer.id;
        if (this.shares.has(id)) return this.shares.get(id).ready;
        if (!this.router) return Promise.resolve();

        const share = {
            id,
            roomId,
            peerName,
            peerUuid,
            producer,
            roomRouter: router,
            transport: null,
            consumers: {},
            audioProducer: null,
            hasAudio: false,
            codec: null,
            port: 0,
            registeredAt: 0,
            paused: false,
            closed: false,
            startedAt: this.now(),
            chain: Promise.resolve(),
            ready: null,
            keyFrameTimer: null,
        };
        this.shares.set(id, share);
        producer.observer.once('close', () => this.closeShare(id, 'producer closed'));

        share.ready = this.enqueue(share, () => this.startShare(share));
        return share.ready;
    }

    /* The audio of a screen (the sharer ticked "share audio"): joins the share of its video */
    addScreenAudio({ shareId, router, producer }) {
        const share = this.shares.get(shareId);
        if (!share || share.closed) return Promise.resolve();
        return this.enqueue(share, () => this.startAudio(share, router, producer));
    }

    // Everything that changes a share goes one after the other, and never throws to the caller
    enqueue(share, task) {
        const run = share.chain.then(async () => {
            if (share.closed) return;
            await task();
        });
        share.chain = run.catch((error) => {
            this.log.error(`replay: ${share.id}: ${error.message}`);
            this.closeShare(share.id, 'failed');
        });
        return share.chain;
    }

    async startShare(share) {
        // a copy of the screen on the recorder's router
        await share.roomRouter.pipeToRouter({
            producerId: share.producer.id,
            router: this.router,
            listenInfo: this.pipeListenInfo(),
        });
        if (share.closed) return;

        await this.connectShare(share);
        if (share.closed) return;

        this.armKeyFrameSafety(share);
        this.emit('changed');
        this.log.info('replay: recording a screen', { shareId: share.id, roomId: share.roomId, codec: share.codec });
    }

    /*
     * The way from the recorder router to the recorder: a plain transport, the consumers of the screen (and of its
     * audio, when it has one) and the registration. It is built once per share, and again when the recorder forgets
     * the share (it restarted): the copy of the screen on the recorder router stays, only this part is rebuilt.
     */
    async connectShare(share) {
        const transport = await this.router.createPlainTransport({
            listenInfo: { protocol: 'udp', ip: this.options.bindIp, portRange: { min: this.options.portMin, max: this.options.portMax } },
            rtcpMux: true,
            comedia: false,
            enableSrtp: false,
        });
        share.transport = transport;
        share.consumers = {};
        // a transport that was replaced is closed on purpose and must not close the share
        transport.observer.once('close', () => {
            if (share.transport === transport) this.closeShare(share.id, 'transport closed');
        });

        // paused: the recorder must be listening before the first packet is sent
        const consumer = await transport.consume({
            producerId: share.producer.id,
            rtpCapabilities: this.recorderCaps,
            paused: true,
        });
        share.consumers.video = consumer;
        const video = describeStream(consumer);
        share.codec = /h264/i.test(video.codec) ? 'h264' : 'vp8';

        const { port } = await this.client.registerShare({
            shareId: share.id,
            roomId: share.roomId,
            peerName: share.peerName,
            video,
        });
        if (share.closed) return;
        share.port = port;
        share.registeredAt = this.now();

        await transport.connect({ ip: await this.resolve(this.client.host), port });
        share.paused = !this.state.available;
        if (!share.paused) await consumer.resume(); // mediasoup asks the sender for a key frame now
        else await this.client.patchShare(share.id, { paused: true }).catch(() => {});

        if (share.audioProducer && !share.audioProducer.closed) await this.attachAudio(share);
    }

    async startAudio(share, router, producer) {
        if (share.audioProducer || !share.transport) return;
        await router.pipeToRouter({ producerId: producer.id, router: this.router, listenInfo: this.pipeListenInfo() });
        if (share.closed) return;

        share.audioProducer = producer;
        producer.observer.once('close', () => {
            if (share.audioProducer !== producer) return;
            share.audioProducer = null;
            share.hasAudio = false;
            share.consumers.audio = null;
            this.emit('changed');
        });
        await this.attachAudio(share);
    }

    async attachAudio(share) {
        const producer = share.audioProducer;
        const consumer = await share.transport.consume({
            producerId: producer.id,
            rtpCapabilities: this.recorderCaps,
            paused: true,
        });
        share.consumers.audio = consumer;

        await this.client.patchShare(share.id, { audio: describeStream(consumer) });
        if (share.closed) return;
        if (!share.paused) await consumer.resume();
        share.hasAudio = true;
        this.emit('changed');
        this.log.info('replay: recording the audio of a screen', { shareId: share.id });
    }

    // The recorder lost a share (it restarted): a new way to it, the old transport closed
    async restartShare(share) {
        const old = share.transport;
        share.transport = null;
        share.port = 0;
        try {
            old?.close();
        } catch (error) {
            // already closed
        }
        await this.connectShare(share);
        this.log.warn('replay: connected a screen to the recorder again', { shareId: share.id });
        this.emit('changed');
    }

    pipeListenInfo() {
        return { protocol: 'udp', ip: this.options.pipeIp, portRange: { min: this.options.pipePortMin, max: this.options.pipePortMax } };
    }

    // For senders whose encoder rarely makes key frames (H.264 in hardware): ask one every N seconds
    armKeyFrameSafety(share) {
        if (!(this.options.keyFrameSafetyS > 0)) return;
        share.keyFrameTimer = setInterval(() => {
            const consumer = share.consumers.video;
            if (consumer && !consumer.closed && !share.paused) consumer.requestKeyFrame().catch(() => {});
        }, this.options.keyFrameSafetyS * 1000);
        share.keyFrameTimer.unref?.();
    }

    async closeShare(id, why = 'closed') {
        const share = this.shares.get(id);
        if (!share || share.closed) return;
        share.closed = true;
        this.shares.delete(id);
        clearInterval(share.keyFrameTimer);
        try {
            share.transport?.close(); // closes its consumers; the pipe producers end with their origin
        } catch (error) {
            // already closed
        }
        if (share.port) await this.client.deleteShare(id).catch(() => {});
        this.log.info('replay: stopped recording a screen', { shareId: id, why });
        this.emit('changed');
    }

    // Closes everything of a room (the room ended)
    closeRoom(roomId) {
        for (const share of [...this.shares.values()]) {
            if (share.roomId === roomId) this.closeShare(share.id, 'room closed');
        }
    }

    /* What is being recorded, for the room */
    list() {
        return [...this.shares.values()]
            .filter((share) => share.port && !share.closed)
            .map((share) => ({
                shareId: share.id,
                roomId: share.roomId,
                peerName: share.peerName,
                peerUuid: share.peerUuid,
                codec: share.codec,
                hasAudio: share.hasAudio,
                startedAt: share.startedAt,
            }));
    }

    getShare(id) {
        return this.shares.get(id) || null;
    }

    // ---- safety ---------------------------------------------------------------------------------------------------

    async measureWorkers() {
        let peak = null;
        const t = this.now();
        for (const worker of this.roomWorkers()) {
            if (!worker || worker.closed) continue;
            let usage;
            try {
                usage = await worker.getResourceUsage();
            } catch (error) {
                continue;
            }
            const cpuMs = usage.ru_utime + usage.ru_stime; // cumulative CPU time of the worker
            const before = this.cpuSamples.get(worker.pid);
            this.cpuSamples.set(worker.pid, { cpuMs, t });
            if (before && t > before.t) {
                const percent = ((cpuMs - before.cpuMs) / (t - before.t)) * 100;
                peak = peak === null ? percent : Math.max(peak, percent);
            }
        }
        return peak;
    }

    /*
     * Does the recorder still know every share? It forgets them when it restarts (its ring stays on disk, its
     * registrations do not): a share it does not list, that was registered a while ago, is connected again.
     */
    async reconcile() {
        const live = [...this.shares.values()].filter((share) => !share.closed && share.port && this.now() - share.registeredAt > 8000);
        if (!live.length) return;
        let listed;
        try {
            listed = await this.client.listShares();
        } catch (error) {
            return; // the health check already counts a recorder that does not answer
        }
        const known = new Set((listed.shares || []).filter((item) => !item.ended).map((item) => item.shareId));
        for (const share of live) {
            if (known.has(share.id) || share.restarting) continue;
            share.restarting = true;
            this.enqueue(share, () => this.restartShare(share)).finally(() => {
                share.restarting = false;
            });
        }
    }

    async sample() {
        if (this.stopped) return;
        const cpuPercent = await this.measureWorkers();
        let recorderOk = true;
        let diskFreeGb = null;
        try {
            const health = await this.client.health();
            diskFreeGb = typeof health.diskFreeGb === 'number' ? health.diskFreeGb : null;
        } catch (error) {
            recorderOk = false;
        }
        this.cpuPercent = cpuPercent;
        this.diskFreeGb = diskFreeGb;

        if (recorderOk) await this.reconcile();

        const next = decideAvailability(this.state, { cpuPercent, diskFreeGb, recorderOk }, this.options, this.now());
        const changed = next.available !== this.state.available || next.reason !== this.state.reason;
        this.state = next;
        if (changed) await this.applyAvailability();
    }

    // For tests and for the worker's own death
    setAvailability({ available, reason = null }) {
        const changed = available !== this.state.available || reason !== this.state.reason;
        this.state = { ...this.state, available, reason, highSince: 0, lowSince: 0 };
        if (changed) return this.applyAvailability();
        return Promise.resolve();
    }

    // Pauses (or resumes) what is sent to the recorder, and says so to whoever listens
    async applyAvailability() {
        const { available, reason } = this.state;
        this.log.warn(`replay: ${available ? 'available again' : 'unavailable (' + reason + ')'}`);
        for (const share of this.shares.values()) {
            if (share.closed || !share.transport) continue;
            share.paused = !available;
            for (const consumer of Object.values(share.consumers)) {
                if (!consumer || consumer.closed) continue;
                try {
                    if (available) await consumer.resume();
                    else await consumer.pause();
                } catch (error) {
                    // closed meanwhile
                }
            }
            if (share.port) await this.client.patchShare(share.id, { paused: !available }).catch(() => {});
        }
        this.emit('availability', { available, reason });
        this.emit('changed');
    }
}

module.exports = { ReplayBridge, decideAvailability, describeStream, recorderCapabilities, DEFAULTS };
