'use strict';

/**
 * Synthetic media for the replay tests and the benchmark: frames of VP8, H.264 and Opus (the bytes are patterned
 * noise with the headers the recorder looks at) and the RTP packetizers that cut them the way browsers and FFmpeg do.
 * Nothing here is decodable; the tests that decode use FFmpeg to produce real media.
 */

const { buildRtp } = require('../../../app/src/replay/rtp');

/** Deterministic noise (xorshift32), so that two runs of a test see the same bytes. */
function patterned(size, seed = 1) {
    const buf = Buffer.allocUnsafe(size);
    let x = seed | 0 || 1;
    for (let i = 0; i < size; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        buf[i] = x & 0xff;
    }
    return buf;
}

/* ------------------------------------------------------------------------------------------------ VP8 ---- */

function vp8Frame({ key = false, size = 500, width = 640, height = 360, seed = 1 } = {}) {
    const data = patterned(Math.max(size, 10), seed);
    const firstPartSize = Math.min(size, 0x7ffff);
    const tag = (firstPartSize << 5) | (1 << 4) | (key ? 0 : 1);
    data[0] = tag & 0xff;
    data[1] = (tag >> 8) & 0xff;
    data[2] = (tag >> 16) & 0xff;
    if (key) {
        data[3] = 0x9d;
        data[4] = 0x01;
        data[5] = 0x2a;
        data.writeUInt16LE(width & 0x3fff, 6);
        data.writeUInt16LE(height & 0x3fff, 8);
    }
    return data;
}

function vp8Descriptor(first, extension, pictureId) {
    const s = first ? 0x10 : 0;
    switch (extension) {
        case 'pid7':
            return Buffer.from([0x80 | s, 0x80, pictureId & 0x7f]);
        case 'pid15':
            return Buffer.from([0x80 | s, 0x80, 0x80 | ((pictureId >> 8) & 0x7f), pictureId & 0xff]);
        case 'full':
            return Buffer.from([0x80 | s, 0xf0, 0x80 | ((pictureId >> 8) & 0x7f), pictureId & 0xff, 0x11, 0x22]);
        case 'tl0':
            return Buffer.from([0x80 | s, 0x40, 0x33]);
        default:
            return Buffer.from([s]);
    }
}

/**
 * RTP packets of one VP8 frame (RFC 7741). extension: 'none' | 'pid7' | 'pid15' | 'full' | 'tl0'.
 * @returns {Buffer[]} the marker bit is set on the last packet
 */
function vp8Packets(frame, o) {
    const { timestamp, ssrc = 1111, payloadType = 101, firstSeq = 0, mtu = 1200, extension = 'none' } = o;
    const packets = [];
    let offset = 0;
    do {
        const chunk = frame.subarray(offset, offset + mtu);
        offset += chunk.length;
        packets.push(
            buildRtp({
                payloadType,
                sequenceNumber: (firstSeq + packets.length) & 0xffff,
                timestamp,
                ssrc,
                marker: offset >= frame.length && o.marker !== false,
                payload: Buffer.concat([vp8Descriptor(packets.length === 0, extension, o.pictureId || 1), chunk]),
                extension: o.rtpExtension,
                padding: o.padding,
            })
        );
    } while (offset < frame.length);
    return packets;
}

/* ---------------------------------------------------------------------------------------------- H.264 ---- */

class BitWriter {
    constructor() {
        this.bits = [];
    }

