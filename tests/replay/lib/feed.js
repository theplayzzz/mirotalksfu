'use strict';

/**
 * Feeds a recorder with media in virtual time: real frames (read from an FFmpeg encode by lib/real.js) are
 * packetized by our own packetizers and sent to the share's UDP port as fast as the recorder takes them, with Sender
 * Reports that describe the media timeline (NTP = wall clock at the start + media time). A minute of media goes in
 * under a second, so the tests of clips, quota, retention and restarts do not have to wait in real time.
 */

const dgram = require('node:dgram');

const rtp = require('../../../app/src/replay/rtp');
const h264 = require('../../../app/src/replay/h264');
const gen = require('./gen');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VIDEO = {
    vp8: { codec: 'VP8', payloadType: 101, ssrc: 1111 },
    h264: { codec: 'H264', payloadType: 102, ssrc: 2222 },
};
const AUDIO = { codec: 'opus', payloadType: 100, ssrc: 3333, clockRate: 48000, channels: 2 };

/** The Stream objects of a registration. */
function streamsFor(codec, { audio = true } = {}) {
    return { video: { ...VIDEO[codec], clockRate: 90000 }, ...(audio ? { audio: { ...AUDIO } } : {}) };
}

class VirtualFeed {
    /**
     * @param {object} o
     * @param {number} o.port UDP port of the share
     * @param {object} o.frames result of real.loadFrames()
     * @param {object} o.streams result of streamsFor()
     * @param {number} [o.t0] wall clock of media time 0 (default: now)
     * @param {number} [o.srEveryMs] media time between Sender Reports
     * @param {function} [o.drop] (kind, packetIndex) => true to lose the packet
     * @param {function} [o.swap] (kind, packetIndex) => true to swap the packet with the next one
     * @param {boolean} [o.retransmit] answer NACKs with the packet again, like the SFU does
     * @param {number} [o.videoBase] first RTP timestamp of the video (default: wraps after 5 s)
     * @param {number} [o.seqBase] first sequence number (default: wraps after a few packets)
     */
    constructor(o) {
        this.o = {
            srEveryMs: 500,
            videoBase: 4294967296 - 450000,
            audioBase: 4294967296 - 100000,
            seqBase: 65500,
            ...o,
        };
        this.t0 = o.t0 ?? Date.now();
        this.socket = dgram.createSocket('udp4');
        this.seq = { video: this.o.seqBase, audio: this.o.seqBase + 1000 };
        this.packetIndex = { video: 0, audio: 0 };
        this.sent = 0;
        this.nextSr = -Infinity;
        this.received = []; // what the recorder sent back (NACK, PLI)
        this.cache = new Map(); // "ssrc:seq" -> packet, for retransmissions
        this.retransmitted = 0;
        this.socket.on('message', (msg) => {
            if (!rtp.isRtcp(msg)) return;
            for (const packet of rtp.parseRtcp(msg)) {
                this.received.push(packet);
                if (packet.type === 'nack' && this.o.retransmit) {
                    for (const seq of packet.seqs) {
                        const original = this.cache.get(`${packet.mediaSsrc}:${seq}`);
                        if (original) {
                            this.retransmitted++;
                            this.socket.send(original, this.o.port, '127.0.0.1');
                        }
                    }
                }
            }
        });
    }

    close() {
        try {
            this.socket.close();
        } catch {
            // already closed
        }
    }

    _rtpTs(kind, tsMs) {
        const base = kind === 'video' ? this.o.videoBase : this.o.audioBase;
        const rate = kind === 'video' ? 90 : 48;
        return (base + Math.round(tsMs * rate)) >>> 0;
    }

    _packets(kind, frame) {
        const { streams, frames } = this.o;
        const ts = this._rtpTs(kind, frame.tsMs);
        if (kind === 'audio') {
            const packet = gen.opusRtp(frame.data, {
                timestamp: ts,
                ssrc: streams.audio.ssrc,
                payloadType: streams.audio.payloadType,
                sequenceNumber: this.seq.audio,
            });
            this.seq.audio = (this.seq.audio + 1) & 0xffff;
            return [packet];
        }
        const common = {
            timestamp: ts,
            ssrc: streams.video.ssrc,
            payloadType: streams.video.payloadType,
            firstSeq: this.seq.video,
        };
        let packets;
        if (frames.codec === 'vp8') {
            packets = gen.vp8Packets(frame.data, { ...common, extension: 'pid15', pictureId: frame.tsMs & 0x7fff });
        } else {
            packets = gen.h264Packets(h264.avccNals(frame.data), common);
        }
        this.seq.video = (this.seq.video + packets.length) & 0xffff;
        return packets;
    }

