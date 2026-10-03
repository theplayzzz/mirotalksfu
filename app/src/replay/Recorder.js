'use strict';

/**
 * The replay recorder: a passive process that keeps the last minutes of every shared screen on disk and makes
 * clips on request (docs/REPLAY.md).
 *
 *   node app/src/replay/Recorder.js            runs it, configured by the REPLAY_* environment variables
 *   const { createRecorder } = require('./Recorder')    starts one in-process (the tests do this)
 *
 * What it does:
 *   - HTTP control API (section 3 of the design) on REPLAY_LISTEN_PORT, every request carrying X-Replay-Secret.
 *   - One UDP socket per share, where the SFU sends the RTP and RTCP of its video and audio (see Share.js).
 *   - A ring of frame log chunks per share on disk (FrameStore.js), a clip builder (ClipBuilder.js), an MP4 converter
 *     with a queue (Mp4Converter.js), events to the SFU (EventSink.js).
 *   - Disk guard, quota and retention of the clips, cleanup of what a crash left behind.
 *
 * Nothing in the media path waits for the HTTP side, the disk, FFmpeg or the SFU.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const { HttpError } = require('./errors');
const { EventSink } = require('./EventSink');
const { FrameStore } = require('./FrameStore');
const { Share, normalizeStream } = require('./Share');
const { Mp4Converter } = require('./Mp4Converter');
const { selectRange, buildClip, generateClipId } = require('./ClipBuilder');

const GIB = 1024 * 1024 * 1024;
const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const CLIP_ID_RE = /^[a-z0-9-]{8,64}$/;
const MAX_ACTIVE_SHARES = 32;
const MAX_CONCURRENT_BUILDS = 2;
const REQUEST_DEDUPE_MS = 10 * 60 * 1000;

function readPackageVersion() {
    try {
        return require('../../../package.json').version;
    } catch {
        return 'unknown';
    }
}

/** The project's Logger when it can be loaded (it needs config.js), a plain console logger otherwise. */
function defaultLogger() {
    try {
        const Logger = require('../Logger');
        return new Logger('Replay');
    } catch {
        const line = (level, message, extra) =>
            console[level](`[replay] ${message}`, extra === undefined || extra === '' ? '' : extra);
        return {
            debug: () => {},
            log: (m, e) => line('log', m, e),
            info: (m, e) => line('info', m, e),
            warn: (m, e) => line('warn', m, e),
            error: (m, e) => line('error', m, e),
        };
    }
}

const num = (value, fallback) => {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};

/** The options of createRecorder from the REPLAY_* environment variables (section 1 of the design). */
function optionsFromEnv(env = process.env) {
    return {
        listenPort: num(env.REPLAY_LISTEN_PORT, 7000),
        host: env.REPLAY_LISTEN_HOST || '0.0.0.0',
        bindHost: env.REPLAY_BIND_HOST || '0.0.0.0',
        dataDir: env.REPLAY_DATA_DIR || '/data/replays',
        eventsUrl: env.REPLAY_SFU_EVENTS_URL || '',
        secret: env.REPLAY_INTERNAL_SECRET || '',
        bufferSeconds: num(env.REPLAY_BUFFER_SECONDS, 300),
        leadInSeconds: num(env.REPLAY_LEAD_IN_SECONDS, 90),
        keepAfterEndS: num(env.REPLAY_KEEP_AFTER_END_S, 120),
        retentionDays: num(env.REPLAY_RETENTION_DAYS, 7),
        quotaGb: num(env.REPLAY_QUOTA_GB, 20),
        minFreeGb: num(env.REPLAY_MIN_FREE_GB, 10),
        mp4Height: num(env.REPLAY_MP4_HEIGHT, 720),
        ffmpegThreads: num(env.REPLAY_FFMPEG_THREADS, 2),
        ffmpegPath: env.REPLAY_FFMPEG_PATH || 'ffmpeg',
        recvBufferMb: num(env.REPLAY_RECV_BUFFER_MB, 8),
    };
}

