'use strict';

/**
 * Synthetic RTP source for the end-to-end tests: FFmpeg encodes a test pattern and a tone and sends one RTP stream
 * per media (`-f rtp`); a small forwarder relays them to the recorder from ONE UDP socket, the way mediasoup sends
 * the video and the audio of a share (rtcpMux), and plays the part of the SFU for the feedback:
 *
 *   - Sender Reports: the ones of FFmpeg ('ffmpeg'), mediasoup style, built from the arrival time of the packets
 *     ('sfu'), built from the RTP timestamps so that both streams share one instant ('ideal'), or none.
 *   - NACKs from the recorder are answered with the packet again, same SSRC and sequence number (retransmit).
 *   - PLIs from the recorder are counted.
 *   - Packets can be dropped or reordered on the way to test the recovery.
 */

const dgram = require('node:dgram');
const { spawn } = require('node:child_process');

const rtp = require('../../../app/src/replay/rtp');

function bind(socket, address = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind({ port: 0, address }, () => {
            socket.off('error', reject);
            try {
                // FFmpeg sends a key frame as a burst; the test process must not lose any of it
                socket.setRecvBufferSize(8 * 1024 * 1024);
            } catch {
                // the OS keeps its default
            }
            resolve(socket.address().port);
        });
    });
}

class RtpFeed {
    /**
     * @param {object} o
     * @param {'vp8'|'h264'} o.codec
     * @param {number} o.seconds how long FFmpeg runs
     * @param {boolean} [o.audio]
     * @param {'ffmpeg'|'sfu'|'ideal'|'none'} [o.sr]
     * @param {boolean} [o.retransmit] answer NACKs
     * @param {function} [o.drop] (kind, index, header) => true to lose that packet on the way
     * @param {function} [o.reorder] (kind, index) => true to swap that packet with the next one
     * @param {string} [o.videoSource] lavfi source of the picture
     * @param {string} [o.audioSource] lavfi source of the sound
     * @param {number} [o.gop] key frame interval in frames
     * @param {number} [o.fps]
     */
    constructor(o) {
        this.o = { audio: true, sr: 'ffmpeg', retransmit: true, gop: 30, fps: 30, width: 640, height: 360, ...o };
        this.sockets = {};
        this.out = null;
        this.target = null;
        this.stats = {
            sent: { video: 0, audio: 0 },
            dropped: 0,
            reordered: 0,
            retransmitted: 0,
            nacks: 0,
            plis: 0,
            rtcp: 0,
        };
        this.cache = new Map(); // ssrc -> Map(seq -> packet)
        this.index = { video: 0, audio: 0 };
        this.held = null;
        this.lastTs = {};
        this.firstTs = {};
        this.firstAt = null;
        this.timer = null;
        this.child = null;
        this.stderr = '';
    }

    get streams() {
        return this._streams;
    }

    /** Opens the local sockets and works out the Stream objects to register with the recorder. */
    async prepare() {
        const { codec } = this.o;
        const vp = codec === 'vp8';
        this._streams = {
            video: {
                codec: vp ? 'VP8' : 'H264',
                payloadType: vp ? 101 : 102,
                ssrc: vp ? 1111 : 2222,
                clockRate: 90000,
            },
        };
        if (this.o.audio)
            this._streams.audio = { codec: 'opus', payloadType: 100, ssrc: 3333, clockRate: 48000, channels: 2 };

        this.out = dgram.createSocket('udp4');
        await bind(this.out);
        this.out.on('message', (msg) => this._onRecorderPacket(msg));
        const kinds = this.o.audio ? ['video', 'audio'] : ['video'];
        this.ports = {};
        for (const kind of kinds) {
            const rtpSocket = dgram.createSocket('udp4');
            const rtcpSocket = dgram.createSocket('udp4');
            this.ports[kind] = { rtp: await bind(rtpSocket), rtcp: await bind(rtcpSocket) };
            this.sockets[kind] = { rtp: rtpSocket, rtcp: rtcpSocket };
            rtpSocket.on('message', (msg) => this._onMediaPacket(kind, msg));
            rtcpSocket.on('message', (msg) => this._onMediaRtcp(kind, msg));
        }
        return this._streams;
    }

    setTarget(port) {
        this.target = port;
    }