    _senderReports(tsMs) {
        const { streams } = this.o;
        const reports = [
            rtp.buildSenderReport({
                ssrc: streams.video.ssrc,
                ntpMs: this.t0 + tsMs,
                rtpTimestamp: this._rtpTs('video', tsMs),
            }),
        ];
        if (streams.audio) {
            reports.push(
                rtp.buildSenderReport({
                    ssrc: streams.audio.ssrc,
                    ntpMs: this.t0 + tsMs,
                    rtpTimestamp: this._rtpTs('audio', tsMs),
                })
            );
        }
        return reports;
    }

    _send(buf) {
        return new Promise((resolve) => this.socket.send(buf, this.o.port, '127.0.0.1', () => resolve()));
    }

    /**
     * Sends the frames whose media time is in [from, to) (ms of the sample), in time order.
     * @returns {Promise<number>} number of RTP packets sent
     */
    async send({ from = -Infinity, to = Infinity, audio = true } = {}) {
        const { frames, drop, swap } = this.o;
        const all = [];
        for (const f of frames.video) if (f.tsMs >= from && f.tsMs < to) all.push({ kind: 'video', ...f });
        if (audio && this.o.streams.audio)
            for (const f of frames.audio) if (f.tsMs >= from && f.tsMs < to) all.push({ kind: 'audio', ...f });
        all.sort((a, b) => a.tsMs - b.tsMs || (a.kind === 'audio' ? -1 : 1));

        let count = 0;
        let held = null;
        for (const frame of all) {
            if (frame.tsMs >= this.nextSr) {
                for (const sr of this._senderReports(frame.tsMs)) await this._send(sr);
                this.nextSr = frame.tsMs + this.o.srEveryMs;
            }
            for (const packet of this._packets(frame.kind, frame)) {
                const index = this.packetIndex[frame.kind]++;
                this.cache.set(`${packet.readUInt32BE(8)}:${packet.readUInt16BE(2)}`, packet);
                if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value);
                if (drop && drop(frame.kind, index)) continue;
                if (swap && swap(frame.kind, index) && !held) {
                    held = packet;
                    continue;
                }
                await this._send(packet);
                count++;
                if (held) {
                    await this._send(held);
                    count++;
                    held = null;
                }
                if (++this.sent % 40 === 0) await sleep(1);
            }
        }
        if (held) {
            await this._send(held);
            count++;
        }
        return count;
    }
}

/** Waits until the recorder has turned the packets into frames (the counters stop moving). */
async function settle(api, shareId, { minFrames = 1, quietMs = 150, timeoutMs = 20000 } = {}) {
    const start = Date.now();
    let last = -1;
    let lastChange = Date.now();
    for (;;) {
        const { body } = await api.get('/v1/shares');
        const share = body.shares.find((s) => s.shareId === shareId);
        const frames = share
            ? (share.stats.video ? share.stats.video.frames : 0) + (share.stats.audio ? share.stats.audio.frames : 0)
            : 0;
        if (frames !== last) {
            last = frames;
            lastChange = Date.now();
        } else if (frames >= minFrames && Date.now() - lastChange >= quietMs) {
            return share;
        }
        if (Date.now() - start > timeoutMs) throw new Error(`the recorder did not settle (frames ${frames})`);
        await sleep(25);
    }
}

/** Polls until check() is truthy (it may be async); throws after timeoutMs. Tests use it instead of fixed sleeps. */
async function eventually(check, { timeoutMs = 10000, intervalMs = 20, message = 'condition' } = {}) {
    const start = Date.now();
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${message}`);
        await sleep(intervalMs);
    }
}

module.exports = { VirtualFeed, streamsFor, settle, sleep, eventually };
