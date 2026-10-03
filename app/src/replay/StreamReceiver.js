'use strict';

const { parseRtp, buildNack, buildPli, TimestampUnwrapper } = require('./rtp');
const { ClockMap } = require('./ClockMap');
const { ReorderBuffer } = require('./ReorderBuffer');
const { createDepacketizer } = require('./depacketizers');

/**
 * Everything that happens to the packets of ONE stream (one SSRC) between the socket and the frame store:
 *
 *   RTP packet -> ReorderBuffer (order, NACK, loss) -> depacketizer (frames) -> timestamp (ClockMap) -> onFrame
 *
 * - Losses that the NACK could not repair drop the frame being assembled; a video stream then waits for a key frame
 *   (frames in between are dropped, so the clips never contain pictures that cannot be decoded) and asks for one with
 *   a PLI, at most once every pliIntervalMs.
 * - Frames get their wall clock time (tsMs) from the Sender Reports. Until the first report arrives they wait in
 *   memory, for at most pendingMaxMs; then the arrival times are used instead.
 * - tsMs never decreases inside a stream.
 *
 * Time is always passed in (arrivalMs / nowMs, local wall clock in ms), so tests can drive everything.
 */

const DEFAULTS = {
    nackDelayMs: 5,
    nackRetryMs: 20,
    maxNacks: 5,
    maxWaitMs: 60,
    pliIntervalMs: 10000,
    pliStartDelayMs: 1000,
    pendingMaxMs: 3000,
    clockSlew: 0.02,
};

class StreamReceiver {
    /**
     * @param {object} opts
     * @param {'video'|'audio'} opts.kind
     * @param {'vp8'|'h264'|'opus'} opts.codec
     * @param {number} opts.ssrc
     * @param {number} opts.payloadType
     * @param {number} opts.clockRate
     * @param {{ssrc: number, payloadType: number}} [opts.rtx] retransmission stream, when the SFU uses RTX
     * @param {number} opts.senderSsrc our own SSRC for the feedback packets
     * @param {function} opts.sendRtcp (Buffer) => void
     * @param {function} opts.onFrame ({ kind, key, tsMs, data, width, height }) => void
     * @param {object} [opts.options] overrides of DEFAULTS
     * @param {string} [opts.h264Format] 'avcc' (default, what the store keeps) or 'annexb'
     * @param {string} [opts.sprop] H.264 sprop-parameter-sets from the fmtp
     */
    constructor(opts) {
        this.kind = opts.kind;
        this.codec = opts.codec;
        this.ssrc = opts.ssrc >>> 0;
        this.payloadType = opts.payloadType;
        this.clockRate = opts.clockRate;
        this.rtx = opts.rtx || null;
        this.senderSsrc = opts.senderSsrc >>> 0;
        this.sendRtcp = opts.sendRtcp;
        this.onFrame = opts.onFrame;
        this.options = { ...DEFAULTS, ...(opts.options || {}) };

        this.hdr = {};
        this.unwrapper = new TimestampUnwrapper();
        this.clock = new ClockMap({ clockRate: this.clockRate, maxSlew: this.options.clockSlew });
        this.depacketizer = createDepacketizer(this.codec, (frame) => this._onFrame(frame), {
            format: opts.h264Format || 'avcc',
            sprop: opts.sprop,
        });
        this.reorder = new ReorderBuffer({
            deliver: (pkt) => this.depacketizer.push(pkt),
            onLoss: (count, reason) => this._onLoss(count, reason),
            sendNack: (seqs) => this.sendRtcp(buildNack(this.senderSsrc, this.ssrc, seqs)),
            nackDelayMs: this.options.nackDelayMs,
            nackRetryMs: this.options.nackRetryMs,
            maxNacks: this.options.maxNacks,
            maxWaitMs: this.options.maxWaitMs,
        });

        this.needKey = this.kind === 'video';
        this.pliNotBefore = Infinity; // set when the first packet arrives
        this.lastPliAt = -Infinity;
        this.pending = [];
        this.pendingSince = 0;
        this.lastTsMs = -Infinity;
        this.nowMs = 0;
        this.stats = {
            packets: 0,
            bytes: 0,
            rtxPackets: 0,
            malformed: 0,
            wrongPayloadType: 0,
            frames: 0,
            keyFrames: 0,
            droppedWaitingKey: 0,
            lossEvents: 0,
            plis: 0,
            senderReports: 0,
            firstPacketAt: 0,
            lastPacketAt: 0,
        };
    }

    get clockMode() {
        return this.clock.mode;
    }

    /** The H.264 parameter sets seen so far ({ sps, pps, info } or null). */
    get parameterSets() {
        return this.depacketizer.parameterSets || null;
    }