function resolveOptions(o) {
    if (!o.dataDir) throw new Error('dataDir is required');
    if (!o.secret) throw new Error('a secret is required: the control API must not be open');
    return {
        listenPort: 7000,
        host: '0.0.0.0',
        bindHost: '0.0.0.0',
        eventsUrl: '',
        bufferSeconds: 300,
        leadInSeconds: 90,
        keepAfterEndS: 120,
        retentionDays: 7,
        quotaGb: 20,
        minFreeGb: 10,
        mp4Height: 720,
        ffmpegThreads: 2,
        ffmpegPath: 'ffmpeg',
        recvBufferMb: 8,
        chunkMs: 10000,
        holdMs: 300,
        tickMs: 10,
        housekeepingMs: 5000,
        sweepMs: 60 * 60 * 1000,
        receiver: {},
        eventSink: {},
        ...o,
    };
}

async function dirBytes(dir) {
    let total = 0;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (entry.isFile()) total += (await fsp.stat(path.join(dir, entry.name))).size;
    }
    return total;
}

function readJsonBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let failed = false;
        req.on('data', (chunk) => {
            if (failed) return;
            size += chunk.length;
            if (size > limit) {
                failed = true;
                reject(new HttpError(413, 'TOO_LARGE', 'the request body is too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (failed) return;
            if (size === 0) return resolve({});
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                    return reject(new HttpError(400, 'BAD_JSON', 'the body must be a JSON object'));
                }
                resolve(body);
            } catch {
                reject(new HttpError(400, 'BAD_JSON', 'the body is not valid JSON'));
            }
        });
        req.on('error', (error) => {
            if (!failed) reject(error);
        });
    });
}

/** A string field of a request. Names are cut to `max` characters; with `strict` (identifiers) a longer value is refused. */
function text(value, name, { max = 200, required = false, strict = false } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw new HttpError(400, 'BAD_REQUEST', `${name} is required`);
        return '';
    }
    if (typeof value !== 'string') throw new HttpError(400, 'BAD_REQUEST', `${name} must be a string`);
    if (value.length > max) {
        if (strict) throw new HttpError(400, 'BAD_REQUEST', `${name} is too long`);
        return value.slice(0, max);
    }
    return value;
}

class Recorder extends EventEmitter {
    constructor(options) {
        super();
        this.opts = resolveOptions(options);
        this.log = this.opts.log || defaultLogger();
        this.now = this.opts.now || Date.now;
        this.secretDigest = crypto.createHash('sha256').update(String(this.opts.secret)).digest();
        this.buffersDir = path.join(this.opts.dataDir, 'buffers');
        this.clipsDir = path.join(this.opts.dataDir, 'clips');
        this.version = readPackageVersion();
        this.bootId = crypto.randomBytes(6).toString('hex');
        this.startedAt = 0;

        this.shares = new Map();
        this.registering = new Map();
        this.clips = new Map(); // id -> { meta, bytes }
        this.requests = new Map(); // requestId -> { promise, at }
        this.metaWrites = new Map();
        this.builds = { active: 0, waiting: [] };
        this.abort = new AbortController();

        this.sink = new EventSink({
            url: this.opts.eventsUrl,
            secret: this.opts.secret,
            log: this.log,
            ...this.opts.eventSink,
        });
        this.converter = new Mp4Converter({
            ffmpegPath: this.opts.ffmpegPath,
            height: this.opts.mp4Height,
            threads: this.opts.ffmpegThreads,
            calibrationPath: path.join(this.opts.dataDir, 'mp4-calibration.json'),
            log: this.log,
            now: this.now,
        });
        this._wireConverter();

        this.server = null;
        this.httpPort = 0;
        this.timers = [];
        this.diskFreeBytes = null;
        this.diskLow = false;
        this.cpuPercent = 0;
        this.cpuLast = { usage: process.cpuUsage(), at: process.hrtime.bigint() };
        this.stopping = false;
        this.routes = this._routes();
    }

    /* ------------------------------------------------------------------------------------ lifecycle ---- */