    _ffmpegArgs() {
        const { codec, seconds, fps, gop, width, height } = this.o;
        const args = ['-v', 'error', '-nostdin'];
        args.push(
            '-re',
            '-t',
            String(seconds),
            '-f',
            'lavfi',
            '-i',
            this.o.videoSource || `testsrc2=size=${width}x${height}:rate=${fps}`
        );
        if (this.o.audio) {
            args.push(
                '-re',
                '-t',
                String(seconds),
                '-f',
                'lavfi',
                '-i',
                this.o.audioSource || 'sine=frequency=440:sample_rate=48000'
            );
        }
        const { video, audio } = this._streams;
        args.push('-map', '0:v');
        if (codec === 'vp8') {
            args.push(
                '-c:v',
                'libvpx',
                '-deadline',
                'realtime',
                '-cpu-used',
                '8',
                '-b:v',
                '800k',
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
            if (this.o.x264Params) args.push('-x264-params', this.o.x264Params);
        }
        args.push('-payload_type', String(video.payloadType), '-ssrc', String(video.ssrc), '-f', 'rtp');
        args.push(`rtp://127.0.0.1:${this.ports.video.rtp}?rtcpport=${this.ports.video.rtcp}`);
        if (audio) {
            args.push('-map', '1:a', '-c:a', 'libopus', '-b:a', '64k', '-ac', '2', '-ar', '48000');
            args.push('-payload_type', String(audio.payloadType), '-ssrc', String(audio.ssrc), '-f', 'rtp');
            args.push(`rtp://127.0.0.1:${this.ports.audio.rtp}?rtcpport=${this.ports.audio.rtcp}`);
        }
        return args;
    }

    /** Runs FFmpeg to the end and relays its packets. Resolves when everything was sent. */
    async run() {
        if (!this.target) throw new Error('setTarget() first');
        if (this.o.sr === 'sfu' || this.o.sr === 'ideal') {
            this.timer = setInterval(() => this._sendSenderReports(), 1000);
        }
        this.child = spawn('ffmpeg', this._ffmpegArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
        this.child.stderr.on('data', (d) => {
            this.stderr += d.toString();
        });
        const code = await new Promise((resolve, reject) => {
            this.child.once('error', reject);
            this.child.once('close', resolve);
        });
        await new Promise((resolve) => setTimeout(resolve, 400)); // packets still in flight
        this._flushHeld();
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (code !== 0) throw new Error(`ffmpeg exited with ${code}: ${this.stderr}`);
    }

    stop() {
        if (this.child && this.child.exitCode === null) this.child.kill('SIGKILL');
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        for (const pair of Object.values(this.sockets)) {
            for (const socket of Object.values(pair)) {
                try {
                    socket.close();
                } catch {
                    // already closed
                }
            }
        }
        this.sockets = {};
        if (this.out) {
            try {
                this.out.close();
            } catch {
                // already closed
            }
            this.out = null;
        }
    }

    _send(buf) {
        if (this.out) this.out.send(buf, this.target, '127.0.0.1');
    }

    _onMediaPacket(kind, msg) {
        const h = rtp.parseRtp(msg);
        if (!h) return;
        const now = Date.now();
        if (this.firstAt === null && kind === 'video') this.firstAt = now;
        if (this.firstTs[kind] === undefined) this.firstTs[kind] = h.timestamp;
        const last = this.lastTs[kind];
        if (!last || rtp.tsDiff(h.timestamp, last.ts) > 0) this.lastTs[kind] = { ts: h.timestamp, at: now };
        const index = this.index[kind]++;

        // keep it for retransmission, whatever happens to it on the way
        let cache = this.cache.get(h.ssrc);
        if (!cache) this.cache.set(h.ssrc, (cache = new Map()));
        cache.set(h.sequenceNumber, msg);
        if (cache.size > 3000) cache.delete(cache.keys().next().value);

        if (this.o.drop && this.o.drop(kind, index, h)) {
            this.stats.dropped++;
            return;
        }
        if (this.o.reorder && this.o.reorder(kind, index)) {
            if (this.held) this._flushHeld();
            this.held = msg;
            this.stats.reordered++;
            return;
        }
        this._send(msg);
        this.stats.sent[kind]++;
        if (this.held) this._flushHeld();
    }

    _flushHeld() {
        if (!this.held) return;
        this._send(this.held);
        this.held = null;
    }

    _onMediaRtcp(kind, msg) {
        if (this.o.sr !== 'ffmpeg') return;
        this.stats.rtcp++;
        this._send(msg);
    }

    _sendSenderReports() {
        const now = Date.now();
        for (const kind of Object.keys(this.sockets)) {
            const stream = this._streams[kind];
            const last = this.lastTs[kind];
            if (!last) continue;
            let rtpTimestamp;
            if (this.o.sr === 'sfu') {
                // mediasoup: the RTP timestamp of the newest packet, moved forward by the time since it arrived
                rtpTimestamp = (last.ts + Math.round(((now - last.at) * stream.clockRate) / 1000)) >>> 0;
            } else {
                // ideal sender: every stream is at its first timestamp at the instant the first video packet came
                rtpTimestamp =
                    (this.firstTs[kind] + Math.round(((now - this.firstAt) * stream.clockRate) / 1000)) >>> 0;
            }
            this._send(
                rtp.buildSenderReport({ ssrc: stream.ssrc, ntpMs: now, rtpTimestamp, packetCount: this.index[kind] })
            );
            this.stats.rtcp++;
        }
    }

    _onRecorderPacket(msg) {
        if (!rtp.isRtcp(msg)) return;
        for (const packet of rtp.parseRtcp(msg)) {
            if (packet.type === 'pli') this.stats.plis++;
            if (packet.type === 'nack') {
                this.stats.nacks++;
                if (!this.o.retransmit) continue;
                const cache = this.cache.get(packet.mediaSsrc);
                if (!cache) continue;
                for (const seq of packet.seqs) {
                    const original = cache.get(seq);
                    if (original) {
                        this._send(original);
                        this.stats.retransmitted++;
                    }
                }
            }
        }
    }
}

module.exports = { RtpFeed };