    /** One RTP packet of this stream (the whole datagram). */
    push(buf, arrivalMs) {
        this.nowMs = arrivalMs;
        const h = parseRtp(buf, this.hdr);
        if (h === null) {
            this.stats.malformed++;
            return;
        }
        if (h.payloadType !== this.payloadType) {
            this.stats.wrongPayloadType++;
            return;
        }
        this._accept(h.sequenceNumber, h.timestamp, h.marker, buf, h, h.payloadOffset, arrivalMs);
    }

    /** One packet of the RTX stream: the original sequence number is in the first two bytes of the payload. */
    pushRtx(buf, arrivalMs) {
        this.nowMs = arrivalMs;
        const h = parseRtp(buf, this.hdr);
        if (h === null || h.payloadEnd - h.payloadOffset < 3) {
            this.stats.malformed++;
            return;
        }
        this.stats.rtxPackets++;
        this._accept(buf.readUInt16BE(h.payloadOffset), h.timestamp, h.marker, buf, h, h.payloadOffset + 2, arrivalMs);
    }

    _accept(seq, timestamp, marker, buf, h, payloadOffset, arrivalMs) {
        const stats = this.stats;
        stats.packets++;
        stats.bytes += buf.length;
        if (stats.firstPacketAt === 0) {
            stats.firstPacketAt = arrivalMs;
            this.pliNotBefore = arrivalMs + this.options.pliStartDelayMs;
        }
        stats.lastPacketAt = arrivalMs;
        this.reorder.push(
            {
                seq,
                timestamp,
                marker,
                payload: buf.subarray(payloadOffset, h.payloadEnd),
                arrivalMs,
            },
            arrivalMs
        );
    }

    /** A Sender Report of this stream: at ntpMs (Unix ms) the stream was at rtpTimestamp. */
    onSenderReport(rtpTimestamp, ntpMs, nowMs) {
        this.nowMs = nowMs;
        this.stats.senderReports++;
        const ext = this.unwrapper.near(rtpTimestamp);
        if (this.clock.observeSenderReport(ext, ntpMs, nowMs) && this.pending.length > 0) {
            this._flushPending(nowMs);
        }
    }

    /** Periodic work (every ~10 ms): NACKs, give up on lost packets, waiting frames, key frame requests. */
    tick(nowMs) {
        this.nowMs = nowMs;
        this.reorder.tick(nowMs);
        if (this.pending.length > 0 && nowMs - this.pendingSince >= this.options.pendingMaxMs) {
            if (this.clock.useArrival()) this._flushPending(nowMs);
        }
        if (this.needKey) this._maybeRequestKeyFrame(nowMs);
    }

    /** Throws away the frame being assembled and waits for a key frame (used when a share resumes). */
    requireKeyFrame(nowMs) {
        if (this.kind !== 'video') return;
        this.depacketizer.reset();
        this.needKey = true;
        this.pliNotBefore = 0;
        this._maybeRequestKeyFrame(nowMs);
    }

    /** Frames still waiting for the clock are timestamped with what is known and released. */
    flush(nowMs) {
        this.nowMs = nowMs;
        if (this.pending.length > 0 && this.clock.useArrival()) this._flushPending(nowMs);
    }

    _onLoss() {
        this.depacketizer.reset();
        this.stats.lossEvents++;
        if (this.kind === 'video') {
            this.needKey = true;
            this.pliNotBefore = 0;
            this._maybeRequestKeyFrame(this.nowMs);
        }
    }

    _maybeRequestKeyFrame(nowMs) {
        if (nowMs < this.pliNotBefore || nowMs - this.lastPliAt < this.options.pliIntervalMs) return;
        this.lastPliAt = nowMs;
        this.stats.plis++;
        this.sendRtcp(buildPli(this.senderSsrc, this.ssrc));
    }

    _onFrame(frame) {
        if (this.needKey) {
            if (!frame.key) {
                this.stats.droppedWaitingKey++;
                return;
            }
            this.needKey = false;
        }
        const ext = this.unwrapper.unwrap(frame.timestamp);
        frame.ext = ext;
        if (this.clock.ready) {
            this._emit(frame, this.nowMs);
            return;
        }
        this.clock.observeArrival(ext, frame.arrivalMs);
        if (this.pending.length === 0) this.pendingSince = this.nowMs;
        this.pending.push(frame);
    }

    _flushPending(nowMs) {
        const frames = this.pending;
        this.pending = [];
        for (const frame of frames) this._emit(frame, nowMs);
    }

    _emit(frame, nowMs) {
        if (this.clock.mode === 'arrival') this.clock.observeArrival(frame.ext, frame.arrivalMs);
        let tsMs = this.clock.toWallMs(frame.ext, nowMs);
        if (tsMs < this.lastTsMs) tsMs = this.lastTsMs;
        this.lastTsMs = tsMs;
        this.stats.frames++;
        if (frame.key) this.stats.keyFrames++;
        this.onFrame({
            kind: this.kind,
            key: frame.key,
            tsMs,
            data: frame.data,
            width: frame.width || 0,
            height: frame.height || 0,
        });
    }
}

module.exports = { StreamReceiver, DEFAULTS };
