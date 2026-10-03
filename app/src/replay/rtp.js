'use strict';

/**
 * RTP and RTCP helpers of the replay recorder (docs/REPLAY.md).
 *
 * - parseRtp: RTP header (version, padding, CSRC, header extension, marker, payload type, sequence, timestamp, SSRC).
 * - parseRtcp: RTCP compound packets. Sender Reports are decoded (NTP and RTP timestamp), Generic NACK and PLI are
 *   decoded too (used by tests and by the tools that play the role of the SFU), everything else is skipped safely.
 * - buildNack / buildPli: the feedback the recorder sends to the SFU.
 * - buildRtp / buildSenderReport: used by the tests and by the benchmark, never by the recorder itself.
 * - seqDiff, tsDiff, TimestampUnwrapper: arithmetic on 16 bit sequence numbers and 32 bit timestamps.
 *
 * Nothing in here throws on malformed input: the parsers answer null or skip what they cannot read.
 */

const RTP_VERSION = 2;
const RTP_FIXED_HEADER = 12;

const RTCP_SR = 200;
const RTCP_RR = 201;
const RTCP_SDES = 202;
const RTCP_BYE = 203;
const RTCP_RTPFB = 205;
const RTCP_PSFB = 206;

const FMT_NACK = 1;
const FMT_PLI = 1;

// Seconds between the NTP epoch (1900-01-01) and the Unix epoch (1970-01-01).
const NTP_UNIX_DELTA = 2208988800;
const TWO_POW_32 = 4294967296;

/**
 * True when the datagram is RTCP and not RTP. With rtcpMux both share one socket and are told apart by the second
 * byte (RFC 5761): the payload types 192..223 are never used by RTP streams.
 */
function isRtcp(buf) {
    return buf.length >= 8 && buf[1] >= 192 && buf[1] <= 223;
}

/**
 * Parses the header of an RTP packet.
 * @param {Buffer} buf the datagram
 * @param {object} [out] object to fill in (reused by the hot path to avoid allocations)
 * @returns {object|null} null when the packet is not a well formed RTP packet
 */
function parseRtp(buf, out = {}) {
    const length = buf.length;
    if (length < RTP_FIXED_HEADER) return null;
    const b0 = buf[0];
    if (b0 >> 6 !== RTP_VERSION) return null;

    const csrcCount = b0 & 0x0f;
    let offset = RTP_FIXED_HEADER + csrcCount * 4;
    if (offset > length) return null;

    const hasExtension = (b0 & 0x10) !== 0;
    let extensionProfile = 0;
    let extensionLength = 0;
    if (hasExtension) {
        if (offset + 4 > length) return null;
        extensionProfile = buf.readUInt16BE(offset);
        extensionLength = buf.readUInt16BE(offset + 2) * 4;
        offset += 4 + extensionLength;
        if (offset > length) return null;
    }

    let end = length;
    let paddingLength = 0;
    if (b0 & 0x20) {
        paddingLength = buf[length - 1];
        if (paddingLength === 0 || end - paddingLength < offset) return null;
        end -= paddingLength;
    }

    const b1 = buf[1];
    out.marker = (b1 & 0x80) !== 0;
    out.payloadType = b1 & 0x7f;
    out.sequenceNumber = buf.readUInt16BE(2);
    out.timestamp = buf.readUInt32BE(4);
    out.ssrc = buf.readUInt32BE(8);
    out.csrcCount = csrcCount;
    out.hasExtension = hasExtension;
    out.extensionProfile = extensionProfile;
    out.extensionLength = extensionLength;
    out.paddingLength = paddingLength;
    out.payloadOffset = offset;
    out.payloadEnd = end;
    return out;
}

/**
 * Builds an RTP packet. Used by the tests and the benchmark.
 * @param {object} p { payloadType, sequenceNumber, timestamp, ssrc, marker, payload, csrcs, extension, padding }
 *   extension: { profile, data: Buffer (length multiple of 4) }, padding: number of padding bytes (>= 1)
 */
