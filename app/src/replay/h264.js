'use strict';

/**
 * H.264 helpers of the replay recorder: NAL unit types, Annex-B and length prefixed (AVCC) conversions, a parser of
 * the Sequence Parameter Set (picture size, profile) and the builder of the avcC record that Matroska and MP4 need
 * as codec private data.
 */

const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;
const NAL_STAP_A = 24;
const NAL_FU_A = 28;

const START_CODE = Buffer.from([0, 0, 0, 1]);

// Profiles whose SPS carries chroma format, bit depth and scaling lists (ISO/IEC 14496-10, 7.3.2.1.1).
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function nalType(nal) {
    return nal[0] & 0x1f;
}

/** Removes the emulation prevention bytes (00 00 03 becomes 00 00). */
function unescapeRbsp(nal) {
    const out = Buffer.allocUnsafe(nal.length);
    let length = 0;
    let zeros = 0;
    for (let i = 0; i < nal.length; i++) {
        const byte = nal[i];
        if (zeros >= 2 && byte === 3) {
            zeros = 0;
            continue;
        }
        out[length++] = byte;
        zeros = byte === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, length);
}

class BitReader {
    constructor(buf) {
        this.buf = buf;
        this.pos = 0; // in bits
        this.size = buf.length * 8;
    }

    readBit() {
        if (this.pos >= this.size) throw new RangeError('end of data');
        const bit = (this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return bit;
    }

    readBits(count) {
        let value = 0;
        for (let i = 0; i < count; i++) value = value * 2 + this.readBit();
        return value;
    }

    /** Unsigned Exp-Golomb. */
    readUE() {
        let zeros = 0;
        while (this.readBit() === 0) {
            zeros++;
            if (zeros > 32) throw new RangeError('bad exp-golomb code');
        }
        return zeros === 0 ? 0 : 2 ** zeros - 1 + this.readBits(zeros);
    }

    /** Signed Exp-Golomb. */
    readSE() {
        const k = this.readUE();
        return k & 1 ? (k + 1) / 2 : -(k / 2);
    }
}

function skipScalingList(reader, size) {
    let lastScale = 8;
    let nextScale = 8;
    for (let j = 0; j < size; j++) {
        if (nextScale !== 0) {
            const delta = reader.readSE();
            nextScale = (lastScale + delta + 256) % 256;
        }
        lastScale = nextScale === 0 ? lastScale : nextScale;
    }
}

/**
 * Parses what the recorder needs from a Sequence Parameter Set NAL unit (with its one byte header).
 * @returns {{profileIdc, constraintFlags, levelIdc, chromaFormatIdc, bitDepthLuma, bitDepthChroma, width, height}|null}
 */
function parseSps(nal) {
    try {
        if (!nal || nal.length < 5 || nalType(nal) !== NAL_SPS) return null;
        const rbsp = unescapeRbsp(nal.subarray(1));
        const r = new BitReader(rbsp);
        const profileIdc = r.readBits(8);
        const constraintFlags = r.readBits(8);
        const levelIdc = r.readBits(8);
        r.readUE(); // seq_parameter_set_id
        let chromaFormatIdc = 1;
        let separateColourPlane = 0;
        let bitDepthLuma = 8;
        let bitDepthChroma = 8;
        if (HIGH_PROFILES.has(profileIdc)) {
            chromaFormatIdc = r.readUE();
            if (chromaFormatIdc === 3) separateColourPlane = r.readBit();
            bitDepthLuma = 8 + r.readUE();
            bitDepthChroma = 8 + r.readUE();
            r.readBit(); // qpprime_y_zero_transform_bypass_flag
            if (r.readBit()) {
                const lists = chromaFormatIdc !== 3 ? 8 : 12;
                for (let i = 0; i < lists; i++) {
                    if (r.readBit()) skipScalingList(r, i < 6 ? 16 : 64);
                }
            }
        }
        r.readUE(); // log2_max_frame_num_minus4
        const pocType = r.readUE();
        if (pocType === 0) {
            r.readUE(); // log2_max_pic_order_cnt_lsb_minus4
        } else if (pocType === 1) {
            r.readBit(); // delta_pic_order_always_zero_flag
            r.readSE(); // offset_for_non_ref_pic
            r.readSE(); // offset_for_top_to_bottom_field
            const cycle = r.readUE();
            if (cycle > 255) return null;
            for (let i = 0; i < cycle; i++) r.readSE();
        }
        r.readUE(); // max_num_ref_frames
        r.readBit(); // gaps_in_frame_num_value_allowed_flag
        const widthMbs = r.readUE() + 1;
        const heightMapUnits = r.readUE() + 1;
        const frameMbsOnly = r.readBit();
        if (!frameMbsOnly) r.readBit(); // mb_adaptive_frame_field_flag
        r.readBit(); // direct_8x8_inference_flag
        let cropLeft = 0;
        let cropRight = 0;
        let cropTop = 0;
        let cropBottom = 0;
        if (r.readBit()) {
            cropLeft = r.readUE();
            cropRight = r.readUE();
            cropTop = r.readUE();
            cropBottom = r.readUE();
        }
        const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
        const subWidth = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
        const subHeight = chromaArrayType === 1 ? 2 : 1;
        const cropUnitX = chromaArrayType === 0 ? 1 : subWidth;
        const cropUnitY = (chromaArrayType === 0 ? 1 : subHeight) * (2 - frameMbsOnly);
        const width = widthMbs * 16 - cropUnitX * (cropLeft + cropRight);
        const height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropUnitY * (cropTop + cropBottom);
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return null;
        return { profileIdc, constraintFlags, levelIdc, chromaFormatIdc, bitDepthLuma, bitDepthChroma, width, height };
    } catch {
        return null;
    }
}

/**
 * Builds the AVCDecoderConfigurationRecord (avcC) with one SPS and one PPS, NAL units with a 4 byte length prefix.
 * @param {Buffer} sps SPS NAL unit (with header)
 * @param {Buffer} pps PPS NAL unit (with header)
 * @param {object} [info] result of parseSps(sps), parsed here when not given
 */
function buildAvcC(sps, pps, info = parseSps(sps)) {
    const high = info && HIGH_PROFILES.has(info.profileIdc);
    const buf = Buffer.alloc(11 + sps.length + pps.length + (high ? 4 : 0));
    let o = 0;
    buf[o++] = 1; // configurationVersion
    buf[o++] = sps[1]; // AVCProfileIndication
    buf[o++] = sps[2]; // profile_compatibility
    buf[o++] = sps[3]; // AVCLevelIndication
    buf[o++] = 0xff; // reserved (6 bits) + lengthSizeMinusOne = 3
    buf[o++] = 0xe1; // reserved (3 bits) + one SPS
    buf.writeUInt16BE(sps.length, o);
    o += 2;
    sps.copy(buf, o);
    o += sps.length;
    buf[o++] = 1; // one PPS
    buf.writeUInt16BE(pps.length, o);
    o += 2;
    pps.copy(buf, o);
    o += pps.length;
    if (high) {
        buf[o++] = 0xfc | info.chromaFormatIdc;
        buf[o++] = 0xf8 | (info.bitDepthLuma - 8);
        buf[o++] = 0xf8 | (info.bitDepthChroma - 8);
        buf[o++] = 0; // no SPS extensions
    }
    return buf;
}

/** Splits an Annex-B byte stream into NAL units (views of the same buffer, start codes removed). */
function splitAnnexB(buf) {
    const nals = [];
    const length = buf.length;
    let start = -1;
    let i = 0;
    while (i + 2 < length) {
        if (buf[i + 2] > 1) {
            i += 3;
        } else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
            if (start >= 0) {
                let end = i;
                while (end > start && buf[end - 1] === 0) end--; // trailing zero bytes belong to the next start code
                nals.push(buf.subarray(start, end));
            }
            start = i + 3;
            i += 3;
        } else {
            i++;
        }
    }
    if (start >= 0 && start < length) {
        let end = length;
        while (end > start && buf[end - 1] === 0) end--;
        nals.push(buf.subarray(start, end));
    }
    return nals;
}