    u(count, value) {
        for (let i = count - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
        return this;
    }

    ue(value) {
        const v = value + 1;
        const length = Math.floor(Math.log2(v));
        this.u(length, 0);
        this.u(length + 1, v);
        return this;
    }

    se(value) {
        return this.ue(value > 0 ? 2 * value - 1 : -2 * value);
    }

    toBuffer() {
        const bits = this.bits.slice();
        bits.push(1); // rbsp_stop_one_bit
        while (bits.length % 8) bits.push(0);
        const bytes = [];
        for (let i = 0; i < bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
            bytes.push(byte);
        }
        // Emulation prevention: 00 00 0x (x <= 3) becomes 00 00 03 0x.
        const out = [];
        let zeros = 0;
        for (const byte of bytes) {
            if (zeros >= 2 && byte <= 3) {
                out.push(3);
                zeros = 0;
            }
            out.push(byte);
            zeros = byte === 0 ? zeros + 1 : 0;
        }
        return Buffer.from(out);
    }
}

/**
 * A Sequence Parameter Set NAL unit (with its header byte) for the given picture size.
 * profile 66 (baseline) has no chroma fields, 100 (high) has them.
 */
function h264Sps({ width = 1280, height = 720, profile = 66, level = 31, scalingMatrix = false } = {}) {
    const wMbs = Math.ceil(width / 16);
    const hMbs = Math.ceil(height / 16);
    const w = new BitWriter();
    w.u(8, profile)
        .u(8, profile === 66 ? 0xc0 : 0)
        .u(8, level);
    w.ue(0); // seq_parameter_set_id
    if (profile >= 100) {
        w.ue(1); // chroma_format_idc: 4:2:0
        w.ue(0).ue(0); // bit depths 8
        w.u(1, 0); // qpprime_y_zero_transform_bypass_flag
        if (scalingMatrix) {
            w.u(1, 1);
            for (let i = 0; i < 8; i++) {
                if (i === 1) {
                    w.u(1, 1);
                    const size = 16;
                    for (let j = 0; j < size; j++) w.se(j === 0 ? 2 : 0);
                } else {
                    w.u(1, 0);
                }
            }
        } else {
            w.u(1, 0);
        }
    }
    w.ue(0); // log2_max_frame_num_minus4
    w.ue(0); // pic_order_cnt_type
    w.ue(2); // log2_max_pic_order_cnt_lsb_minus4
    w.ue(1); // max_num_ref_frames
    w.u(1, 0); // gaps_in_frame_num_value_allowed_flag
    w.ue(wMbs - 1);
    w.ue(hMbs - 1);
    w.u(1, 1); // frame_mbs_only_flag
    w.u(1, 1); // direct_8x8_inference_flag
    const cropRight = (wMbs * 16 - width) / 2;
    const cropBottom = (hMbs * 16 - height) / 2;
    if (cropRight || cropBottom) {
        w.u(1, 1).ue(0).ue(cropRight).ue(0).ue(cropBottom);
    } else {
        w.u(1, 0);
    }
    w.u(1, 0); // vui_parameters_present_flag
    return Buffer.concat([Buffer.from([0x67]), w.toBuffer()]);
}

function h264Pps() {
    return Buffer.from([0x68, 0xce, 0x3c, 0x80]);
}

/** A NAL unit with a header and noise. Slices (types 1 and 5) start like the first slice of a picture. */
function h264Nal(type, size, { first = true, seed = 7, nri = 2 } = {}) {
    const nal = patterned(Math.max(size, 2), seed);
    nal[0] = (nri << 5) | type;
    if (type === 1 || type === 5) nal[1] = first ? nal[1] | 0x80 : nal[1] & 0x7f; // first_mb_in_slice == 0 <=> top bit
    return nal;
}

/**
 * RTP packets of one access unit, packetization-mode 1: runs of small NAL units go in STAP-A packets (when
 * aggregate), NAL units larger than the MTU are cut in FU-A packets, the others are sent alone.
 */
function h264Packets(nals, o) {
    const { timestamp, ssrc = 2222, payloadType = 102, firstSeq = 0, mtu = 1200, aggregate = true } = o;
    const payloads = [];
    let group = [];
    const flushGroup = () => {
        if (group.length === 0) return;
        if (group.length === 1 || !aggregate) {
            for (const nal of group) payloads.push(nal);
        } else {
            const parts = [Buffer.from([0x78])]; // STAP-A, NRI 3
            for (const nal of group) {
                const size = Buffer.alloc(2);
                size.writeUInt16BE(nal.length);
                parts.push(size, nal);
            }
            payloads.push(Buffer.concat(parts));
        }
        group = [];
    };
    let groupSize = 1;
    for (const nal of nals) {
        if (nal.length > mtu) {
            flushGroup();
            groupSize = 1;
            const type = nal[0] & 0x1f;
            const indicator = (nal[0] & 0xe0) | 28;
            const body = nal.subarray(1);
            for (let offset = 0; offset < body.length; offset += mtu - 2) {
                const fragment = body.subarray(offset, offset + mtu - 2);
                const start = offset === 0 ? 0x80 : 0;
                const end = offset + fragment.length >= body.length ? 0x40 : 0;
                payloads.push(Buffer.concat([Buffer.from([indicator, start | end | type]), fragment]));
            }
        } else if (aggregate && groupSize + 2 + nal.length <= mtu) {
            group.push(nal);
            groupSize += 2 + nal.length;
        } else {
            flushGroup();
            group.push(nal);
            groupSize = 1 + 2 + nal.length;
        }
    }
    flushGroup();
    return payloads.map((payload, i) =>
        buildRtp({
            payloadType,
            sequenceNumber: (firstSeq + i) & 0xffff,
            timestamp,
            ssrc,
            marker: i === payloads.length - 1,
            payload,
        })
    );
}

/* ----------------------------------------------------------------------------------------------- Opus ---- */

/** An Opus packet of 20 ms CELT fullband (TOC 0xF8) with noise. */
function opusPacket({ size = 60, seed = 3 } = {}) {
    const packet = patterned(Math.max(size, 2), seed);
    packet[0] = 0xf8;
    return packet;
}

function opusRtp(payload, { timestamp, ssrc = 3333, payloadType = 100, sequenceNumber = 0, marker = false }) {
    return buildRtp({ payloadType, sequenceNumber, timestamp, ssrc, marker, payload });
}

module.exports = {
    patterned,
    vp8Frame,
    vp8Packets,
    h264Sps,
    h264Pps,
    h264Nal,
    h264Packets,
    opusPacket,
    opusRtp,
    BitWriter,
};
