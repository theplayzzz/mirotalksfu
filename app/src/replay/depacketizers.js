'use strict';

/**
 * Depacketizers of the replay recorder: RTP payloads to media frames.
 *
 * They receive packets already in sequence order (see ReorderBuffer) as { timestamp, marker, payload, arrivalMs } and
 * call onFrame(frame) once per frame:
 *
 *   frame = { key: boolean, data: Buffer, timestamp: uint32, arrivalMs, width?, height? }
 *
 * - VP8 (RFC 7741): the payload descriptor is removed and the partitions of a frame are joined. A frame is the
 *   packets of one RTP timestamp up to the marker bit. A key frame has the P bit of the payload header cleared; its
 *   header carries the picture size.
 * - H.264 (RFC 6184): single NAL unit packets, STAP-A and FU-A. An access unit is the packets of one timestamp up to
 *   the marker bit. IDR means key frame. The latest SPS and PPS are kept and added to key frames that arrive
 *   without them, so every key frame stands alone. Output is Annex-B (start codes) or, for storage, the 4 byte
 *   length prefixed layout that Matroska and MP4 use (option format: 'avcc'), which saves a conversion later.
 * - Opus (RFC 7587): one packet is one frame.
 *
 * reset() must be called when the reorder buffer gives up on a lost packet: the frame being assembled is dropped and
 * the packets that still belong to it are ignored.
 */

const {
    NAL_SLICE,
    NAL_IDR,
    NAL_SPS,
    NAL_PPS,
    NAL_STAP_A,
    NAL_FU_A,
    START_CODE,
    parseSps,
    parseSpropParameterSets,
} = require('./h264');

class Vp8Depacketizer {
    constructor(onFrame) {
        this.onFrame = onFrame;
        this.stats = { frames: 0, keyFrames: 0, dropped: 0 };
        this.reset();
    }

    reset() {
        if (this.active && this.started) this.stats.dropped++;
        this.active = false;
        this.started = false;
        this.broken = false;
        this.chunks = [];
        this.bytes = 0;
        this.key = false;
        this.width = 0;
        this.height = 0;
        this.timestamp = 0;
        this.arrivalMs = 0;
    }

    push(pkt) {
        const p = pkt.payload;
        if (p.length < 1) return;

        // A new timestamp with no marker on the previous packets: the previous frame is as complete as it will get.
        if (this.active && pkt.timestamp !== this.timestamp) this._finish();
        if (!this.active) {
            this.active = true;
            this.started = false;
            this.broken = false;
            this.chunks = [];
            this.bytes = 0;
            this.key = false;
            this.width = 0;
            this.height = 0;
            this.timestamp = pkt.timestamp;
            this.arrivalMs = pkt.arrivalMs;
        }

        // Payload descriptor: X R N S R PID, then the optional bytes announced by X (I, L, T/K).
        const b0 = p[0];
        let offset = 1;
        if (b0 & 0x80) {
            if (p.length < 2) {
                this.broken = true;
                return;
            }
            const x = p[1];
            offset = 2;
            if (x & 0x80) offset += p[offset] !== undefined && p[offset] & 0x80 ? 2 : 1; // PictureID: 7 or 15 bits
            if (x & 0x40) offset += 1; // TL0PICIDX
            if (x & 0x30) offset += 1; // TID / Y / KEYIDX
        }

        if (offset < p.length) {
            const startOfFrame = (b0 & 0x10) !== 0 && (b0 & 0x07) === 0;
            if (startOfFrame) {
                if (this.started) {
                    this.broken = true; // two starts under one timestamp: not a frame we can trust
                } else {
                    this.started = true;
                    this.key = (p[offset] & 0x01) === 0;
                    if (this.key && p.length - offset >= 10 && p[offset + 3] === 0x9d && p[offset + 4] === 0x01) {
                        this.width = p.readUInt16LE(offset + 6) & 0x3fff;
                        this.height = p.readUInt16LE(offset + 8) & 0x3fff;
                    }
                }
            } else if (!this.started) {
                this.broken = true; // the beginning of this frame was lost
            }
            if (!this.broken) {
                this.chunks.push(offset === 0 ? p : p.subarray(offset));
                this.bytes += p.length - offset;
            }
        }

        if (pkt.marker) this._finish();
    }