    async start() {
        await fsp.mkdir(this.buffersDir, { recursive: true });
        await fsp.mkdir(this.clipsDir, { recursive: true });
        await this._cleanupAtStartup();
        await this._loadClips();
        await this._sweepClips();
        await this._refreshDisk();

        this.server = http.createServer((req, res) => {
            this._onRequest(req, res).catch((error) => {
                this.log.error(`replay: request failed: ${error.message}`);
                if (!res.headersSent) res.writeHead(500);
                res.end();
            });
        });
        // The SFU reuses its connections: keep idle ones open longer than its own idle timeout, so it never sends a
        // request on a connection that is just being closed.
        this.server.keepAliveTimeout = 65000;
        this.server.headersTimeout = 66000;
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.opts.listenPort, this.opts.host, () => {
                this.server.off('error', reject);
                resolve();
            });
        });
        this.httpPort = this.server.address().port;
        this.startedAt = this.now();

        const every = (fn, ms) => {
            const timer = setInterval(() => {
                Promise.resolve()
                    .then(fn)
                    .catch((error) => this.log.error(`replay: periodic task failed: ${error.message}`));
            }, ms);
            timer.unref();
            this.timers.push(timer);
        };
        every(() => this._tick(), this.opts.tickMs);
        every(() => this._housekeeping(), this.opts.housekeepingMs);
        every(() => this._sweepClips(), this.opts.sweepMs);
        this.log.info(`replay: recorder listening on ${this.opts.host}:${this.httpPort}, data in ${this.opts.dataDir}`);
        return { port: this.httpPort };
    }

    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        this.abort.abort();
        if (this.server) {
            await new Promise((resolve) => {
                this.server.close(resolve);
                if (this.server.closeAllConnections) this.server.closeAllConnections();
            });
        }
        await this.converter.stop();
        await Promise.all([...this.shares.values()].map((share) => share.end().catch(() => {})));
        await this.sink.close();
        this.log.info('replay: recorder stopped');
    }

    /** The buffers do not survive a restart, and nothing half written may stay in the clips. */
    async _cleanupAtStartup() {
        for (const entry of await fsp.readdir(this.buffersDir)) {
            await fsp.rm(path.join(this.buffersDir, entry), { recursive: true, force: true, maxRetries: 3 });
        }
        for (const entry of await fsp.readdir(this.clipsDir, { withFileTypes: true })) {
            const full = path.join(this.clipsDir, entry.name);
            if (!entry.isDirectory()) {
                await fsp.rm(full, { force: true });
            } else if (entry.name.startsWith('.tmp-')) {
                await fsp.rm(full, { recursive: true, force: true, maxRetries: 3 });
            }
        }
    }

    async _loadClips() {
        for (const entry of await fsp.readdir(this.clipsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(this.clipsDir, entry.name);
            try {
                const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
                if (meta.id !== entry.name || !CLIP_ID_RE.test(meta.id))
                    throw new Error('meta does not match the directory');
                for (const file of await fsp.readdir(dir)) {
                    if (file.endsWith('.part') || file.endsWith('.tmp'))
                        await fsp.rm(path.join(dir, file), { force: true });
                }
                this.clips.set(meta.id, { meta, bytes: await dirBytes(dir) });
            } catch (error) {
                this.log.warn(`replay: removing the unusable clip directory ${entry.name}: ${error.message}`);
                await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
            }
        }
        this.log.info(`replay: ${this.clips.size} clips found on disk`);
    }

    /* --------------------------------------------------------------------------------------- events ---- */

    _event(event) {
        try {
            this.emit('event', event);
        } catch (error) {
            this.log.error(`replay: an event listener failed: ${error.message}`);
        }
        this.sink.send(event);
    }

    _wireConverter() {
        this.converter.on('progress', (e) =>
            this._event({
                type: 'mp4.progress',
                id: e.id,
                progress: e.progress,
                etaSeconds: e.etaSeconds,
                phase: e.phase,
            })
        );
        this.converter.on('ready', (e) => {
            this._onMp4Ready(e).catch((error) => {
                this.log.error(`replay: MP4 of ${e.id} could not be registered: ${error.message}`);
                this._event({ type: 'mp4.error', id: e.id, message: error.message });
            });
        });
        this.converter.on('failed', (e) => this._event({ type: 'mp4.error', id: e.id, message: e.message }));
    }

    async _onMp4Ready(e) {
        const entry = this.clips.get(e.id);
        if (!entry) return; // the clip was deleted while it was converting
        entry.meta.files.mp4 = { name: e.mp4.name, mime: 'video/mp4', bytes: e.mp4.bytes };
        entry.bytes = await dirBytes(path.join(this.clipsDir, e.id));
        await this._writeMeta(entry.meta);
        this._event({ type: 'mp4.ready', id: e.id, mp4: { name: e.mp4.name, bytes: e.mp4.bytes } });
        await this._enforceQuota(e.id);
    }

    /** meta.json is replaced atomically, and writes of one clip are serialized. */
    _writeMeta(meta) {
        const previous = this.metaWrites.get(meta.id) || Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(async () => {
                const target = path.join(this.clipsDir, meta.id, 'meta.json');
                await fsp.writeFile(`${target}.tmp`, JSON.stringify(meta, null, 2));
                await fsp.rename(`${target}.tmp`, target);
            });
        this.metaWrites.set(meta.id, next);
        next.finally(() => {
            if (this.metaWrites.get(meta.id) === next) this.metaWrites.delete(meta.id);
        }).catch(() => {});
        return next;
    }

    /* ---------------------------------------------------------------------------------- periodic work ---- */

    _tick() {
        const now = this.now();
        for (const share of this.shares.values()) share.tick(now);
    }

    async _housekeeping() {
        this._sampleCpu();
        await this._guardDisk();
        await this._sweepShares();
        const now = this.now();
        for (const [requestId, entry] of this.requests) {
            if (now - entry.at > REQUEST_DEDUPE_MS) this.requests.delete(requestId);
        }
        this._emitBuffers();
    }

    _sampleCpu() {
        const usage = process.cpuUsage();
        const at = process.hrtime.bigint();
        const used = usage.user + usage.system - (this.cpuLast.usage.user + this.cpuLast.usage.system);
        const wall = Number(at - this.cpuLast.at) / 1000;
        if (wall > 0) this.cpuPercent = Math.round((used / wall) * 1000) / 10;
        this.cpuLast = { usage, at };
    }

    _emitBuffers() {
        const shares = [];
        for (const share of this.shares.values()) {
            if (share.ended) continue;
            const d = share.describe(this.opts.bufferSeconds);
            shares.push({ shareId: d.shareId, bufferSeconds: d.bufferSeconds, codec: d.codec, hasAudio: d.hasAudio });
        }
        this._event({ type: 'buffers', shares, diskFreeGb: this._diskFreeGb() });
    }

    _diskFreeGb() {
        return this.diskFreeBytes === null ? null : Math.round((this.diskFreeBytes / GIB) * 100) / 100;
    }

    async _refreshDisk() {
        try {
            const stat = await fsp.statfs(this.opts.dataDir);
            this.diskFreeBytes = Number(stat.bavail) * Number(stat.bsize);
        } catch {
            this.diskFreeBytes = null;
        }
    }

    /**
     * Disk guard: below REPLAY_MIN_FREE_GB the oldest clips are deleted until there is room again; if that is not
     * enough the shares stop writing (the SFU hears about it from diskFreeGb and pauses the recorder consumers)
     * until there is a little more than the minimum free.
     */
    async _guardDisk() {
        await this._refreshDisk();
        if (this.diskFreeBytes === null) return;
        const min = this.opts.minFreeGb * GIB;
        if (this.diskFreeBytes < min) await this._reclaim(min);
        const low = this.diskLow ? this.diskFreeBytes < min + 0.5 * GIB : this.diskFreeBytes < min;
        if (low !== this.diskLow) {
            this.diskLow = low;
            this.log.warn(
                low ? 'replay: low disk space, the recorder stops writing' : 'replay: disk space is back, writing again'
            );
            for (const share of this.shares.values()) share.diskLow = low;
        }
    }

    /** Deletes the oldest clips until `target` bytes are free or there are none. */
    async _reclaim(target) {
        const oldest = [...this.clips.values()].sort((a, b) => a.meta.createdAt - b.meta.createdAt);
        for (const entry of oldest) {
            if (this.diskFreeBytes >= target) return;
            this.log.warn(`replay: low disk space: deleting clip ${entry.meta.id}`);
            await this._removeClip(entry.meta.id);
            await this._refreshDisk();
        }
    }

    async _sweepShares() {
        const now = this.now();
        for (const share of [...this.shares.values()]) {
            if (!share.ended || now - share.endedAt < this.opts.keepAfterEndS * 1000) continue;
            if (share.store.pinCount > 0) continue; // a clip is being made from it
            await this._removeShare(share);
        }
    }

    async _removeShare(share) {
        this.shares.delete(share.id);
        await share.end().catch(() => {});
        await share.store
            .destroy()
            .catch((error) => this.log.warn(`replay: cannot delete the buffer of ${share.id}: ${error.message}`));
        this.log.info(`replay: buffer of share ${share.id} deleted`);
    }

    /** Expired clips and clips over the quota (oldest first). */
    async _sweepClips() {
        const now = this.now();
        for (const entry of [...this.clips.values()]) {
            if (entry.meta.expiresAt <= now) {
                this.log.info(`replay: clip ${entry.meta.id} expired`);
                await this._removeClip(entry.meta.id);
            }
        }
        await this._enforceQuota(null);
    }

    _clipBytes() {
        let total = 0;
        for (const entry of this.clips.values()) total += entry.bytes;
        return total;
    }

    async _enforceQuota(keepId) {
        const limit = this.opts.quotaGb * GIB;
        if (this._clipBytes() <= limit) return;
        const oldest = [...this.clips.values()]
            .filter((e) => e.meta.id !== keepId)
            .sort((a, b) => a.meta.createdAt - b.meta.createdAt);
        for (const entry of oldest) {
            if (this._clipBytes() <= limit) return;
            this.log.info(`replay: over the quota: deleting clip ${entry.meta.id}`);
            await this._removeClip(entry.meta.id);
        }
    }

    /** Deletes a clip (and its conversion, if any) and tells the SFU. */
    async _removeClip(id) {
        const entry = this.clips.get(id);
        if (!entry) return false;
        this.clips.delete(id);
        await this.converter.cancel(id);
        await this.metaWrites.get(id)?.catch(() => {});
        await fsp.rm(path.join(this.clipsDir, id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        this._event({ type: 'clip.deleted', id });
        return true;
    }

    /* ------------------------------------------------------------------------------------------ HTTP ---- */

    _authorized(req) {
        const header = req.headers['x-replay-secret'];
        if (typeof header !== 'string' || header.length === 0) return false;
        const digest = crypto.createHash('sha256').update(header).digest();
        return crypto.timingSafeEqual(digest, this.secretDigest);
    }

    _routes() {
        return [
            ['GET', /^\/v1\/health$/, () => this.health()],
            ['POST', /^\/v1\/shares$/, (c) => this.registerShare(c.body)],
            ['GET', /^\/v1\/shares$/, () => this.listShares()],
            ['PATCH', /^\/v1\/shares\/([^/]+)$/, (c) => this.patchShare(c.params[0], c.body)],
            ['DELETE', /^\/v1\/shares\/([^/]+)$/, (c) => this.endShare(c.params[0])],
            ['POST', /^\/v1\/clips$/, (c) => this.createClip(c.body)],
            ['GET', /^\/v1\/clips$/, () => this.listClips()],
            ['GET', /^\/v1\/clips\/([^/]+)$/, (c) => this.getClip(c.params[0])],
            ['DELETE', /^\/v1\/clips\/([^/]+)$/, (c) => this.deleteClip(c.params[0])],
            ['POST', /^\/v1\/clips\/([^/]+)\/mp4$/, (c) => this.requestMp4(c.params[0])],
        ];
    }

    async _onRequest(req, res) {
        let status = 200;
        let payload;
        try {
            if (!this._authorized(req)) throw new HttpError(401, 'UNAUTHORIZED', 'missing or wrong secret');
            const url = new URL(req.url, 'http://recorder');
            let route = null;
            let params = null;
            let pathMatched = false;
            for (const [method, pattern, handler] of this.routes) {
                const match = pattern.exec(url.pathname);
                if (!match) continue;
                pathMatched = true;
                if (method !== req.method) continue;
                route = handler;
                try {
                    params = match.slice(1).map((p) => decodeURIComponent(p));
                } catch {
                    throw new HttpError(400, 'BAD_REQUEST', 'the path is not valid');
                }
                break;
            }
            if (!route) {
                throw pathMatched
                    ? new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed here`)
                    : new HttpError(404, 'NOT_FOUND', 'unknown endpoint');
            }
            const body = req.method === 'POST' || req.method === 'PATCH' ? await readJsonBody(req) : {};
            payload = await route({ params, body, url });
        } catch (error) {
            if (error instanceof HttpError) {
                status = error.status;
                payload = { error: error.message, code: error.code };
            } else {
                this.log.error(
                    `replay: ${req.method} ${req.url} failed: ${error && error.stack ? error.stack : error}`
                );
                status = 500;
                payload = { error: 'internal error', code: 'INTERNAL' };
            }
        }
        const body = Buffer.from(JSON.stringify(payload));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
        res.end(body);
    }

    /* ------------------------------------------------------------------------------------ endpoints ---- */

    health() {
        let active = 0;
        for (const share of this.shares.values()) if (!share.ended) active++;
        return {
            ok: true,
            version: this.version,
            diskFreeGb: this._diskFreeGb(),
            shares: active,
            conversions: this.converter.counts(),
            cpuPercent: this.cpuPercent,
            // extras for operators and for the SFU bridge: a new bootId means the recorder restarted (and forgot its shares)
            bootId: this.bootId,
            startedAt: this.startedAt,
            diskLow: this.diskLow,
            rssMb: Math.round(process.memoryUsage().rss / 1048576),
        };
    }

    listShares() {
        return {
            shares: [...this.shares.values()].map((share) => ({
                ...share.describe(this.opts.bufferSeconds),
                stats: share.detail(),
            })),
        };
    }

    async registerShare(body) {
        const shareId = text(body.shareId, 'shareId', { max: 100, required: true, strict: true });
        if (!SHARE_ID_RE.test(shareId))
            throw new HttpError(400, 'BAD_REQUEST', 'shareId has characters that are not allowed');
        const pending = this.registering.get(shareId);
        if (pending) return pending;
        const work = this._registerShare(shareId, body).finally(() => this.registering.delete(shareId));
        this.registering.set(shareId, work);
        return work;
    }

    async _registerShare(shareId, body) {
        if (this.stopping) throw new HttpError(503, 'STOPPING', 'the recorder is shutting down');
        const roomId = text(body.roomId, 'roomId');
        const peerName = text(body.peerName, 'peerName');
        const video = normalizeStream(body.video, 'video');
        const audio = body.audio ? normalizeStream(body.audio, 'audio') : null;
        if (audio && audio.ssrc === video.ssrc)
            throw new HttpError(400, 'BAD_STREAM', 'audio.ssrc is the same as the video one');

        const existing = this.shares.get(shareId);
        if (existing && !existing.ended) {
            // The SFU asking again (a retry): same share, same port.
            if (audio) existing.setAudio(audio);
            return { port: existing.port };
        }
        if (existing) await this._removeShare(existing); // an old life of the same id
        let active = 0;
        for (const share of this.shares.values()) if (!share.ended) active++;
        if (active >= MAX_ACTIVE_SHARES)
            throw new HttpError(503, 'TOO_MANY_SHARES', 'too many shares are being recorded');

        const dir = path.join(this.buffersDir, shareId);
        await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
        const store = new FrameStore({
            dir,
            retainMs: (this.opts.bufferSeconds + this.opts.leadInSeconds) * 1000,
            chunkMs: this.opts.chunkMs,
            holdMs: this.opts.holdMs,
            info: { shareId, roomId, peerName, codec: video.codec, hasAudio: !!audio, startedAt: this.now() },
            log: this.log,
            now: this.now,
        });
        await store.open();
        const share = new Share({
            id: shareId,
            roomId,
            peerName,
            video,
            audio,
            store,
            senderSsrc: crypto.randomInt(1, 2 ** 32),
            options: { receiver: this.opts.receiver },
            log: this.log,
            now: this.now,
        });
        share.diskLow = this.diskLow;
        try {
            await share.bind(this.opts.bindHost, Math.round(this.opts.recvBufferMb * 1048576));
        } catch (error) {
            await store.destroy().catch(() => {});
            this.log.error(`replay: cannot open a UDP socket for share ${shareId}: ${error.message}`);
            throw new HttpError(500, 'SOCKET_FAILED', 'cannot open the UDP socket');
        }
        this.shares.set(shareId, share);
        this.log.info(
            `replay: share ${shareId} (${peerName || 'unnamed'}, ${video.codec}${audio ? ' + opus' : ''}) on UDP port ${share.port}, ` +
                `receive buffer ${share.recvBufferBytes} bytes`
        );
        if (share.recvBufferBytes && share.recvBufferBytes < 2 * 1048576) {
            this.log.warn(
                `replay: the OS gave only ${share.recvBufferBytes} bytes of UDP receive buffer; raise net.core.rmem_max on the host ` +
                    'or packets will be lost when the recorder is busy'
            );
        }
        this._emitBuffers();
        return { port: share.port };
    }

    _share(id) {
        const share = this.shares.get(id);
        if (!share) throw new HttpError(404, 'SHARE_NOT_FOUND', 'no such share');
        return share;
    }

    async patchShare(id, body) {
        const share = this._share(id);
        if (body.audio === undefined && body.paused === undefined) {
            throw new HttpError(400, 'BAD_REQUEST', 'nothing to change: send audio and/or paused');
        }
        if (share.ended) throw new HttpError(409, 'SHARE_ENDED', 'the share has ended');
        if (body.paused !== undefined && typeof body.paused !== 'boolean')
            throw new HttpError(400, 'BAD_REQUEST', 'paused must be a boolean');
        const audio = body.audio ? normalizeStream(body.audio, 'audio') : null;
        if (body.audio !== undefined && !audio) throw new HttpError(400, 'BAD_STREAM', 'audio must be a Stream');
        if (audio) share.setAudio(audio);
        if (body.paused !== undefined) share.setPaused(body.paused, this.now());
        this._emitBuffers();
        return { ok: true };
    }

    async endShare(id) {
        const share = this._share(id);
        await share.end();
        this.log.info(`replay: share ${id} ended; its buffer stays ${this.opts.keepAfterEndS} s`);
        return { ok: true };
    }

    listClips() {
        const clips = [...this.clips.values()].map((e) => e.meta).sort((a, b) => b.createdAt - a.createdAt);
        return { clips };
    }

    getClip(id) {
        if (!CLIP_ID_RE.test(id)) throw new HttpError(404, 'CLIP_NOT_FOUND', 'no such clip');
        const entry = this.clips.get(id);
        if (!entry) throw new HttpError(404, 'CLIP_NOT_FOUND', 'no such clip');
        return entry.meta;
    }

    async deleteClip(id) {
        this.getClip(id);
        await this._removeClip(id);
        return { ok: true };
    }

    async requestMp4(id) {
        const meta = this.getClip(id);
        const mp4Path = path.join(this.clipsDir, id, 'clip.mp4');
        if (meta.files.mp4 && fs.existsSync(mp4Path)) return { state: 'ready', progress: 1, etaSeconds: 0 };
        if (meta.codec !== 'vp8' || !meta.files.original || meta.files.original.name !== 'clip.webm') {
            throw new HttpError(409, 'NOT_CONVERTIBLE', 'this clip has no source to convert');
        }
        if (this.stopping) throw new HttpError(503, 'STOPPING', 'the recorder is shutting down');
        const state = this.converter.enqueue({
            id,
            dir: path.join(this.clipsDir, id),
            inputName: meta.files.original.name,
            durationS: meta.durationS,
            startOffsetS: meta.startOffsetS,
        });
        return {
            state: state.state,
            progress: state.progress,
            etaSeconds: state.etaSeconds,
            phase: state.phase,
            ahead: state.ahead,
        };
    }

    /* ------------------------------------------------------------------------------------------ clips ---- */

    async createClip(body) {
        const shareId = text(body.shareId, 'shareId', { max: 100, required: true, strict: true });
        const seconds = Number(body.seconds);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > this.opts.bufferSeconds) {
            throw new HttpError(400, 'BAD_REQUEST', `seconds must be between 1 and ${this.opts.bufferSeconds}`);
        }
        const request = {
            seconds,
            requestedByName: text(body.requestedByName, 'requestedByName'),
            requestedByHash: text(body.requestedByHash, 'requestedByHash', { max: 500 }),
            sharerHash: text(body.sharerHash, 'sharerHash', { max: 500 }),
        };
        const requestId = text(body.requestId, 'requestId', { max: 100, strict: true });
        const share = this._share(shareId);
        if (this.stopping) throw new HttpError(503, 'STOPPING', 'the recorder is shutting down');

        // The SFU may ask twice for the same request (a retry after a timeout): one clip is made.
        if (requestId) {
            const known = this.requests.get(requestId);
            if (known) return known.promise;
        }
        const promise = this._withBuildSlot(() => this._buildClip(share, request));
        if (requestId) {
            this.requests.set(requestId, { promise, at: this.now() });
            promise.catch(() => this.requests.delete(requestId)); // a failed request can be tried again
        }
        return promise;
    }

    async _withBuildSlot(task) {
        if (this.builds.active >= MAX_CONCURRENT_BUILDS) {
            await new Promise((resolve) => this.builds.waiting.push(resolve));
        } else {
            this.builds.active++;
        }
        try {
            return await task();
        } finally {
            const next = this.builds.waiting.shift();
            if (next) next();
            else this.builds.active--;
        }
    }

    async _buildClip(share, request) {
        if (this.diskLow) {
            await this._reclaim(this.opts.minFreeGb * GIB);
            await this._guardDisk();
            if (this.diskLow) throw new HttpError(503, 'DISK_LOW', 'not enough free disk space to make a clip');
        }
        const snapshot = await share.store.snapshot();
        let stagingDir = null;
        try {
            const plan = selectRange(snapshot, request.seconds);
            if (!plan) throw new HttpError(409, 'NOT_READY', 'the share has no key frame yet: try again in a moment');
            const id = generateClipId(this.now());
            stagingDir = path.join(this.clipsDir, `.tmp-${id}`);
            await fsp.mkdir(stagingDir);
            const common = {
                snapshot,
                plan,
                share: {
                    id: share.id,
                    roomId: share.roomId,
                    peerName: share.peerName,
                    codec: share.codec,
                    hasAudioStream: share.hasAudio,
                    audioChannels: share.audioStream ? share.audioStream.channels : 2,
                },
                request,
                id,
                stagingDir,
                ffmpegPath: this.opts.ffmpegPath,
                retentionDays: this.opts.retentionDays,
                log: this.log,
                now: this.now,
                signal: this.abort.signal,
            };
            let built;
            try {
                built = await buildClip(common);
            } catch (error) {
                if (!error.retryWithoutAudio) throw error;
                built = await buildClip({ ...common, withAudio: false });
            }
            await fsp.rename(stagingDir, path.join(this.clipsDir, id));
            stagingDir = null;
            const meta = built.meta;
            this.clips.set(id, { meta, bytes: await dirBytes(path.join(this.clipsDir, id)) });
            await this._enforceQuota(id);
            this._event({ type: 'clip.created', clip: meta });
            return meta;
        } catch (error) {
            if (error instanceof HttpError) throw error;
            this.log.error(`replay: clip of share ${share.id} failed: ${error.message}`);
            throw new HttpError(500, 'CLIP_FAILED', `the clip could not be made: ${error.message}`.slice(0, 300));
        } finally {
            snapshot.release();
            if (stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
        }
    }
}

/** Creates a recorder (not started). Options: see optionsFromEnv; `log`, `now`, `receiver`... are for tests. */
function createRecorder(options) {
    return new Recorder(options);
}

async function main() {
    const log = defaultLogger();
    const options = optionsFromEnv(process.env);
    if (!options.secret) {
        log.error('REPLAY_INTERNAL_SECRET is not set: refusing to start with an open control API');
        process.exit(1);
    }
    const recorder = createRecorder({ ...options, log });
    await recorder.start();

    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info(`replay: ${signal} received, shutting down`);
        const killer = setTimeout(() => process.exit(1), 10000);
        killer.unref();
        await recorder.stop().catch((error) => log.error(`replay: error while stopping: ${error.message}`));
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) =>
        log.error(`replay: unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`)
    );
    process.on('uncaughtException', (error) => {
        log.error(`replay: uncaught exception: ${error.stack || error}`);
        process.exit(1);
    });
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[replay] cannot start: ${error.stack || error}`);
        process.exit(1);
    });
}

module.exports = { createRecorder, Recorder, optionsFromEnv, GIB };
