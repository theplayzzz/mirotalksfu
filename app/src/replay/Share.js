'use strict';

const dgram = require('node:dgram');

const { HttpError } = require('./errors');
const { StreamReceiver } = require('./StreamReceiver');
const { KIND_AUDIO, KIND_VIDEO } = require('./FrameStore');
const { parseRtcp } = require('./rtp');

/**
 * One share (one screen being shared): its UDP socket, the receivers of its streams (video, audio, and their RTX
 * streams if the SFU uses them), its frame store (the ring on disk) and its state (paused, ended).
 *
 * The SFU sends the RTP of the video and the audio of a share, and the RTCP of both, to ONE UDP port (rtcpMux). The
 * datagrams are told apart by what they are (RTCP by the payload type 192..223) and by their SSRC, as announced when
 * the share (or its audio) was registered. Feedback (NACK, PLI) goes back to where the packets came from.
 *
 * Nothing here throws on a bad packet: unknown SSRCs and malformed datagrams are counted and dropped.
 */

function parseFmtp(fmtp) {
    if (!fmtp) return {};
    if (typeof fmtp === 'object') return fmtp;
    const out = {};
    for (const part of String(fmtp).split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
}

function intInRange(value, min, max, name) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new HttpError(400, 'BAD_STREAM', `${name} must be an integer between ${min} and ${max}`);
    }
    return number;
}

/**
 * Checks and normalizes a Stream of the API ({ codec, payloadType, ssrc, clockRate, channels?, fmtp?, rtx? }).
 * @param {object} raw
 * @param {'video'|'audio'} kind
 */
function normalizeStream(raw, kind) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new HttpError(400, 'BAD_STREAM', `${kind} must be an object`);
    }
    const name = String(raw.codec || '')
        .split('/')
        .pop()
        .toLowerCase();
    const allowed = kind === 'video' ? ['vp8', 'h264'] : ['opus'];
    if (!allowed.includes(name)) {
        throw new HttpError(
            400,
            'UNSUPPORTED_CODEC',
            `${kind} codec "${raw.codec}" is not supported (${allowed.join(', ')})`
        );
    }
    const stream = {
        kind,
        codec: name,
        payloadType: intInRange(raw.payloadType, 0, 127, `${kind}.payloadType`),
        ssrc: intInRange(raw.ssrc, 1, 4294967295, `${kind}.ssrc`),
        clockRate: intInRange(raw.clockRate ?? (kind === 'video' ? 90000 : 48000), 8000, 192000, `${kind}.clockRate`),
        channels: raw.channels === undefined ? 2 : intInRange(raw.channels, 1, 8, `${kind}.channels`),
        rtx: null,
        sprop: null,
    };
    if (raw.rtx) {
        stream.rtx = {
            ssrc: intInRange(raw.rtx.ssrc, 1, 4294967295, `${kind}.rtx.ssrc`),
            payloadType: intInRange(raw.rtx.payloadType, 0, 127, `${kind}.rtx.payloadType`),
        };
    }
    if (name === 'h264') stream.sprop = parseFmtp(raw.fmtp)['sprop-parameter-sets'] || null;
    return stream;
}

class Share {
    /**
     * @param {object} o
     * @param {string} o.id
     * @param {string} o.roomId
     * @param {string} o.peerName
     * @param {object} o.video normalized Stream
     * @param {object} [o.audio] normalized Stream
     * @param {object} o.store FrameStore
     * @param {number} o.senderSsrc SSRC for the feedback packets
     * @param {object} o.options { receiver: StreamReceiver options }
     * @param {object} o.log
     * @param {function} [o.now]
     */
    constructor(o) {
        this.id = o.id;
        this.roomId = o.roomId;
        this.peerName = o.peerName;
        this.store = o.store;
        this.senderSsrc = o.senderSsrc;
        this.options = o.options || {};
        this.log = o.log;
        this.now = o.now || Date.now;
        this.startedAt = this.now();
        this.ended = false;
        this.endedAt = 0;
        this.paused = false;
        this.diskLow = false;

        this.codec = o.video.codec;
        this.videoStream = o.video;
        this.audioStream = null;
        this.socket = null;
        this.port = 0;
        this.remoteAddress = null;
        this.remotePort = 0;
        this.bySsrc = new Map();
        this.lastUnknownWarnAt = 0;
        this.stats = {
            datagrams: 0,
            rtcpPackets: 0,
            malformed: 0,
            unknownSsrc: 0,
            sendErrors: 0,
            framesStored: 0,
            framesDropped: 0,
        };

        this.video = this._createReceiver('video', o.video);
        this.audio = null;
        if (o.audio) this.setAudio(o.audio);
    }

    get hasAudio() {
        return this.audio !== null;
    }

    _createReceiver(kind, stream) {
        const receiver = new StreamReceiver({
            kind,
            codec: stream.codec,
            ssrc: stream.ssrc,
            payloadType: stream.payloadType,
            clockRate: stream.clockRate,
            rtx: stream.rtx,
            senderSsrc: this.senderSsrc,
            sendRtcp: (buf) => this._sendRtcp(buf),
            onFrame: (frame) => this._onFrame(frame),
            options: this.options.receiver,
            h264Format: 'avcc',
            sprop: stream.sprop,
        });
        this.bySsrc.set(stream.ssrc, { receiver, rtx: false });
        if (stream.rtx) this.bySsrc.set(stream.rtx.ssrc, { receiver, rtx: true });
        return receiver;
    }

