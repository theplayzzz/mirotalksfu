'use strict';

const fs = require('node:fs');
const { buildOpusHead, OPUS_PRE_SKIP, OPUS_SAMPLE_RATE } = require('./opus');

/**
 * Streaming Matroska / WebM muxer.
 *
 * It writes the file front to back, in one pass, the way the recorder needs it (the output can be a pipe to FFmpeg):
 *
 *   EBML header, Segment (unknown size), Info, Tracks, then Clusters of SimpleBlocks.
 *
 * - The Segment has an unknown size, the Clusters have known sizes (a Cluster is assembled in memory first, a few
 *   MB at most) and start at every video key frame or after clusterMs, whichever comes first.
 * - There is no Duration, SeekHead or Cues: FFmpeg adds them when it copies the file (see ClipBuilder).
 * - Tracks: video 1 (V_VP8, or V_MPEG4/ISO/AVC with its avcC record), audio 2 (A_OPUS with the OpusHead and the
 *   codec delay and seek pre-roll the Matroska Opus mapping asks for). The audio track is optional.
 * - Timestamps are in milliseconds (TimecodeScale 1 ms), relative to the start of the file, and strictly increasing
 *   inside a track (a frame that would not be is moved to the millisecond after the previous one).
 */

const ID = {
    EBML: 0x1a45dfa3,
    EBMLVersion: 0x4286,
    EBMLReadVersion: 0x42f7,
    EBMLMaxIDLength: 0x42f2,
    EBMLMaxSizeLength: 0x42f3,
    DocType: 0x4282,
    DocTypeVersion: 0x4287,
    DocTypeReadVersion: 0x4285,
    Segment: 0x18538067,
    Info: 0x1549a966,
    TimecodeScale: 0x2ad7b1,
    MuxingApp: 0x4d80,
    WritingApp: 0x5741,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackUID: 0x73c5,
    TrackType: 0x83,
    FlagLacing: 0x9c,
    CodecID: 0x86,
    CodecPrivate: 0x63a2,
    CodecDelay: 0x56aa,
    SeekPreRoll: 0x56bb,
    Video: 0xe0,
    PixelWidth: 0xb0,
    PixelHeight: 0xba,
    Audio: 0xe1,
    SamplingFrequency: 0xb5,
    Channels: 0x9f,
    Cluster: 0x1f43b675,
    Timecode: 0xe7,
    SimpleBlock: 0xa3,
};

const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;
const CODEC_IDS = { vp8: 'V_VP8', h264: 'V_MPEG4/ISO/AVC' };

/* ------------------------------------------------------------------------------------- EBML encoding ---- */

