'use strict';

/**
 * Real, decodable media for the tests that check clips: FFmpeg encodes a short test pattern (and a tone), the
 * frames are read back from the Matroska file, and tests feed them to a FrameStore as the recorder would.
 */

const fs = require('node:fs');
const path = require('node:path');

const h264 = require('../../../app/src/replay/h264');
const media = require('./media');
const { parseMkv } = require('./mkv');

/**
 * Encodes `seconds` of media into <dir>/<name>.mkv.
 * @param {object} o { dir, name, codec: 'vp8'|'h264', seconds, fps, gop, width, height, audio, videoFilter }
 */
async function encode(o) {
    const {
        dir,
        name = 'sample',
        codec = 'vp8',
        seconds = 12,
        fps = 30,
        gop = 30,
        width = 640,
        height = 360,
        audio = true,
    } = o;
    const file = path.join(dir, `${name}.mkv`);
    const args = ['-v', 'error', '-f', 'lavfi', '-i', o.videoSource || `testsrc2=size=${width}x${height}:rate=${fps}`];
    if (audio) args.push('-f', 'lavfi', '-i', o.audioSource || 'sine=frequency=440:sample_rate=48000');
    args.push('-t', String(seconds));
    if (codec === 'vp8') {
        args.push(
            '-c:v',
            'libvpx',
            '-deadline',
            'realtime',
            '-cpu-used',
            '8',
            '-b:v',
            '600k',
            '-g',
            String(gop),
            '-lag-in-frames',
            '0',
            '-auto-alt-ref',
            '0'
        );
    } else {
        args.push(
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-tune',
            'zerolatency',
            '-g',
            String(gop),
            '-bf',
            '0',
            '-pix_fmt',
            'yuv420p'
        );
    }
    if (audio) args.push('-c:a', 'libopus', '-b:a', '64k', '-ac', '2', '-ar', '48000');
    args.push('-f', 'matroska', '-y', file);
    const result = await media.run('ffmpeg', args);
    if (result.code !== 0) throw new Error(`ffmpeg could not encode the sample: ${result.stderr}`);
    return file;
}

/**
 * Reads the frames of a file made by encode(). H.264 key frames get the parameter sets in front, as the recorder
 * keeps them. Returns { video: [{ tsMs, key, data }], audio: [...], width, height }.
 */
function loadFrames(file) {
    const mkv = parseMkv(fs.readFileSync(file));
    const videoTrack = mkv.tracks.find((t) => t.type === 1);
    const codec = videoTrack.codec === 'V_VP8' ? 'vp8' : 'h264';
    let parameterSets = null;
    let width = 0;
    let height = 0;
    if (codec === 'h264') {
        const avcc = videoTrack.codecPrivate;
        const spsLength = avcc.readUInt16BE(6);
        const sps = avcc.subarray(8, 8 + spsLength);
        const ppsLength = avcc.readUInt16BE(8 + spsLength + 1);
        const pps = avcc.subarray(8 + spsLength + 3, 8 + spsLength + 3 + ppsLength);
        const prefix = (n) => {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(n.length);
            return b;
        };
        parameterSets = Buffer.concat([prefix(sps), sps, prefix(pps), pps]);
        const info = h264.parseSps(sps);
        width = info.width;
        height = info.height;
    }
    const video = [];
    const audio = [];
    for (const cluster of mkv.clusters) {
        for (const block of cluster.blocks) {
            if (block.track === 1) {
                let data = Buffer.from(block.data);
                if (codec === 'vp8' && block.key) {
                    width = data.readUInt16LE(6) & 0x3fff;
                    height = data.readUInt16LE(8) & 0x3fff;
                }
                if (codec === 'h264' && block.key) data = Buffer.concat([parameterSets, data]);
                video.push({ tsMs: block.ts, key: block.key, data });
            } else {
                audio.push({ tsMs: block.ts, key: true, data: Buffer.from(block.data) });
            }
        }
    }
    return { codec, video, audio, width, height };
}

/**
 * Appends frames to a FrameStore with their media time shifted to t0, in time order.
 * @param {object} store FrameStore
 * @param {object} frames result of loadFrames()
 * @param {number} t0 wall clock of media time 0
 * @param {object} [o] { audio: false to skip it, skipAudio: (tsMs) => boolean, from, to: range in ms to feed }
 */
function feedStore(store, frames, t0, o = {}) {
    const { KIND_VIDEO, KIND_AUDIO } = require('../../../app/src/replay/FrameStore');
    const all = [];
    for (const f of frames.video) all.push({ kind: KIND_VIDEO, ...f });
    if (o.audio !== false)
        for (const f of frames.audio) if (!(o.skipAudio && o.skipAudio(f.tsMs))) all.push({ kind: KIND_AUDIO, ...f });
    all.sort((a, b) => a.tsMs - b.tsMs || a.kind - b.kind);
    for (const f of all) {
        if (o.from !== undefined && f.tsMs < o.from) continue;
        if (o.to !== undefined && f.tsMs > o.to) continue;
        store.append(f.kind, f.key, t0 + f.tsMs, f.data);
    }
}

module.exports = { encode, loadFrames, feedStore };
