'use strict';

/*
 * Room health meter.
 *
 * Every browser in the room reports, every few seconds, how its own screen shares are doing (frames per
 * second, freezes, what limits the encoder, which encoder or decoder it uses, ...). The server keeps one JSON
 * line per report, so we can see who struggles and measure the real effect of every change before and after.
 *
 * Only numbers and a few short labels are stored: every field is checked against an allowlist here, and
 * nothing is ever sent back to other users. Disabled unless HEALTH_METER_ENABLED=true and HEALTH_DIR is set.
 *
 *   HEALTH_METER_ENABLED=true
 *   HEALTH_DIR=/data/health          one file per day: health-YYYY-MM-DD.jsonl (older days are gzipped)
 *   HEALTH_INTERVAL_S=10             how often each browser reports (5-60)
 *   HEALTH_RETENTION_DAYS=14         how long compressed days are kept
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const Logger = require('./Logger');
const BuildInfo = require('./BuildInfo');
const log = new Logger('HealthMeter');

const FLUSH_MS = 5000;
const MAX_REPORT_BYTES = 12000;
const MAX_RX = 12;
const MAX_TX = 6;
const FILE_RE = /^health-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v * 100) / 100)) : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const text = (v, max = 40) => (typeof v === 'string' && v.length <= max && /^[\w .,:+\-/()@]*$/.test(v) ? v : null);
const pick = (v, allowed) => (allowed.includes(v) ? v : null);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function clean(object) {
    const out = {};
    for (const [key, value] of Object.entries(object)) if (value !== null && value !== undefined) out[key] = value;
    return out;
}

function sanitizeRx(r) {
    if (!r || typeof r !== 'object') return null;
    return clean({
        id: text(r.id, 36),
        // the producer of the stream (the first 8 characters of its id: the same as in the server's records) and who sends it
        pid: text(r.pid, 12),
        from: text(r.from, 40),
        type: pick(r.type, ['screen', 'camera']),
        fps: num(r.fps, 0, 240),
        w: num(r.w, 0, 8192),
        h: num(r.h, 0, 8192),
        kbps: num(r.kbps, 0, 200000),
        loss: num(r.loss, 0, 100),
        frz: num(r.frz, 0, 10000),
        frzMs: num(r.frzMs, 0, 600000),
        drop: num(r.drop, 0, 100000),
        kf: num(r.kf, 0, 10000),
        pli: num(r.pli, 0, 10000),
        nack: num(r.nack, 0, 100000),
        jbMs: num(r.jbMs, 0, 60000),
        dec: text(r.dec),
        hw: bool(r.hw),
        // what this viewer asked of the server for the screen and why (ScreenQuality.js), and the size of its tile
        tl: num(r.tl, 0, 3),
        lw: pick(r.lw, ['full', 'tile', 'struggle', 'pinned', 'floor', 'off']),
        tw: num(r.tw, 0, 16384),
        // how long the decoder takes per frame and how often the video was paused by the browser
        decMs: num(r.decMs, 0, 1000),
        pause: num(r.pause, 0, 10000),
    });
}

function sanitizeTx(t) {
    if (!t || typeof t !== 'object') return null;
    return clean({
        pid: text(t.pid, 12),
        type: pick(t.type, ['screen', 'camera']),
        fps: num(t.fps, 0, 240),
        w: num(t.w, 0, 8192),
        h: num(t.h, 0, 8192),
        kbps: num(t.kbps, 0, 200000),
        tgtKbps: num(t.tgtKbps, 0, 200000),
        lim: pick(t.lim, ['none', 'cpu', 'bandwidth', 'other']),
        limCpuMs: num(t.limCpuMs, 0, 600000),
        limBwMs: num(t.limBwMs, 0, 600000),
        enc: text(t.enc),
        hw: bool(t.hw),
        kf: num(t.kf, 0, 10000),
        pli: num(t.pli, 0, 10000),
        nack: num(t.nack, 0, 100000),
        encMs: num(t.encMs, 0, 1000),
        rtt: num(t.rtt, 0, 60000),
        lost: num(t.lost, 0, 100),
        // the capture: how many frames per second the SOURCE gives and at what size (media-source), and the settings
        // the browser made of the capture (track.getSettings()): tells a capture that is slow from an encoder that is
        srcFps: num(t.srcFps, 0, 1000),
        srcW: num(t.srcW, 0, 16384),
        srcH: num(t.srcH, 0, 16384),
        setW: num(t.setW, 0, 16384),
        setH: num(t.setH, 0, 16384),
        setFps: num(t.setFps, 0, 1000),
        surf: pick(t.surf, ['monitor', 'window', 'browser']),
        // what the encoder was told (and by whom): picture size divisor, bitrate and frame rate ceilings
        scale: num(t.scale, 0, 100),
        maxKbps: num(t.maxKbps, 0, 1000000),
        maxFps: num(t.maxFps, 0, 1000),
        degr: pick(t.degr, ['maintain-framerate', 'maintain-resolution', 'balanced', 'disabled', 'default']),
        hint: pick(t.hint, ['motion', 'detail', 'text', 'none']),
        codec: pick(t.codec, ['VP8', 'VP9', 'H264', 'AV1', 'H265']),
        // retransmitted part of what was sent (loss makes a stream pay twice), key frames and picture size changes
        retx: num(t.retx, 0, 100),
        huge: num(t.huge, 0, 10000),
        qlr: num(t.qlr, 0, 10000),
        sendMs: num(t.sendMs, 0, 60000),
        // the sender guard (SendGuard.js): the step of its ladder, what it decided last and in which mode
        gRung: num(t.gRung, 0, 20),
        gCap: num(t.gCap, 0, 20),
        gWhy: text(t.gWhy, 24),
        gMode: pick(t.gMode, ['observe', 'apply']),
    });
}

const capLabel = (v) => (typeof v === 'string' && /^(hw|sw|no)(!smooth)?$/.test(v) ? v : null);

function sanitizeEnv(e) {
    if (!e || typeof e !== 'object') return null;
    const caps = e.caps && typeof e.caps === 'object' ? e.caps : {};
    return clean({
        browser: text(e.browser, 60),
        os: text(e.os, 60),
        cores: num(e.cores, 0, 1024),
        mem: num(e.mem, 0, 1024),
        gpu: text(e.gpu, 70),
        scr: text(e.scr, 24),
        caps: clean({
            vp8e: capLabel(caps.vp8e),
            h264e: capLabel(caps.h264e),
            h264cbe: capLabel(caps.h264cbe),
            vp8d: capLabel(caps.vp8d),
            h264d: capLabel(caps.h264d),
            vp9e: capLabel(caps.vp9e),
            vp9d: capLabel(caps.vp9d),
            av1e: capLabel(caps.av1e),
            av1d: capLabel(caps.av1d),
        }),
    });
}

function sanitize(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
    let size;
    try {
        size = JSON.stringify(report).length;
    } catch {
        return null;
    }
    if (size > MAX_REPORT_BYTES) return null;

    const rx = (Array.isArray(report.rx) ? report.rx : []).slice(0, MAX_RX).map(sanitizeRx).filter(Boolean);
    const tx = (Array.isArray(report.tx) ? report.tx : []).slice(0, MAX_TX).map(sanitizeTx).filter(Boolean);
    const net = report.net && typeof report.net === 'object' ? clean({
        rtt: num(report.net.rtt, 0, 60000),
        aout: num(report.net.aout, 0, 1000000),
        ain: num(report.net.ain, 0, 1000000),
    }) : null;
    const env = sanitizeEnv(report.env);

    if (!rx.length && !tx.length && !env) return null;
    // press: the worst processor pressure the browser reported for the whole PC in the interval (Compute Pressure API)
    return clean({ dt: num(report.dt, 0, 600000), cb: text(report.cb, 12), vis: bool(report.vis), press: pick(report.press, ['nominal', 'fair', 'serious', 'critical']), net, rx: rx.length ? rx : null, tx: tx.length ? tx : null, env });
}

class HealthMeter {
    constructor(env = process.env) {
        this.dir = env.HEALTH_DIR || '';
        this.enabled = env.HEALTH_METER_ENABLED === 'true' && Boolean(this.dir);
        this.intervalS = Math.min(60, Math.max(5, parseInt(env.HEALTH_INTERVAL_S, 10) || 10));
        this.retentionDays = Math.max(1, parseInt(env.HEALTH_RETENTION_DAYS, 10) || 14);
        this.queue = [];
        this.lastBySocket = new Map();
        this.timer = null;
        this.lastRotation = '';
        this.flushing = false;
        // what this server is: stamped on every record, so a change in what people saw can be tied to a build or a switch
        this.build = BuildInfo.info.sha7;
        this.flags = BuildInfo.flagsOf(env);
    }

    start() {
        if (!this.enabled || this.timer) return;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
        } catch (error) {
            log.warn('Health meter disabled, cannot create the directory', { dir: this.dir, error: error.message });
            this.enabled = false;
            return;
        }
        this.timer = setInterval(() => this.flush(), FLUSH_MS);
        this.timer.unref();
        // a line that says what started: the analysis tools split the day into epochs at these lines
        this.write({ kind: 'epoch', ref: BuildInfo.info.ref || undefined, built: BuildInfo.info.date || undefined, flags: this.flags });
        log.info('Health meter enabled', { dir: this.dir, intervalS: this.intervalS, retentionDays: this.retentionDays, build: this.build, flags: this.flags });
    }

    // A record that the server itself makes (the start of an epoch, what it sees of every stream): same file, same stamp.
    write(fields, now = Date.now()) {
        if (!this.enabled) return false;
        this.queue.push(JSON.stringify({ ts: now, bld: this.build, ...fields }));
        if (this.queue.length > 20000) this.queue.splice(0, this.queue.length - 20000);
        return true;
    }

    // Returns true when the report was accepted.
    record({ socketId, roomId, peerName, report, now = Date.now() }) {
        if (!this.enabled) return false;

        const last = this.lastBySocket.get(socketId) || 0;
        if (now - last < (this.intervalS * 1000) / 2) return false;

        const fields = sanitize(report);
        if (!fields) return false;

        this.lastBySocket.set(socketId, now);
        if (this.lastBySocket.size > 500) this.forgetOld(now);
        this.queue.push(
            JSON.stringify({
                ts: now,
                bld: this.build,
                room: text(String(roomId || ''), 40) || undefined,
                peer: text(String(peerName || ''), 40) || undefined,
                ...fields,
            })
        );
        if (this.queue.length > 20000) this.queue.splice(0, this.queue.length - 20000);
        return true;
    }

    forget(socketId) {
        this.lastBySocket.delete(socketId);
    }

    forgetOld(now) {
        for (const [id, at] of this.lastBySocket) if (now - at > 5 * 60 * 1000) this.lastBySocket.delete(id);
    }

    async flush() {
        if (!this.enabled || this.flushing || !this.queue.length) {
            return this.maintenance();
        }
        this.flushing = true;
        const lines = this.queue.splice(0, this.queue.length);
        try {
            const byDay = new Map();
            for (const line of lines) {
                const day = dayOf(JSON.parse(line).ts);
                if (!byDay.has(day)) byDay.set(day, []);
                byDay.get(day).push(line);
            }
            for (const [day, dayLines] of byDay) {
                await fsp.appendFile(path.join(this.dir, `health-${day}.jsonl`), dayLines.join('\n') + '\n');
            }
        } catch (error) {
            log.warn('Health meter could not write', { error: error.message });
        } finally {
            this.flushing = false;
        }
        return this.maintenance();
    }

    // Once a day: compress the finished days and delete what is older than the retention.
    async maintenance(now = Date.now()) {
        const today = dayOf(now);
        if (this.lastRotation === today) return;
        this.lastRotation = today;
        try {
            const oldest = dayOf(now - this.retentionDays * 24 * 60 * 60 * 1000);
            for (const name of await fsp.readdir(this.dir)) {
                const match = FILE_RE.exec(name);
                if (!match) continue;
                const [, day, gz] = match;
                const file = path.join(this.dir, name);
                if (gz && day < oldest) {
                    await fsp.unlink(file);
                } else if (!gz && day < today) {
                    await pipeline(fs.createReadStream(file), zlib.createGzip({ level: 9 }), fs.createWriteStream(`${file}.gz`));
                    await fsp.unlink(file);
                }
            }
        } catch (error) {
            log.warn('Health meter maintenance failed', { error: error.message });
        }
    }
}

module.exports = HealthMeter;
module.exports.sanitize = sanitize;