/** Annex-B access unit to 4 byte length prefixed NAL units. */
function annexBToAvcc(buf) {
    const nals = splitAnnexB(buf);
    let total = 0;
    for (const nal of nals) total += 4 + nal.length;
    const out = Buffer.allocUnsafe(total);
    let o = 0;
    for (const nal of nals) {
        out.writeUInt32BE(nal.length, o);
        nal.copy(out, o + 4);
        o += 4 + nal.length;
    }
    return out;
}

/** 4 byte length prefixed access unit to Annex-B. */
function avccToAnnexB(buf) {
    const nals = avccNals(buf);
    let total = 0;
    for (const nal of nals) total += 4 + nal.length;
    const out = Buffer.allocUnsafe(total);
    let o = 0;
    for (const nal of nals) {
        START_CODE.copy(out, o);
        nal.copy(out, o + 4);
        o += 4 + nal.length;
    }
    return out;
}

/** The NAL units (views) of a 4 byte length prefixed access unit. Stops at the first inconsistent length. */
function avccNals(buf) {
    const nals = [];
    let o = 0;
    while (o + 4 <= buf.length) {
        const size = buf.readUInt32BE(o);
        o += 4;
        if (size === 0 || o + size > buf.length) break;
        nals.push(buf.subarray(o, o + size));
        o += size;
    }
    return nals;
}

/** Parameter sets of base64 "sprop-parameter-sets" (SDP/fmtp): returns { sps, pps } buffers or null. */
function parseSpropParameterSets(value) {
    if (typeof value !== 'string') return null;
    let sps = null;
    let pps = null;
    for (const item of value.split(',')) {
        const nal = Buffer.from(item.trim(), 'base64');
        if (nal.length < 2) continue;
        if (nalType(nal) === NAL_SPS && !sps) sps = nal;
        else if (nalType(nal) === NAL_PPS && !pps) pps = nal;
    }
    return sps && pps ? { sps, pps } : null;
}

module.exports = {
    NAL_SLICE,
    NAL_IDR,
    NAL_SEI,
    NAL_SPS,
    NAL_PPS,
    NAL_AUD,
    NAL_STAP_A,
    NAL_FU_A,
    START_CODE,
    nalType,
    unescapeRbsp,
    parseSps,
    buildAvcC,
    splitAnnexB,
    annexBToAvcc,
    avccToAnnexB,
    avccNals,
    parseSpropParameterSets,
};
