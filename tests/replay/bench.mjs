#!/usr/bin/env node
/**
 * Benchmark of the replay recorder.
 *
 *   node tests/replay/bench.mjs                       10 shares of 12 Mbps 1080p60 video + audio, 30 s
 *   node tests/replay/bench.mjs --shares 4 --mbps 8 --seconds 60 --codec h264
 *   node tests/replay/bench.mjs --mode clip           time to build a clip from a 5 minute buffer (12 Mbps)
 *
 * Ingest mode pushes synthetic RTP (VP8 or H.264 frames of the right size, 20 ms Opus packets, Sender Reports) at
 * the real rate into the real pipeline: UDP sockets, reorder buffers, depacketizers, timestamps, frame ring on disk.
 * The recorder runs in this process (so its CPU and memory are what this process uses); the generator runs in a
 * child process so that its own cost does not count. CPU is in percent of ONE core (all threads of the process:
 * the disk writes of the libuv pool are included). Production runs the recorder on its own core.
 *
 * Clip mode fills a frame ring with 5 minutes of frames in no time (not in real time) and times the clip builder:
 * muxing into FFmpeg, FFmpeg's stream copy (and, for H.264, the AAC encoding of the audio), the thumbnail. The pictures
 * are noise with valid headers (stream copy does not look inside); the audio is real Opus: --audio-kind noise (pink
 * noise, the hardest case for the AAC encoder, default), tone (a sine) or silence.
 */

import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const gen = require(path.join(here, 'lib', 'gen.js'));
const rtp = require(path.join(here, '..', '..', 'app', 'src', 'replay', 'rtp.js'));

function parseArgs(argv) {
    const defaults = {
        mode: 'ingest',
        shares: 10,
        mbps: 12,
        fps: 60,
        seconds: 30,
        codec: 'vp8',
        audio: true,
        warmup: 5,
        'clip-seconds': 300,
        'audio-kind': 'noise',
    };
    const out = { ...defaults };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else {
            out[key] = Number.isNaN(Number(next)) ? next : Number(next);
            i++;
        }
    }
    if (out['no-audio']) out.audio = false;
    return out;
}

/* ------------------------------------------------------------------------------------------ generator ---- */

