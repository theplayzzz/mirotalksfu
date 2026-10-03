'use strict';

/**
 * Opus helpers of the replay recorder: duration of a packet (from the TOC byte, RFC 6716 section 3.1), the OpusHead
 * identification header that Matroska needs as codec private data, and a packet that decodes to silence.
 */

// Opus decoders drop this many samples (at 48 kHz) at the start of a stream: 6.5 ms, the usual encoder look-ahead.
const OPUS_PRE_SKIP = 312;
const OPUS_SAMPLE_RATE = 48000;
const OPUS_DEFAULT_FRAME_MS = 20;

// A 20 ms CELT frame that decodes to silence. Used to fill the holes of the audio track (DTX, lost packets).
const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

/**
 * Duration in milliseconds of an Opus packet, from its TOC byte. Answers 20 ms (the normal WebRTC packet) when the
 * packet is too short to tell.
 */
function opusPacketDurationMs(packet) {
    if (!packet || packet.length < 1) return OPUS_DEFAULT_FRAME_MS;
    const toc = packet[0];
    const config = toc >> 3;
    let frameMs;
    if (config < 12) {
        frameMs = [10, 20, 40, 60][config & 3]; // SILK
    } else if (config < 16) {
        frameMs = config & 1 ? 20 : 10; // hybrid
    } else {
        frameMs = [2.5, 5, 10, 20][config & 3]; // CELT
    }
    const code = toc & 3;
    let frames;
    if (code === 0) frames = 1;
    else if (code < 3) frames = 2;
    else if (packet.length >= 2) frames = packet[1] & 0x3f;
    else return OPUS_DEFAULT_FRAME_MS;
    const total = frames * frameMs;
    return total > 0 && total <= 120 ? total : OPUS_DEFAULT_FRAME_MS;
}

/** The OpusHead header (RFC 7845, section 5.1), channel mapping family 0 (mono or stereo). */
function buildOpusHead({ channels = 2, preSkip = OPUS_PRE_SKIP, inputSampleRate = OPUS_SAMPLE_RATE } = {}) {
    const buf = Buffer.alloc(19);
    buf.write('OpusHead', 0, 'ascii');
    buf[8] = 1; // version
    buf[9] = channels;
    buf.writeUInt16LE(preSkip, 10);
    buf.writeUInt32LE(inputSampleRate, 12);
    buf.writeInt16LE(0, 16); // output gain
    buf[18] = 0; // mapping family
    return buf;
}

module.exports = {
    OPUS_PRE_SKIP,
    OPUS_SAMPLE_RATE,
    OPUS_DEFAULT_FRAME_MS,
    OPUS_SILENCE_FRAME,
    opusPacketDurationMs,
    buildOpusHead,
};