function buildRtp(p) {
    const payload = p.payload || Buffer.alloc(0);
    const csrcs = p.csrcs || [];
    const extension = p.extension || null;
    const padding = p.padding || 0;
    const extensionSize = extension ? 4 + extension.data.length : 0;
    const headerSize = RTP_FIXED_HEADER + csrcs.length * 4 + extensionSize;
    const buf = Buffer.alloc(headerSize + payload.length + padding);

    buf[0] = (RTP_VERSION << 6) | (padding ? 0x20 : 0) | (extension ? 0x10 : 0) | (csrcs.length & 0x0f);
    buf[1] = (p.marker ? 0x80 : 0) | (p.payloadType & 0x7f);
    buf.writeUInt16BE(p.sequenceNumber & 0xffff, 2);
    buf.writeUInt32BE(p.timestamp >>> 0, 4);
    buf.writeUInt32BE(p.ssrc >>> 0, 8);
    let offset = RTP_FIXED_HEADER;
    for (const csrc of csrcs) {
        buf.writeUInt32BE(csrc >>> 0, offset);
        offset += 4;
    }
    if (extension) {
        buf.writeUInt16BE(extension.profile & 0xffff, offset);
        buf.writeUInt16BE(extension.data.length / 4, offset + 2);
        extension.data.copy(buf, offset + 4);
        offset += extensionSize;
    }
    payload.copy(buf, offset);
    if (padding) buf[buf.length - 1] = padding;
    return buf;
}

/** NTP timestamp (seconds and fraction since 1900) to Unix milliseconds (fractional). */
function ntpToUnixMs(ntpSec, ntpFrac) {
    // NTP era 0 ends in 2036: a value below the Unix epoch offset can only belong to era 1.
    const seconds = ntpSec >= NTP_UNIX_DELTA ? ntpSec - NTP_UNIX_DELTA : ntpSec + TWO_POW_32 - NTP_UNIX_DELTA;
    return seconds * 1000 + (ntpFrac * 1000) / TWO_POW_32;
}

/** Unix milliseconds to the two NTP words. */
function unixMsToNtp(ms) {
    const wholeSeconds = Math.floor(ms / 1000);
    const fraction = Math.min(TWO_POW_32 - 1, Math.round(((ms - wholeSeconds * 1000) / 1000) * TWO_POW_32));
    return { sec: (wholeSeconds + NTP_UNIX_DELTA) % TWO_POW_32, frac: fraction };
}

function parseSenderReport(buf, offset) {
    const ntpSec = buf.readUInt32BE(offset + 8);
    const ntpFrac = buf.readUInt32BE(offset + 12);
    return {
        type: 'sr',
        ssrc: buf.readUInt32BE(offset + 4),
        ntpSec,
        ntpFrac,
        // An all-zero NTP time means the sender has no wall clock to offer: the report carries no usable mapping.
        ntpMs: ntpSec === 0 && ntpFrac === 0 ? null : ntpToUnixMs(ntpSec, ntpFrac),
        rtpTimestamp: buf.readUInt32BE(offset + 16),
        packetCount: buf.readUInt32BE(offset + 20),
        octetCount: buf.readUInt32BE(offset + 24),
    };
}

function parseNack(buf, offset, size) {
    const senderSsrc = buf.readUInt32BE(offset + 4);
    const mediaSsrc = buf.readUInt32BE(offset + 8);
    const seqs = [];
    for (let pos = offset + 12; pos + 4 <= offset + size; pos += 4) {
        const pid = buf.readUInt16BE(pos);
        const blp = buf.readUInt16BE(pos + 2);
        seqs.push(pid);
        for (let bit = 0; bit < 16; bit++) {
            if (blp & (1 << bit)) seqs.push((pid + bit + 1) & 0xffff);
        }
    }
    return { type: 'nack', senderSsrc, mediaSsrc, seqs };
}

/**
 * Parses an RTCP compound packet. Sender Reports, Generic NACKs and PLIs come back as objects; receiver reports,
 * source descriptions, BYE and every other type are skipped. Parsing stops quietly at the first malformed element.
 * @returns {object[]}
 */
function parseRtcp(buf) {
    const packets = [];
    const length = buf.length;
    let offset = 0;
    while (offset + 4 <= length) {
        const b0 = buf[offset];
        if (b0 >> 6 !== RTP_VERSION) break;
        const fmt = b0 & 0x1f;
        const pt = buf[offset + 1];
        const size = (buf.readUInt16BE(offset + 2) + 1) * 4;
        if (offset + size > length) break;

        if (pt === RTCP_SR && size >= 28) {
            packets.push(parseSenderReport(buf, offset));
        } else if (pt === RTCP_RTPFB && fmt === FMT_NACK && size >= 16) {
            packets.push(parseNack(buf, offset, size));
        } else if (pt === RTCP_PSFB && fmt === FMT_PLI && size >= 12) {
            packets.push({
                type: 'pli',
                senderSsrc: buf.readUInt32BE(offset + 4),
                mediaSsrc: buf.readUInt32BE(offset + 8),
            });
        }
        // RR, SDES, BYE, APP, XR, REMB, TWCC...: nothing to do with them.
        offset += size;
    }
    return packets;
}