    _finish() {
        const emit = this.active && this.started && !this.broken && this.bytes > 0;
        const data = emit ? (this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.bytes)) : null;
        const frame = emit
            ? {
                  key: this.key,
                  data,
                  timestamp: this.timestamp,
                  arrivalMs: this.arrivalMs,
                  width: this.width,
                  height: this.height,
              }
            : null;
        if (this.active && !emit && this.started) this.stats.dropped++;
        this.active = false;
        this.started = false;
        this.broken = false;
        this.chunks = [];
        this.bytes = 0;
        if (frame) {
            this.stats.frames++;
            if (frame.key) this.stats.keyFrames++;
            this.onFrame(frame);
        }
    }
}

class H264Depacketizer {
    /**
     * @param {function} onFrame
     * @param {object} [options] { format: 'annexb' (default) | 'avcc', sprop: base64 parameter sets from the fmtp }
     */
    constructor(onFrame, options = {}) {
        this.onFrame = onFrame;
        this.avcc = options.format === 'avcc';
        this.stats = { frames: 0, keyFrames: 0, dropped: 0, unsupported: 0 };
        this.sps = null;
        this.pps = null;
        this.spsInfo = null;
        this.spsPart = null;
        this.ppsPart = null;
        if (options.sprop) {
            const sets = parseSpropParameterSets(options.sprop);
            if (sets) {
                this._setSps(sets.sps);
                this._setPps(sets.pps);
            }
        }
        this.reset();
    }

    /** The latest parameter sets seen (NAL units with their header), or null. */
    get parameterSets() {
        return this.sps && this.pps ? { sps: this.sps, pps: this.pps, info: this.spsInfo } : null;
    }

    reset() {
        if (this.active) this.stats.dropped++;
        this.active = false;
        this.broken = false;
        this.parts = [];
        this.bytes = 0;
        this.hasIdr = false;
        this.hasVcl = false;
        this.hasSps = false;
        this.hasPps = false;
        this.fuActive = false;
        this.fuHead = null;
        this.fuLength = 0;
        this.timestamp = 0;
        this.arrivalMs = 0;
    }

    _prefix(length) {
        if (!this.avcc) return START_CODE;
        const prefix = Buffer.allocUnsafe(4);
        prefix.writeUInt32BE(length, 0);
        return prefix;
    }

    _setSps(nal) {
        if (this.sps && this.sps.equals(nal)) return;
        this.sps = Buffer.from(nal);
        this.spsInfo = parseSps(this.sps);
        this.spsPart = Buffer.concat([this._prefix(nal.length), this.sps]);
    }

    _setPps(nal) {
        if (this.pps && this.pps.equals(nal)) return;
        this.pps = Buffer.from(nal);
        this.ppsPart = Buffer.concat([this._prefix(nal.length), this.pps]);
    }

    _begin(pkt) {
        this.active = true;
        this.broken = false;
        this.parts = [];
        this.bytes = 0;
        this.hasIdr = false;
        this.hasVcl = false;
        this.hasSps = false;
        this.hasPps = false;
        this.fuActive = false;
        this.timestamp = pkt.timestamp;
        this.arrivalMs = pkt.arrivalMs;
    }

    /** Takes note of a complete NAL unit and appends it (prefixed) to the access unit. */
    _addNal(nal) {
        if (nal.length < 1) return;
        const type = nal[0] & 0x1f;
        if (type === NAL_SPS) {
            this.hasSps = true;
            this._setSps(nal);
        } else if (type === NAL_PPS) {
            this.hasPps = true;
            this._setPps(nal);
        } else if (type === NAL_IDR || type === NAL_SLICE) {
            this._noteSlice(type, nal.length > 1 ? nal[1] : 0);
        }
        const prefix = this._prefix(nal.length);
        this.parts.push(prefix, nal);
        this.bytes += prefix.length + nal.length;
    }

    /** firstByte is the first byte of the slice header: its top bit tells first_mb_in_slice == 0. */
    _noteSlice(type, firstByte) {
        if (!this.hasVcl && (firstByte & 0x80) === 0) this.broken = true; // the first slice of the picture is missing
        this.hasVcl = true;
        if (type === NAL_IDR) this.hasIdr = true;
    }

