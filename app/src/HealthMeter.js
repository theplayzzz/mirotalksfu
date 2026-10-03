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
const log = new Logger('HealthMeter');

const FLUSH_MS = 5000;
const MAX_REPORT_BYTES = 6000;
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
    });
}

function sanitizeTx(t) {
    if (!t || typeof t !== 'object') return null;
    return clean({
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
        caps: clean({
            vp8e: capLabel(caps.vp8e),
            h264e: capLabel(caps.h264e),
            vp8d: capLabel(caps.vp8d),
            h264d: capLabel(caps.h264d),
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
    return clean({ dt: num(report.dt, 0, 600000), net, rx: rx.length ? rx : null, tx: tx.length ? tx : null, env });
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
        log.info('Health meter enabled', { dir: this.dir, intervalS: this.intervalS, retentionDays: this.retentionDays });
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