/** PLI (picture loss indication): RTCP PSFB (206) with FMT 1. */
function buildPli(senderSsrc, mediaSsrc) {
    const buf = Buffer.allocUnsafe(12);
    buf[0] = (RTP_VERSION << 6) | FMT_PLI;
    buf[1] = RTCP_PSFB;
    buf.writeUInt16BE(2, 2);
    buf.writeUInt32BE(senderSsrc >>> 0, 4);
    buf.writeUInt32BE(mediaSsrc >>> 0, 8);
    return buf;
}

/**
 * Generic NACK (RFC 4585): RTCP RTPFB (205) with FMT 1. Every FCI entry carries a sequence number (PID) and a
 * bitmask (BLP) with the 16 sequence numbers that follow it.
 * @param {number[]} seqs 16 bit sequence numbers of the missing packets, in any order
 */
function buildNack(senderSsrc, mediaSsrc, seqs) {
    const unique = Array.from(new Set(seqs.map((s) => s & 0xffff)));
    // The sequence numbers of one NACK are close to each other, so the circular order is a total order.
    unique.sort((a, b) => seqDiff(a, b));
    const fci = [];
    let i = 0;
    while (i < unique.length) {
        const pid = unique[i++];
        let blp = 0;
        while (i < unique.length) {
            const distance = (unique[i] - pid) & 0xffff;
            if (distance < 1 || distance > 16) break;
            blp |= 1 << (distance - 1);
            i++;
        }
        fci.push([pid, blp]);
    }
    const buf = Buffer.allocUnsafe(12 + fci.length * 4);
    buf[0] = (RTP_VERSION << 6) | FMT_NACK;
    buf[1] = RTCP_RTPFB;
    buf.writeUInt16BE(2 + fci.length, 2);
    buf.writeUInt32BE(senderSsrc >>> 0, 4);
    buf.writeUInt32BE(mediaSsrc >>> 0, 8);
    fci.forEach(([pid, blp], index) => {
        buf.writeUInt16BE(pid, 12 + index * 4);
        buf.writeUInt16BE(blp, 14 + index * 4);
    });
    return buf;
}

/** Sender Report without report blocks. Used by the tests and by tools that play the role of the SFU. */
function buildSenderReport({ ssrc, ntpMs, rtpTimestamp, packetCount = 0, octetCount = 0 }) {
    const buf = Buffer.alloc(28);
    const ntp = unixMsToNtp(ntpMs);
    buf[0] = RTP_VERSION << 6;
    buf[1] = RTCP_SR;
    buf.writeUInt16BE(6, 2);
    buf.writeUInt32BE(ssrc >>> 0, 4);
    buf.writeUInt32BE(ntp.sec >>> 0, 8);
    buf.writeUInt32BE(ntp.frac >>> 0, 12);
    buf.writeUInt32BE(rtpTimestamp >>> 0, 16);
    buf.writeUInt32BE(packetCount >>> 0, 20);
    buf.writeUInt32BE(octetCount >>> 0, 24);
    return buf;
}

/** Signed distance a - b between two 16 bit sequence numbers (-32768..32767). */
function seqDiff(a, b) {
    return ((a - b + 0x8000) & 0xffff) - 0x8000;
}

/** Signed distance a - b between two 32 bit RTP timestamps. */
function tsDiff(a, b) {
    return (a - b) | 0;
}

/**
 * Turns 32 bit RTP timestamps into a growing number (a double: exact up to 2^53) so that differences keep working
 * across the wrap. The reference only moves forward, so packets that arrive a little late do not move it back.
 */
class TimestampUnwrapper {
    constructor() {
        this.initialized = false;
        this.lastTs = 0;
        this.lastExt = 0;
    }

    unwrap(ts) {
        if (!this.initialized) {
            this.initialized = true;
            this.lastTs = ts;
            this.lastExt = ts;
            return ts;
        }
        const ext = this.lastExt + ((ts - this.lastTs) | 0);
        if (ext > this.lastExt) {
            this.lastExt = ext;
            this.lastTs = ts;
        }
        return ext;
    }

    /** Same as unwrap, without ever moving the reference (for timestamps that come from RTCP). */
    near(ts) {
        if (!this.initialized) {
            this.initialized = true;
            this.lastTs = ts;
            this.lastExt = ts;
            return ts;
        }
        return this.lastExt + ((ts - this.lastTs) | 0);
    }
}

module.exports = {
    RTCP_SR,
    RTCP_RR,
    RTCP_SDES,
    RTCP_BYE,
    RTCP_RTPFB,
    RTCP_PSFB,
    NTP_UNIX_DELTA,
    isRtcp,
    parseRtp,
    parseRtcp,
    buildRtp,
    buildNack,
    buildPli,
    buildSenderReport,
    ntpToUnixMs,
    unixMsToNtp,
    seqDiff,
    tsDiff,
    TimestampUnwrapper,
};