/** The sending side: runs in a child process. */
async function generator(cfg) {
    const { ports, codec, mbps, fps, seconds, audio } = cfg;
    const noise = crypto.randomBytes(1 << 20);
    const MTU = 1200;
    const frameInterval = 1000 / fps;
    const average = (mbps * 1e6) / 8 / fps;
    const gop = fps * 3;
    const keyBytes = Math.round(average * 8);
    const deltaBytes = Math.round((average * gop - keyBytes) / (gop - 1));
    const sps = gen.h264Sps({ width: 1920, height: 1080, profile: 100, level: 40 });
    const pps = gen.h264Pps();

    const startPerf = performance.now();
    const startWall = Date.now();
    const shares = ports.map((port, i) => ({
        port,
        socket: dgram.createSocket('udp4'),
        videoSsrc: 1000 + i,
        audioSsrc: 5000 + i,
        seq: crypto.randomInt(0, 65536),
        audioSeq: crypto.randomInt(0, 65536),
        videoBase: crypto.randomInt(0, 2 ** 32),
        audioBase: crypto.randomInt(0, 2 ** 32),
        frame: 0,
        audioFrame: 0,
        nextSr: 0,
        phase: (i * frameInterval) / ports.length, // the shares are not in step with each other
        sentPackets: 0,
        sentBytes: 0,
    }));
    let maxLag = 0;
    let lagSum = 0;
    let lagCount = 0;

    // RTP packets and RTCP reports are counted apart: only the RTP ones are compared with what the recorder saw
    const send = (share, buf, rtcp = false) => {
        share.socket.send(buf, share.port, '127.0.0.1');
        if (!rtcp) share.sentPackets++;
        share.sentBytes += buf.length;
    };

    const header = (buf, pt, marker, seq, ts, ssrc) => {
        buf[0] = 0x80;
        buf[1] = (marker ? 0x80 : 0) | pt;
        buf.writeUInt16BE(seq & 0xffff, 2);
        buf.writeUInt32BE(ts >>> 0, 4);
        buf.writeUInt32BE(ssrc, 8);
    };

    let noiseOffset = 0;
    const fill = (buf, from, length) => {
        if (noiseOffset + length > noise.length) noiseOffset = 0;
        noise.copy(buf, from, noiseOffset, noiseOffset + length);
        noiseOffset += length;
    };

    const sendVp8Frame = (share, key, size, ts) => {
        let remaining = size;
        let first = true;
        while (remaining > 0) {
            const chunk = Math.min(remaining, MTU - 1);
            const buf = Buffer.allocUnsafe(13 + chunk);
            header(buf, 101, remaining === chunk, share.seq++, ts, share.videoSsrc);
            buf[12] = first ? 0x10 : 0x00;
            fill(buf, 13, chunk);
            if (first) {
                buf[13] = key ? buf[13] & 0xfe : buf[13] | 0x01; // bit 0 of the frame tag: 0 is a key frame
                if (key && chunk >= 10) {
                    buf[16] = 0x9d;
                    buf[17] = 0x01;
                    buf[18] = 0x2a;
                    buf.writeUInt16LE(1920, 19);
                    buf.writeUInt16LE(1080, 21);
                }
            }
            send(share, buf);
            remaining -= chunk;
            first = false;
        }
    };

    const sendH264Frame = (share, key, size, ts) => {
        const pending = [];
        if (key) {
            const stap = Buffer.allocUnsafe(12 + 1 + 2 + sps.length + 2 + pps.length);
            stap[12] = 0x78;
            stap.writeUInt16BE(sps.length, 13);
            sps.copy(stap, 15);
            stap.writeUInt16BE(pps.length, 15 + sps.length);
            pps.copy(stap, 17 + sps.length);
            pending.push(stap);
        }
        const nalType = key ? 5 : 1;
        let remaining = size;
        let first = true;
        while (remaining > 0) {
            const chunk = Math.min(remaining, MTU - 2);
            const buf = Buffer.allocUnsafe(14 + chunk);
            buf[12] = 0x40 | 28; // FU indicator
            buf[13] = (first ? 0x80 : 0) | (remaining === chunk ? 0x40 : 0) | nalType;
            fill(buf, 14, chunk);
            if (first) buf[14] |= 0x80; // first_mb_in_slice == 0
            pending.push(buf);
            remaining -= chunk;
            first = false;
        }
        pending.forEach((buf, i) => {
            header(buf, 102, i === pending.length - 1, share.seq++, ts, share.videoSsrc);
            send(share, buf);
        });
    };

    const sendAudio = (share, ts) => {
        const buf = Buffer.allocUnsafe(12 + 60);
        header(buf, 100, false, share.audioSeq++, ts, share.audioSsrc);
        fill(buf, 12, 60);
        buf[12] = 0xf8;
        send(share, buf);
    };

    const sendReports = (share, mediaMs) => {
        const wall = startWall + mediaMs;
        send(
            share,
            rtp.buildSenderReport({
                ssrc: share.videoSsrc,
                ntpMs: wall,
                rtpTimestamp: (share.videoBase + Math.round(mediaMs * 90)) >>> 0,
            }),
            true
        );
        if (audio)
            send(
                share,
                rtp.buildSenderReport({
                    ssrc: share.audioSsrc,
                    ntpMs: wall,
                    rtpTimestamp: (share.audioBase + Math.round(mediaMs * 48)) >>> 0,
                }),
                true
            );
    };

    await new Promise((resolve) => {
        const timer = setInterval(() => {
            const now = performance.now() - startPerf;
            for (const share of shares) {
                // video frames that are due
                for (;;) {
                    const mediaMs = share.frame * frameInterval;
                    if (mediaMs + share.phase > now) break;
                    if (mediaMs > seconds * 1000) break;
                    if (mediaMs >= share.nextSr) {
                        sendReports(share, mediaMs);
                        share.nextSr = mediaMs + 1000;
                    }
                    const key = share.frame % gop === 0;
                    const size = key ? keyBytes : deltaBytes;
                    const ts = share.videoBase + Math.round(mediaMs * 90);
                    if (codec === 'h264') sendH264Frame(share, key, size, ts);
                    else sendVp8Frame(share, key, size, ts);
                    const lag = now - (mediaMs + share.phase);
                    lagSum += lag;
                    lagCount++;
                    if (lag > maxLag) maxLag = lag;
                    share.frame++;
                }
                if (audio) {
                    for (;;) {
                        const mediaMs = share.audioFrame * 20;
                        if (mediaMs + share.phase > now || mediaMs > seconds * 1000) break;
                        sendAudio(share, share.audioBase + Math.round(mediaMs * 48));
                        share.audioFrame++;
                    }
                }
            }
            if (now > seconds * 1000 + 200) {
                clearInterval(timer);
                resolve();
            }
        }, 1);
    });
    const usage = process.cpuUsage();
    process.send({
        type: 'done',
        shares: shares.map((s) => ({ sentPackets: s.sentPackets, sentBytes: s.sentBytes, frames: s.frame })),
        maxLagMs: maxLag,
        avgLagMs: lagCount ? lagSum / lagCount : 0,
        cpuSeconds: (usage.user + usage.system) / 1e6,
    });
    shares.forEach((s) => s.socket.close());
}