function idBytes(id) {
    if (id > 0xffffff) return Buffer.from([(id >>> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
    if (id > 0xffff) return Buffer.from([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff]);
    if (id > 0xff) return Buffer.from([(id >> 8) & 0xff, id & 0xff]);
    return Buffer.from([id]);
}

/** Number of bytes of the EBML variable length integer that holds `size` (a data size, not a value). */
function sizeLength(size) {
    let length = 1;
    while (length < 8 && size >= 2 ** (7 * length) - 1) length++;
    return length;
}

/** Writes `size` as an EBML variable length integer at buf[offset]; returns the bytes written. */
function writeSize(buf, offset, size) {
    const length = sizeLength(size);
    let value = size;
    for (let i = length - 1; i >= 0; i--) {
        buf[offset + i] = value % 256;
        value = Math.floor(value / 256);
    }
    buf[offset] |= 0x80 >> (length - 1);
    return length;
}

function uintLength(value) {
    let length = 1;
    while (length < 8 && value >= 2 ** (8 * length)) length++;
    return length;
}

function element(id, payload) {
    const head = idBytes(id);
    const size = Buffer.alloc(sizeLength(payload.length));
    writeSize(size, 0, payload.length);
    return Buffer.concat([head, size, payload]);
}

function uintElement(id, value) {
    const length = uintLength(value);
    const payload = Buffer.alloc(length);
    let rest = value;
    for (let i = length - 1; i >= 0; i--) {
        payload[i] = rest % 256;
        rest = Math.floor(rest / 256);
    }
    return element(id, payload);
}

function stringElement(id, text) {
    return element(id, Buffer.from(text, 'utf8'));
}

function floatElement(id, value) {
    const payload = Buffer.alloc(8);
    payload.writeDoubleBE(value);
    return element(id, payload);
}

function master(id, ...children) {
    return element(id, Buffer.concat(children));
}

/* ----------------------------------------------------------------------------------------- the muxer ---- */

class MatroskaMuxer {
    /**
     * @param {object} options
     * @param {'matroska'|'webm'} [options.docType]
     * @param {{codec: 'vp8'|'h264', width: number, height: number, codecPrivate?: Buffer}} options.video
     * @param {{channels?: number, sampleRate?: number, preSkip?: number}|null} [options.audio]
     * @param {{write: function(Buffer): Promise<void>}} options.sink
     * @param {number} [options.clusterMs]
     * @param {string} [options.writingApp]
     */
    constructor(options) {
        if (!options.video || !CODEC_IDS[options.video.codec])
            throw new Error('a video track with a known codec is required');
        this.docType = options.docType || 'matroska';
        this.video = options.video;
        this.audio = options.audio || null;
        this.sink = options.sink;
        this.clusterMs = options.clusterMs || 2000;
        this.writingApp = options.writingApp || 'mirotalk-replay';
        this.cluster = null;
        this.lastTs = { video: -1, audio: -1 };
        this.started = false;
        this.finished = false;
        this.stats = { clusters: 0, videoFrames: 0, audioFrames: 0, bytes: 0 };
    }

    _header() {
        const ebml = master(
            ID.EBML,
            uintElement(ID.EBMLVersion, 1),
            uintElement(ID.EBMLReadVersion, 1),
            uintElement(ID.EBMLMaxIDLength, 4),
            uintElement(ID.EBMLMaxSizeLength, 8),
            stringElement(ID.DocType, this.docType),
            uintElement(ID.DocTypeVersion, 4),
            uintElement(ID.DocTypeReadVersion, 2)
        );
        const info = master(
            ID.Info,
            uintElement(ID.TimecodeScale, 1000000),
            stringElement(ID.MuxingApp, this.writingApp),
            stringElement(ID.WritingApp, this.writingApp)
        );

        const v = this.video;
        const videoEntry = [
            uintElement(ID.TrackNumber, VIDEO_TRACK),
            uintElement(ID.TrackUID, 0x1001),
            uintElement(ID.TrackType, 1),
            uintElement(ID.FlagLacing, 0),
            stringElement(ID.CodecID, CODEC_IDS[v.codec]),
        ];
        if (v.codecPrivate) videoEntry.push(element(ID.CodecPrivate, v.codecPrivate));
        videoEntry.push(
            master(ID.Video, uintElement(ID.PixelWidth, v.width || 16), uintElement(ID.PixelHeight, v.height || 16))
        );
        const entries = [element(ID.TrackEntry, Buffer.concat(videoEntry))];

        if (this.audio) {
            const a = this.audio;
            const sampleRate = a.sampleRate || OPUS_SAMPLE_RATE;
            const preSkip = a.preSkip ?? OPUS_PRE_SKIP;
            const channels = a.channels || 2;
            entries.push(
                master(
                    ID.TrackEntry,
                    uintElement(ID.TrackNumber, AUDIO_TRACK),
                    uintElement(ID.TrackUID, 0x1002),
                    uintElement(ID.TrackType, 2),
                    uintElement(ID.FlagLacing, 0),
                    stringElement(ID.CodecID, 'A_OPUS'),
                    element(ID.CodecPrivate, buildOpusHead({ channels, preSkip, inputSampleRate: sampleRate })),
                    uintElement(ID.CodecDelay, Math.round((preSkip * 1e9) / OPUS_SAMPLE_RATE)),
                    uintElement(ID.SeekPreRoll, 80000000),
                    master(ID.Audio, floatElement(ID.SamplingFrequency, sampleRate), uintElement(ID.Channels, channels))
                )
            );
        }
        const tracks = master(ID.Tracks, ...entries);
        return Buffer.concat([ebml, idBytes(ID.Segment), UNKNOWN_SIZE, info, tracks]);
    }

    async _write(buf) {
        this.stats.bytes += buf.length;
        await this.sink.write(buf);
    }

    async start() {
        if (this.started) return;
        this.started = true;
        await this._write(this._header());
    }

    /**
     * @param {object} frame
     * @param {'video'|'audio'} frame.track
     * @param {number} frame.tsMs milliseconds from the start of the file
     * @param {boolean} frame.key key frame (audio frames are all key frames)
     * @param {Buffer} frame.data VP8 frame, H.264 access unit with 4 byte lengths, or Opus packet
     */
    async writeFrame({ track, tsMs, key, data }) {
        if (!this.started) await this.start();
        if (this.finished) throw new Error('muxer is finished');
        const last = this.lastTs[track];
        let ts = Math.round(tsMs);
        if (ts <= last) ts = last + 1;
        this.lastTs[track] = ts;

        const cluster = this.cluster;
        const offset = cluster ? ts - cluster.ts : 0;
        const needNewCluster =
            cluster === null ||
            (track === 'video' && key && cluster.blocks.length > 0) ||
            offset >= this.clusterMs ||
            offset < -30000 ||
            offset > 30000;
        if (needNewCluster) {
            await this._flushCluster();
            this.cluster = { ts, blocks: [], size: 0 };
        }
        const open = this.cluster;
        const isVideo = track === 'video';
        open.blocks.push({
            track: isVideo ? VIDEO_TRACK : AUDIO_TRACK,
            rel: ts - open.ts,
            flags: key || !isVideo ? 0x80 : 0,
            data,
        });
        open.size += data.length;
        if (isVideo) this.stats.videoFrames++;
        else this.stats.audioFrames++;
    }

    async _flushCluster() {
        const cluster = this.cluster;
        this.cluster = null;
        if (cluster === null || cluster.blocks.length === 0) return;

        const timecodeLength = uintLength(cluster.ts);
        const timecodeSize = 2 + timecodeLength; // E7, size byte, value
        let payloadSize = timecodeSize;
        for (const block of cluster.blocks) {
            const inner = 4 + block.data.length; // track number, timecode (2), flags, frame
            payloadSize += 1 + sizeLength(inner) + inner;
        }
        const idLength = 4;
        const headLength = idLength + sizeLength(payloadSize);
        const out = Buffer.allocUnsafe(headLength + payloadSize);
        let o = 0;
        out.writeUInt32BE(ID.Cluster, o);
        o += idLength;
        o += writeSize(out, o, payloadSize);
        out[o++] = ID.Timecode;
        out[o++] = 0x80 | timecodeLength;
        let rest = cluster.ts;
        for (let i = timecodeLength - 1; i >= 0; i--) {
            out[o + i] = rest % 256;
            rest = Math.floor(rest / 256);
        }
        o += timecodeLength;
        for (const block of cluster.blocks) {
            const inner = 4 + block.data.length;
            out[o++] = ID.SimpleBlock;
            o += writeSize(out, o, inner);
            out[o++] = 0x80 | block.track;
            out.writeInt16BE(block.rel, o);
            o += 2;
            out[o++] = block.flags;
            block.data.copy(out, o);
            o += block.data.length;
        }
        this.stats.clusters++;
        await this._write(out);
    }

    /** Writes the last cluster. The sink is not closed. */
    async finish() {
        if (this.finished) return;
        if (!this.started) await this.start();
        await this._flushCluster();
        this.finished = true;
    }
}

/* ---------------------------------------------------------------------------------------------- sinks ---- */

/** A sink that appends to a file. */
function fileSink(filePath) {
    const stream = fs.createWriteStream(filePath);
    return streamSink(stream);
}

/**
 * A sink on a Writable (a file, the stdin of FFmpeg...). write() waits for the stream to drain, so a slow reader
 * slows the muxer down instead of filling the memory. Errors of the stream (EPIPE when FFmpeg dies) make the pending
 * and the next writes reject.
 */
function streamSink(stream) {
    let failure = null;
    stream.on('error', (error) => {
        failure = failure || error;
    });

    const waitForDrain = () =>
        new Promise((resolve, reject) => {
            const cleanup = () => {
                stream.off('drain', onDrain);
                stream.off('error', onError);
                stream.off('close', onClose);
            };
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onClose = () => {
                cleanup();
                reject(failure || new Error('output closed'));
            };
            stream.once('drain', onDrain);
            stream.once('error', onError);
            stream.once('close', onClose);
        });

    return {
        async write(buf) {
            if (failure) throw failure;
            if (stream.destroyed) throw new Error('output closed');
            if (!stream.write(buf)) await waitForDrain();
            if (failure) throw failure;
        },
        /** Ends the stream and waits for it to flush. */
        async end() {
            if (stream.destroyed || stream.writableEnded) return;
            await new Promise((resolve) => {
                stream.once('finish', resolve);
                stream.once('close', resolve);
                stream.once('error', resolve);
                stream.end();
            });
            if (failure) throw failure;
        },
    };
}

module.exports = { MatroskaMuxer, fileSink, streamSink, ID, VIDEO_TRACK, AUDIO_TRACK };