    /** Registers (or replaces) the audio stream; audio can join a share after its video. */
    setAudio(stream) {
        const current = this.audioStream;
        if (current && current.ssrc === stream.ssrc && current.payloadType === stream.payloadType) return; // a retry
        if (this.video.ssrc === stream.ssrc || (this.videoStream.rtx && this.videoStream.rtx.ssrc === stream.ssrc)) {
            throw new HttpError(400, 'BAD_STREAM', 'audio.ssrc is the same as the video one');
        }
        if (this.audioStream) {
            this.bySsrc.delete(this.audioStream.ssrc);
            if (this.audioStream.rtx) this.bySsrc.delete(this.audioStream.rtx.ssrc);
            if (this.audio) this.audio.flush(this.now());
        }
        this.audioStream = stream;
        this.audio = this._createReceiver('audio', stream);
        this.store.expectAudioStream(true);
    }

    /** Binds the UDP socket (any free port) and returns the port. */
    async bind(bindHost, recvBufferBytes) {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
        socket.on('message', (msg, rinfo) => this._onDatagram(msg, rinfo));
        socket.on('error', (error) => {
            this.log.error(`replay: socket of share ${this.id}: ${error.message}`);
        });
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            socket.once('error', onError);
            socket.bind({ port: 0, address: bindHost }, () => {
                socket.off('error', onError);
                resolve();
            });
        });
        this.socket = socket;
        this.port = socket.address().port;
        let granted = 0;
        if (recvBufferBytes > 0) {
            try {
                socket.setRecvBufferSize(recvBufferBytes);
            } catch (error) {
                this.log.warn(`replay: cannot enlarge the receive buffer of the socket: ${error.message}`);
            }
        }
        try {
            granted = socket.getRecvBufferSize();
        } catch {
            granted = 0;
        }
        this.recvBufferBytes = granted;
        return this.port;
    }

    _onDatagram(msg, rinfo) {
        this.stats.datagrams++;
        if (msg.length < 8) {
            this.stats.malformed++;
            return;
        }
        const now = this.now();
        this.remoteAddress = rinfo.address;
        this.remotePort = rinfo.port;
        const pt = msg[1];
        if (pt >= 192 && pt <= 223) {
            this._onRtcp(msg, now);
            return;
        }
        if (msg.length < 12 || msg[0] >> 6 !== 2) {
            this.stats.malformed++;
            return;
        }
        const entry = this.bySsrc.get(msg.readUInt32BE(8));
        if (entry === undefined) {
            this.stats.unknownSsrc++;
            if (now - this.lastUnknownWarnAt > 30000) {
                this.lastUnknownWarnAt = now;
                this.log.debug(`replay: share ${this.id}: packets of an unknown SSRC are being dropped`);
            }
            return;
        }
        if (entry.rtx) entry.receiver.pushRtx(msg, now);
        else entry.receiver.push(msg, now);
    }

    _onRtcp(msg, now) {
        this.stats.rtcpPackets++;
        for (const packet of parseRtcp(msg)) {
            if (packet.type !== 'sr') continue;
            const entry = this.bySsrc.get(packet.ssrc);
            if (entry !== undefined && !entry.rtx)
                entry.receiver.onSenderReport(packet.rtpTimestamp, packet.ntpMs, now);
        }
    }

    _sendRtcp(buf) {
        if (!this.socket || this.remotePort === 0) return;
        this.socket.send(buf, this.remotePort, this.remoteAddress, (error) => {
            if (error) this.stats.sendErrors++;
        });
    }

    _onFrame(frame) {
        if (this.paused || this.diskLow || this.ended) {
            this.stats.framesDropped++;
            return;
        }
        const accepted = this.store.append(
            frame.kind === 'video' ? KIND_VIDEO : KIND_AUDIO,
            frame.key,
            frame.tsMs,
            frame.data
        );
        if (accepted) this.stats.framesStored++;
        else this.stats.framesDropped++;
    }

    /** Called every few milliseconds by the recorder. */
    tick(nowMs) {
        if (this.ended) return;
        this.video.tick(nowMs);
        if (this.audio) this.audio.tick(nowMs);
    }

    setPaused(paused, nowMs) {
        if (paused === this.paused) return;
        this.paused = paused;
        // After a pause the pictures that follow cannot be decoded without a new key frame.
        if (!paused) this.video.requireKeyFrame(nowMs);
    }

    /** What GET /v1/shares says about the share. */
    describe(bufferSecondsLimit) {
        const d = this.store.describe();
        const seconds = Math.floor(Math.min(d.availableMs, bufferSecondsLimit * 1000) / 1000);
        return {
            shareId: this.id,
            roomId: this.roomId,
            peerName: this.peerName,
            startedAt: this.startedAt,
            ended: this.ended,
            codec: this.codec,
            hasAudio: this.hasAudio,
            bufferSeconds: seconds,
            bytes: d.bytes,
        };
    }

    /** Counters of the receivers, for operators. */
    detail() {
        const receiver = (r) =>
            r && {
                ...r.stats,
                ...r.reorder.stats,
                clock: r.clockMode,
                needKey: r.needKey,
            };
        return {
            paused: this.paused,
            port: this.port,
            recvBufferBytes: this.recvBufferBytes || 0,
            ...this.stats,
            video: receiver(this.video),
            audio: receiver(this.audio),
            store: this.store.stats,
        };
    }

    /** Stops receiving; the frames that were waiting for the clock are timestamped and stored; the ring is closed. */
    async end() {
        if (this.ended) return;
        const now = this.now();
        this.video.flush(now);
        if (this.audio) this.audio.flush(now);
        this.ended = true;
        this.endedAt = now;
        const socket = this.socket;
        this.socket = null;
        if (socket) await new Promise((resolve) => socket.close(resolve));
        await this.store.close();
    }
}

module.exports = { Share, normalizeStream, parseFmtp };