    _fuA(p) {
        if (p.length < 2) return;
        const fuHeader = p[1];
        const start = (fuHeader & 0x80) !== 0;
        const end = (fuHeader & 0x40) !== 0;
        if (start) {
            if (this.fuActive) this.broken = true; // the previous fragmented NAL unit never ended
            const type = fuHeader & 0x1f;
            const head = Buffer.allocUnsafe(5);
            head[4] = (p[0] & 0xe0) | type; // the NAL unit header, rebuilt from the FU indicator and header
            this.fuHead = head;
            this.fuLength = 1;
            this.fuActive = true;
            this.parts.push(head);
            this.bytes += 5;
            if (type === NAL_IDR || type === NAL_SLICE) this._noteSlice(type, p.length > 2 ? p[2] : 0);
        } else if (!this.fuActive) {
            this.broken = true; // a continuation whose start we never saw
            return;
        }
        if (p.length > 2) {
            const fragment = p.subarray(2);
            this.parts.push(fragment);
            this.bytes += fragment.length;
            this.fuLength += fragment.length;
        }
        if (end) {
            const head = this.fuHead;
            if (this.avcc) head.writeUInt32BE(this.fuLength, 0);
            else START_CODE.copy(head, 0);
            this.fuActive = false;
            this.fuHead = null;
        }
    }

    push(pkt) {
        const p = pkt.payload;
        if (p.length < 1) return;
        if (this.active && pkt.timestamp !== this.timestamp) this._finish();
        if (!this.active) this._begin(pkt);

        const type = p[0] & 0x1f;
        if (this.fuActive && type !== NAL_FU_A) {
            this.broken = true; // a fragmented NAL unit was cut short
            this.fuActive = false;
        }
        if (type >= 1 && type <= 23) {
            this._addNal(p);
        } else if (type === NAL_STAP_A) {
            let offset = 1;
            while (offset + 2 <= p.length) {
                const size = p.readUInt16BE(offset);
                offset += 2;
                if (size === 0 || offset + size > p.length) {
                    this.broken = true;
                    break;
                }
                this._addNal(p.subarray(offset, offset + size));
                offset += size;
            }
        } else if (type === NAL_FU_A) {
            this._fuA(p);
        } else {
            this.stats.unsupported++; // STAP-B, MTAP, FU-B: not used by WebRTC
            this.broken = true;
        }

        if (pkt.marker) this._finish();
    }

    _finish() {
        if (!this.active) return;
        const usable = !this.broken && !this.fuActive && this.hasVcl;
        let key = usable && this.hasIdr;
        let parts = this.parts;
        let bytes = this.bytes;
        if (key && (!this.hasSps || !this.hasPps)) {
            if (this.sps && this.pps) {
                const extra = [];
                if (!this.hasSps) extra.push(this.spsPart);
                if (!this.hasPps) extra.push(this.ppsPart);
                for (const part of extra) bytes += part.length;
                parts = extra.concat(parts);
            } else {
                key = false; // no parameter sets yet: a clip could not start here
            }
        }
        const frame = usable
            ? {
                  key,
                  data: Buffer.concat(parts, bytes),
                  timestamp: this.timestamp,
                  arrivalMs: this.arrivalMs,
                  width: key && this.spsInfo ? this.spsInfo.width : 0,
                  height: key && this.spsInfo ? this.spsInfo.height : 0,
              }
            : null;
        if (!usable && (this.broken || this.fuActive)) this.stats.dropped++;
        this.active = false;
        this.broken = false;
        this.parts = [];
        this.bytes = 0;
        this.fuActive = false;
        if (frame) {
            this.stats.frames++;
            if (frame.key) this.stats.keyFrames++;
            this.onFrame(frame);
        }
    }
}

class OpusDepacketizer {
    constructor(onFrame) {
        this.onFrame = onFrame;
        this.stats = { frames: 0, keyFrames: 0, dropped: 0 };
    }

    reset() {}

    push(pkt) {
        if (pkt.payload.length < 1) return; // an empty payload carries nothing
        this.stats.frames++;
        this.onFrame({ key: true, data: pkt.payload, timestamp: pkt.timestamp, arrivalMs: pkt.arrivalMs });
    }
}

/**
 * @param {string} codec 'vp8' | 'h264' | 'opus' (any case)
 * @param {function} onFrame
 * @param {object} [options] passed to the H.264 depacketizer
 */
function createDepacketizer(codec, onFrame, options) {
    switch (String(codec).toLowerCase()) {
        case 'vp8':
            return new Vp8Depacketizer(onFrame);
        case 'h264':
            return new H264Depacketizer(onFrame, options);
        case 'opus':
            return new OpusDepacketizer(onFrame);
        default:
            throw new Error(`unsupported codec: ${codec}`);
    }
}

module.exports = { Vp8Depacketizer, H264Depacketizer, OpusDepacketizer, createDepacketizer };