/* ---------------------------------------------------------------------------------------------- ingest ---- */

const silent = { debug() {}, info() {}, log() {}, warn() {}, error() {} };

function fmt(n, digits = 1) {
    return Number(n).toFixed(digits);
}

async function ingest(args) {
    const { createRecorder } = require(path.join(here, '..', '..', 'app', 'src', 'replay', 'Recorder.js'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-bench-'));
    const secret = crypto.randomBytes(8).toString('hex');
    const recorder = createRecorder({
        dataDir,
        secret,
        listenPort: 0,
        host: '127.0.0.1',
        bindHost: '127.0.0.1',
        recvBufferMb: 8,
        minFreeGb: 0,
        housekeepingMs: 5000,
        log: silent,
    });
    const { port } = await recorder.start();
    const api = async (method, url, body) => {
        const response = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: { 'X-Replay-Secret': secret, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return response.json();
    };

    const ports = [];
    for (let i = 0; i < args.shares; i++) {
        const video =
            args.codec === 'h264'
                ? { codec: 'H264', payloadType: 102, ssrc: 1000 + i, clockRate: 90000 }
                : { codec: 'VP8', payloadType: 101, ssrc: 1000 + i, clockRate: 90000 };
        const body = { shareId: `bench-${i}`, roomId: 'bench', peerName: `share ${i}`, video };
        if (args.audio) body.audio = { codec: 'opus', payloadType: 100, ssrc: 5000 + i, clockRate: 48000, channels: 2 };
        ports.push((await api('POST', '/v1/shares', body)).port);
    }

    const loop = monitorEventLoopDelay({ resolution: 1 });
    const child = fork(
        fileURLToPath(import.meta.url),
        [
            '--generator',
            JSON.stringify({
                ports,
                codec: args.codec,
                mbps: args.mbps,
                fps: args.fps,
                seconds: args.seconds,
                audio: args.audio,
            }),
        ],
        { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }
    );
    const finished = new Promise((resolve) => child.once('message', (m) => m.type === 'done' && resolve(m)));

    // --clips N: N clips of 10 s are asked for while the media keeps coming (the clip builder shares the process
    // and the core with the packet path, so this is the load that matters in production)
    const duringClips = [];
    const clipTimers = [];
    for (let i = 1; i <= (Number(args.clips) || 0); i++) {
        const at = args.warmup * 1000 + ((args.seconds - args.warmup - 3) * 1000 * i) / (Number(args.clips) + 1);
        clipTimers.push(
            setTimeout(async () => {
                const t = Date.now();
                const clip = await api('POST', '/v1/clips', {
                    shareId: `bench-${i % args.shares}`,
                    seconds: 10,
                    requestedByName: 'bench',
                    requestedByHash: 'x',
                    sharerHash: 'y',
                });
                duringClips.push({
                    ms: Date.now() - t,
                    ok: !!clip.id,
                    mb: clip.id ? clip.files.original.bytes / 1048576 : 0,
                });
            }, at)
        );
    }

    const samples = [];
    let last = { usage: process.cpuUsage(), at: performance.now() };
    const started = performance.now();
    let measuring = false;
    const sampler = setInterval(() => {
        const usage = process.cpuUsage();
        const at = performance.now();
        const cpu = ((usage.user + usage.system - (last.usage.user + last.usage.system)) / 1000 / (at - last.at)) * 100;
        last = { usage, at };
        const m = process.memoryUsage();
        if (!measuring && (at - started) / 1000 >= args.warmup) {
            measuring = true;
            loop.enable();
            loop.reset();
        }
        if (measuring)
            samples.push({
                cpu,
                rss: m.rss / 1048576,
                heap: m.heapUsed / 1048576,
                external: (m.external + m.arrayBuffers) / 1048576,
            });
    }, 1000);

    const result = await finished;
    clearInterval(sampler);
    clipTimers.forEach((t) => clearTimeout(t));
    loop.disable();
    await new Promise((resolve) => setTimeout(resolve, 1500)); // the last packets
    const listed = (await api('GET', '/v1/shares')).shares;

    // a clip from what the recorder holds right now (not part of the CPU numbers)
    let clipLine = '';
    if (args.clip) {
        const t = Date.now();
        const clip = await api('POST', '/v1/clips', {
            shareId: 'bench-0',
            seconds: Math.min(args.seconds - 2, 20),
            requestedByName: 'bench',
            requestedByHash: 'x',
            sharerHash: 'y',
        });
        clipLine = clip.id
            ? `clip of the last ${Math.min(args.seconds - 2, 20)} s from the live ring: ${Date.now() - t} ms, ${fmt(clip.files.original.bytes / 1048576)} MB`
            : `clip failed: ${JSON.stringify(clip)}`;
    }

    let packetsReceived = 0;
    let packetsSent = 0;
    let lost = 0;
    let framesStored = 0;
    let bytesStored = 0;
    listed.forEach((share, i) => {
        packetsReceived += share.stats.video.packets + (share.stats.audio ? share.stats.audio.packets : 0);
        packetsSent += result.shares[i].sentPackets;
        lost += share.stats.video.lost + (share.stats.audio ? share.stats.audio.lost : 0);
        framesStored += share.stats.store.framesWritten;
        bytesStored += share.bytes;
    });
    const sentBytes = result.shares.reduce((a, s) => a + s.sentBytes, 0);
    const avg = (key) => samples.reduce((a, s) => a + s[key], 0) / Math.max(1, samples.length);
    const max = (key) => samples.reduce((a, s) => Math.max(a, s[key]), 0);

    console.log('');
    console.log(
        `replay recorder benchmark: ${args.shares} shares x ${args.mbps} Mbps ${args.codec.toUpperCase()} ${args.fps} fps${args.audio ? ' + Opus' : ''}, ${args.seconds} s, ${args.warmup} s warm-up not counted`
    );
    console.log(
        `machine: ${os.cpus()[0].model.trim()}, ${os.cpus().length} cores, ${process.platform}, node ${process.version}`
    );
    console.log(
        `offered load: ${fmt((sentBytes * 8) / args.seconds / 1e6)} Mbps in ${fmt(packetsSent / args.seconds, 0)} packets/s; the generator was late by ${fmt(result.avgLagMs, 2)} ms on average, ${fmt(result.maxLagMs)} ms at most (its own CPU: ${fmt((result.cpuSeconds / args.seconds) * 100, 0)}% of a core)`
    );
    console.log(
        `recorder CPU (percent of one core, ${samples.length} samples of 1 s): average ${fmt(avg('cpu'))}%, peak ${fmt(max('cpu'))}%`
    );
    console.log(
        `recorder memory: RSS average ${fmt(avg('rss'), 0)} MB, peak ${fmt(max('rss'), 0)} MB; JS heap peak ${fmt(max('heap'), 0)} MB; buffers (external) peak ${fmt(max('external'), 0)} MB`
    );
    console.log(
        `event loop delay: mean ${fmt(loop.mean / 1e6, 2)} ms, p99 ${fmt(loop.percentile(99) / 1e6, 2)} ms, max ${fmt(loop.max / 1e6, 2)} ms`
    );
    console.log(
        `packets: ${packetsReceived} received of ${packetsSent} sent (${fmt(100 - (packetsReceived / packetsSent) * 100, 3)}% missing), ${lost} given up by the reorder buffers`
    );
    console.log(
        `stored: ${framesStored} frames, ${fmt(bytesStored / 1048576, 0)} MB in the rings (${fmt(bytesStored / 1048576 / args.seconds)} MB/s)`
    );
    console.log(
        `UDP receive buffer per share: ${fmt(listed[0].stats.recvBufferBytes / 1024, 0)} KB granted by the OS (8192 KB asked; on Linux the limit is net.core.rmem_max of the host)`
    );
    if (clipLine) console.log(clipLine);
    if (duringClips.length) {
        console.log(
            `clips asked for while recording: ${duringClips.map((c) => (c.ok ? `${c.ms} ms (${fmt(c.mb)} MB)` : 'FAILED')).join(', ')}`
        );
    }
    const verdict = avg('cpu') < 60 ? 'below' : 'ABOVE';
    console.log(`target: 10 shares of 12 Mbps below ~60% of one core -> ${verdict} (${fmt(avg('cpu'))}% average)`);

    child.kill();
    await recorder.stop();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/* ------------------------------------------------------------------------------------------------ clip ---- */

async function clipBench(args) {
    const { FrameStore, KIND_AUDIO, KIND_VIDEO } = require(
        path.join(here, '..', '..', 'app', 'src', 'replay', 'FrameStore.js')
    );
    const clip = require(path.join(here, '..', '..', 'app', 'src', 'replay', 'ClipBuilder.js'));
    const { OPUS_SILENCE_FRAME } = require(path.join(here, '..', '..', 'app', 'src', 'replay', 'opus.js'));
    const real = require(path.join(here, 'lib', 'real.js'));
    const seconds = args['clip-seconds'];
    const fps = args.fps;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-bench-clip-'));
    const store = new FrameStore({
        dir: path.join(dir, 'ring'),
        retainMs: (seconds + 60) * 1000,
        chunkMs: 10000,
        flushIntervalMs: 250,
    });
    await store.open();

    const average = (args.mbps * 1e6) / 8 / fps;
    const gop = fps * 3;
    const keyBytes = Math.round(average * 8);
    const deltaBytes = Math.round((average * gop - keyBytes) / (gop - 1));
    let keyFrame;
    let deltaFrame;
    if (args.codec === 'h264') {
        const sps = gen.h264Sps({ width: 1920, height: 1080, profile: 100, level: 40 });
        const pps = gen.h264Pps();
        const au = (nals) =>
            Buffer.concat(
                nals.flatMap((n) => [
                    Buffer.from([
                        (n.length >>> 24) & 255,
                        (n.length >>> 16) & 255,
                        (n.length >>> 8) & 255,
                        n.length & 255,
                    ]),
                    n,
                ])
            );
        keyFrame = au([sps, pps, gen.h264Nal(5, keyBytes)]);
        deltaFrame = au([gen.h264Nal(1, deltaBytes)]);
    } else {
        keyFrame = gen.vp8Frame({ key: true, size: keyBytes, width: 1920, height: 1080 });
        deltaFrame = gen.vp8Frame({ key: false, size: deltaBytes });
    }

    // Real Opus packets (10 s of the chosen sound, encoded by FFmpeg), repeated; silence frames when asked for.
    let opusLoop = null;
    if (args['audio-kind'] !== 'silence') {
        const sources = { noise: 'anoisesrc=c=pink:r=48000:a=0.3', tone: 'sine=frequency=440:sample_rate=48000' };
        const sampleFile = await real.encode({
            dir,
            name: 'audio',
            codec: 'vp8',
            seconds: 10,
            fps: 10,
            gop: 10,
            width: 64,
            height: 64,
            audioSource: sources[args['audio-kind']] || sources.noise,
        });
        opusLoop = real.loadFrames(sampleFile).audio;
    }
    const loopMs = opusLoop ? opusLoop[opusLoop.length - 1].tsMs + 20 : 0;

    const T0 = Date.now() - seconds * 1000;
    const started = Date.now();
    const frames = Math.round(seconds * fps);
    let audioTs = 0;
    let audioIndex = 0;
    for (let i = 0; i < frames; i++) {
        const tsMs = T0 + (i * 1000) / fps;
        store.append(KIND_VIDEO, i % gop === 0, tsMs, i % gop === 0 ? keyFrame : deltaFrame);
        while (audioTs <= (i * 1000) / fps) {
            const data = opusLoop ? opusLoop[audioIndex++ % opusLoop.length].data : OPUS_SILENCE_FRAME;
            store.append(KIND_AUDIO, true, T0 + audioTs, data);
            audioTs += 20;
        }
        // The fill is not in real time: let the disk keep up, as it does in real life, instead of dropping frames.
        if (store.queuedBytes > 16 * 1048576) await store.flush();
        else if (i % 600 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const snapshot = await store.snapshot();
    const fillMs = Date.now() - started;
    const ringBytes = snapshot.chunks.reduce((a, c) => a + c.bytes, 0);
    if (store.stats.dropped > 0)
        console.log(`WARNING: ${store.stats.dropped} frames were dropped while filling the ring`);

    const plan = clip.selectRange(snapshot, seconds);
    const stagingDir = path.join(dir, 'clip');
    fs.mkdirSync(stagingDir);
    // The build runs in the recorder's own process, next to the packet loop: how long does it block the loop?
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    const t = Date.now();
    const { meta, timings } = await clip.buildClip({
        snapshot,
        plan,
        share: {
            id: 'bench',
            roomId: 'bench',
            peerName: 'bench',
            codec: args.codec,
            hasAudioStream: true,
            audioChannels: 2,
        },
        request: { seconds, requestedByName: 'bench', requestedByHash: 'x', sharerHash: 'y' },
        id: clip.generateClipId(),
        stagingDir,
        ffmpegPath: process.env.REPLAY_FFMPEG_PATH || 'ffmpeg',
        retentionDays: 7,
        log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const totalMs = Date.now() - t;
    loop.disable();
    snapshot.release();
    await store.close();

    console.log('');
    console.log(
        `clip benchmark: ${seconds} s of ${args.codec.toUpperCase()} ${args.fps} fps at ${args.mbps} Mbps + Opus (${args['audio-kind']}), ${os.cpus()[0].model.trim()}, ${process.platform}`
    );
    console.log(
        `ring: ${fmt(ringBytes / 1048576, 0)} MB in ${snapshot.chunks.length} chunks (filled in ${fillMs} ms, not in real time)`
    );
    console.log(
        `clip: ${fmt(meta.files.original.bytes / 1048576, 0)} MB ${meta.files.original.name}, ${meta.durationS} s long, built in ${totalMs} ms (muxing + FFmpeg ${timings.finalizeMs} ms, thumbnail ${totalMs - timings.finalizeMs} ms)`
    );
    console.log(
        `event loop while building: mean ${fmt(loop.mean / 1e6, 2)} ms, p99 ${fmt(loop.percentile(99) / 1e6, 2)} ms, max ${fmt(loop.max / 1e6, 2)} ms (the timer asks for 1 ms)`
    );
    console.log(`target: under 3000 ms -> ${totalMs < 3000 ? 'met' : 'NOT met'}`);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/* ------------------------------------------------------------------------------------------------ main ---- */

if (process.argv[2] === '--generator') {
    generator(JSON.parse(process.argv[3])).catch((error) => {
        console.error(error);
        process.exit(1);
    });
} else {
    const args = parseArgs(process.argv.slice(2));
    (args.mode === 'clip' ? clipBench(args) : ingest(args)).then(
        () => process.exit(0),
        (error) => {
            console.error(error);
            process.exit(1);
        }
    );
}
