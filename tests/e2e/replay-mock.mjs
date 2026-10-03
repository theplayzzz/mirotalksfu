// A stand-in for the server side of the replay feature (docs/REPLAY.md, section 6), so the gallery and the room
// button can be developed and tested without the SFU, the recorder or any secret.
//
//   node tests/e2e/replay-mock.mjs            # http://127.0.0.1:3099/replay/?from=room (clips to look at)
//   PORT=4000 FFMPEG=ffmpeg node tests/e2e/replay-mock.mjs
//
// What it does (Node 22, no dependencies):
//   - serves public/ (css, js, images), the gallery at /replay/, and /config like the real server;
//   - serves the room harness at /__harness/room.html (tests/e2e/replay-room-harness.html);
//   - the whole API of section 6 with clips in memory: list, one clip, media with Range, download, MP4 conversion,
//     delete (only for who asked or shared), the access cookie, the ticket and password flows, 401, Server-Sent Events;
//   - makes its own sample clips with the local ffmpeg (WebM VP8+Opus with a beep, an MP4, a thumbnail) and keeps
//     them in a temporary folder, so a start after the first one is instant;
//   - control endpoints under /__mock/ for tests (create a clip, drive the MP4 conversion, fail it, delete, ...).
//
// The access cookie is made like the real one (HttpOnly, SameSite=Lax, Path=/replay/, 30 days) except Secure, which a
// plain http mock cannot use. The password of the 401 form is MOCK_REPLAY_PASSWORD (default "mock-password"): a value
// that only exists in this mock.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SAMPLES_VERSION = '3';

// The browser peer id the tests use (localStorage.peer_uuid) and that "mine" clips belong to.
export const TEST_PEER = 'test-peer-0001';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
};
const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

// ---- sample clips (ffmpeg) ---------------------------------------------------------------------------------------

// `a` is a 16:9 screen, `b` a longer portrait one (a phone screen). The frame shows its own clock, so what the
// player starts at is visible; the audio is a beep every second.
const SAMPLES = {
    a: { size: '1280x720', fps: 30, seconds: 20, hz: 440, startOffsetS: 3, askedS: 17 },
    b: { size: '540x960', fps: 24, seconds: 45, hz: 660, startOffsetS: 5, askedS: 40 },
};

function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-1500)));
        child.on('error', (error) => reject(new Error(`${command} could not start: ${error.message}`)));
        child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}\n${stderr}`))
        );
    });
}

export async function ensureSamples({ ffmpeg = process.env.FFMPEG || 'ffmpeg', dir } = {}) {
    dir ||= process.env.E2E_MEDIA_DIR || path.join(tmpdir(), 'replay-ui-samples');
    mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, `ready-v${SAMPLES_VERSION}`);
    const files = {};
    for (const key of Object.keys(SAMPLES)) {
        files[key] = {
            webm: path.join(dir, `sample-${key}.webm`),
            mp4: path.join(dir, `sample-${key}.mp4`),
            thumb: path.join(dir, `sample-${key}.jpg`),
        };
    }
    if (!existsSync(marker)) {
        await Promise.all(
            Object.entries(SAMPLES).map(async ([key, spec]) => {
                const out = files[key];
                await run(ffmpeg, [
                    '-y',
                    '-v',
                    'error',
                    '-f',
                    'lavfi',
                    '-i',
                    `testsrc=size=${spec.size}:rate=${spec.fps}`,
                    '-f',
                    'lavfi',
                    '-i',
                    `sine=frequency=${spec.hz}:beep_factor=4:sample_rate=48000`,
                    '-t',
                    String(spec.seconds),
                    '-c:v',
                    'libvpx',
                    '-deadline',
                    'realtime',
                    '-cpu-used',
                    '8',
                    '-b:v',
                    '700k',
                    '-g',
                    String(spec.fps * 2),
                    '-pix_fmt',
                    'yuv420p',
                    '-c:a',
                    'libopus',
                    '-b:a',
                    '48k',
                    out.webm,
                ]);
                await Promise.all([
                    run(ffmpeg, [
                        '-y',
                        '-v',
                        'error',
                        '-i',
                        out.webm,
                        '-vf',
                        'scale=-2:360',
                        '-c:v',
                        'libx264',
                        '-preset',
                        'veryfast',
                        '-crf',
                        '30',
                        '-pix_fmt',
                        'yuv420p',
                        '-c:a',
                        'aac',
                        '-b:a',
                        '48k',
                        '-movflags',
                        '+faststart',
                        out.mp4,
                    ]),
                    run(ffmpeg, [
                        '-y',
                        '-v',
                        'error',
                        '-ss',
                        '4',
                        '-i',
                        out.webm,
                        '-frames:v',
                        '1',
                        '-vf',
                        'scale=480:-2',
                        '-q:v',
                        '5',
                        out.thumb,
                    ]),
                ]);
            })
        );
        writeFileSync(marker, new Date().toISOString());
    }
    return files;
}

// ---- helpers -----------------------------------------------------------------------------------------------------

const json = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        ...headers,
    });
    res.end(text);
};

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) throw new Error('body too large');
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}

function cookieOf(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return rest.join('=');
    }
    return '';
}

function newClipId(now = new Date()) {
    const p = (n, l = 2) => String(n).padStart(l, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    return `${stamp}-${randomBytes(4).toString('hex')}-${randomBytes(2).toString('hex')}`;
}

const safeName = (text) =>
    String(text)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'tela';

// ---- the mock ----------------------------------------------------------------------------------------------------

export async function startMock({ port = 0, host = '127.0.0.1', samplesDir, ffmpeg, quiet = true } = {}) {
    const samples = await ensureSamples({ ffmpeg, dir: samplesDir });
    const publicDir = path.join(repoRoot, 'public');
    const galleryPage = path.join(publicDir, 'views', 'Replay.html');
    const harnessPage = path.join(here, 'replay-room-harness.html');

    const defaults = () => ({
        requireAuth: false, // true: the API answers 401 until the cookie exists (ticket or password)
        password: process.env.MOCK_REPLAY_PASSWORD || 'mock-password',
        maxLoginFailures: 4, // then 429 for lockMs
        lockMs: 4000,
        replayEnabled: true,
        maxSeconds: 300,
        options: [60, 120, 180, 300],
        retentionDays: 7,
        sseFormat: 'named', // 'named' (event: clip.created) or 'plain' (data only, type inside)
        sseMuted: false, // true: the stream stays open but says nothing (the page must ask for the MP4 progress)
        heartbeatMs: 25000,
        listDelayMs: 0,
        listStatus: 0, // a status to answer the list with (500, ...) to test the error state
        mp4: { mode: 'manual', seconds: 8, ahead: 0 }, // 'auto' makes the conversion run by itself
        me: TEST_PEER,
    });

    const state = {
        config: defaults(),
        clips: new Map(),
        sessions: new Set(),
        tickets: new Set(),
        sse: new Set(),
        timers: new Set(),
        stats: { sessions: 0, logins: 0, badLogins: 0, deletes: 0, mp4Requests: 0, listRequests: 0 },
        failures: 0,
        lockedUntil: 0,
        log: [],
    };

    // -- clips

    const publicMeta = (rec) => ({
        id: rec.id,
        shareId: rec.shareId,
        roomId: rec.roomId,
        createdAt: rec.createdAt,
        expiresAt: rec.expiresAt,
        sharer: rec.sharer,
        requestedBy: rec.requestedBy,
        seconds: rec.seconds,
        durationS: rec.durationS,
        startOffsetS: rec.startOffsetS,
        codec: rec.codec,
        hasAudio: rec.hasAudio,
        files: {
            original: rec.files.original,
            mp4: rec.files.mp4,
        },
        thumb: 'thumb.jpg',
    });
    const withMine = (rec, peer) => ({ ...publicMeta(rec), mine: !!peer && rec.owners.includes(peer) });

    function createClip(options = {}) {
        const key = options.sample === 'b' ? 'b' : 'a';
        const spec = SAMPLES[key];
        const now = Date.now();
        const createdAt = options.createdAt ?? now - (options.ageMs ?? 90_000);
        const original = statSync(samples[key].webm);
        const id = options.id || newClipId(new Date(createdAt));
        const rec = {
            id,
            key,
            shareId: `share-${randomBytes(3).toString('hex')}`,
            roomId: 'link',
            createdAt,
            expiresAt:
                options.expiresAt ?? createdAt + (options.retentionMs ?? state.config.retentionDays * 86_400_000),
            sharer: options.sharer ?? 'Beltrano',
            requestedBy: options.requestedBy ?? 'Fulano',
            seconds: options.seconds ?? spec.askedS,
            durationS: options.durationS ?? spec.seconds,
            startOffsetS: options.startOffsetS ?? spec.startOffsetS,
            codec: 'vp8',
            hasAudio: true,
            owners: options.owners || (options.mine ? [state.config.me] : []),
            files: {
                original: { name: 'clip.webm', mime: 'video/webm', bytes: options.originalBytes ?? original.size },
                mp4: null,
            },
            mp4: { state: 'none', progress: 0, etaSeconds: null, ahead: 0, timer: null },
        };
        state.clips.set(id, rec);
        if (options.withMp4) attachMp4(rec);
        if (options.emit !== false) broadcast('clip.created', { clip: publicMeta(rec) });
        return rec;
    }

    function attachMp4(rec) {
        const stat = statSync(samples[rec.key].mp4);
        rec.files.mp4 = { name: 'clip.mp4', mime: 'video/mp4', bytes: stat.size };
        rec.mp4 = { state: 'ready', progress: 1, etaSeconds: 0, ahead: 0, timer: null };
    }

    function deleteClip(id) {
        const rec = state.clips.get(id);
        if (!rec) return false;
        if (rec.mp4.timer) clearInterval(rec.mp4.timer);
        state.clips.delete(id);
        broadcast('clip.deleted', { id });
        return true;
    }

    const newestFirst = () => [...state.clips.values()].sort((a, b) => b.createdAt - a.createdAt);

    // -- the MP4 conversion

    function mp4Answer(rec) {
        const m = rec.mp4;
        const answer = { state: m.state, progress: m.progress, etaSeconds: m.etaSeconds };
        if (m.state === 'queued' && m.ahead !== null) answer.ahead = m.ahead; // null: the count is not known
        return answer;
    }

    function setMp4(rec, patch) {
        const m = rec.mp4;
        if (patch.state === 'ready') {
            if (m.timer) clearInterval(m.timer);
            attachMp4(rec);
            broadcast('mp4.ready', { id: rec.id, mp4: { name: 'clip.mp4', bytes: rec.files.mp4.bytes } });
            return;
        }
        if (patch.state === 'error') {
            if (m.timer) clearInterval(m.timer);
            Object.assign(m, { state: 'error', timer: null });
            broadcast('mp4.error', { id: rec.id, message: patch.message || 'ffmpeg exited with 1' });
            return;
        }
        if (patch.state) m.state = patch.state;
        if (patch.progress !== undefined) m.progress = patch.progress;
        if (patch.etaSeconds !== undefined) m.etaSeconds = patch.etaSeconds;
        if (patch.ahead !== undefined) m.ahead = patch.ahead;
        if (m.state === 'running' || patch.emit) {
            const event = { id: rec.id, progress: m.progress, etaSeconds: m.etaSeconds };
            if (patch.ahead !== undefined && m.ahead !== null) event.ahead = m.ahead;
            broadcast('mp4.progress', event);
        }
    }

    function startMp4(rec) {
        const { mode, seconds, ahead } = state.config.mp4;
        rec.mp4 = {
            state: ahead > 0 ? 'queued' : 'running',
            progress: 0,
            etaSeconds: ahead > 0 ? null : seconds,
            ahead,
            timer: null,
        };
        if (mode !== 'auto' || ahead > 0) return;
        const startedAt = Date.now();
        rec.mp4.timer = setInterval(() => {
            const elapsed = (Date.now() - startedAt) / 1000;
            if (elapsed >= seconds) return setMp4(rec, { state: 'ready' });
            setMp4(rec, { state: 'running', progress: elapsed / seconds, etaSeconds: seconds - elapsed });
        }, 250);
        state.timers.add(rec.mp4.timer);
    }

    // -- server-sent events

    function broadcast(type, payload) {
        if (state.config.sseMuted) return;
        const data = JSON.stringify({ type, ...payload });
        const message = state.config.sseFormat === 'plain' ? `data: ${data}\n\n` : `event: ${type}\ndata: ${data}\n\n`;
        for (const res of state.sse) res.write(message);
    }

    // The heartbeat comment (every 25 s like the real server) is checked often so a test can shorten the period.
    let lastBeat = Date.now();
    const beatTimer = setInterval(() => {
        if (Date.now() - lastBeat < state.config.heartbeatMs) return;
        lastBeat = Date.now();
        for (const res of state.sse) res.write(': heartbeat\n\n');
    }, 250);

    // -- access

    function grantCookie(res) {
        const token = randomBytes(16).toString('hex');
        state.sessions.add(token);
        res.setHeader(
            'Set-Cookie',
            `replay_access=${token}; HttpOnly; SameSite=Lax; Path=/replay/; Max-Age=${30 * 86400}`
        );
    }
    const isAuthorized = (req) => !state.config.requireAuth || state.sessions.has(cookieOf(req, 'replay_access'));
    const peerOf = (req) => String(req.headers['x-replay-peer'] || '');

    // -- media

    function serveFile(req, res, file, { type, download, name }) {
        let size;
        try {
            size = statSync(file).size;
        } catch {
            return json(res, 404, { error: 'file not found', code: 'NOT_FOUND' });
        }
        const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=60' };
        if (download) {
            headers['Content-Disposition'] =
                `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;
        }
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
        let start = 0;
        let end = size - 1;
        let status = 200;
        if (range && (range[1] || range[2])) {
            if (range[1]) {
                start = Number(range[1]);
                end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            } else {
                start = Math.max(size - Number(range[2]), 0);
            }
            if (start > end || start >= size) {
                res.writeHead(416, { 'Content-Range': `bytes */${size}` });
                return res.end();
            }
            status = 206;
            headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        }
        headers['Content-Length'] = end - start + 1;
        res.writeHead(status, headers);
        if (req.method === 'HEAD') return res.end();
        createReadStream(file, { start, end }).pipe(res);
    }

    function serveStatic(req, res, pathname) {
        const file = path.normalize(path.join(publicDir, decodeURIComponent(pathname)));
        if (!file.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
        let stat;
        try {
            stat = statSync(file);
        } catch {
            return json(res, 404, { error: 'not found' });
        }
        if (!stat.isFile()) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
        if (req.method === 'HEAD') return res.end();
        createReadStream(file).pipe(res);
    }

    function servePage(res, file) {
        let html;
        try {
            html = readFileSync(file);
        } catch {
            return json(res, 404, { error: `${path.basename(file)} does not exist yet` });
        }
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': html.length,
            'Cache-Control': 'no-store',
        });
        res.end(html);
    }

    // -- the control endpoints (tests drive the mock with these)

    async function control(req, res, url) {
        const route = url.pathname.slice('/__mock'.length);
        const body = req.method === 'POST' || req.method === 'DELETE' ? await readJson(req).catch(() => ({})) : {};

        if (req.method === 'GET' && route === '/state') {
            return json(res, 200, {
                config: state.config,
                stats: state.stats,
                sessions: state.sessions.size,
                tickets: state.tickets.size,
                sseClients: state.sse.size,
                clips: newestFirst().map((rec) => ({
                    ...publicMeta(rec),
                    owners: rec.owners,
                    mp4State: rec.mp4.state,
                })),
                log: state.log.slice(-60),
            });
        }
        if (req.method === 'POST' && route === '/reset') {
            for (const timer of state.timers) clearInterval(timer);
            state.timers.clear();
            for (const rec of state.clips.values()) if (rec.mp4.timer) clearInterval(rec.mp4.timer);
            state.clips.clear();
            state.sessions.clear();
            state.tickets.clear();
            state.stats = { sessions: 0, logins: 0, badLogins: 0, deletes: 0, mp4Requests: 0, listRequests: 0 };
            state.failures = 0;
            state.lockedUntil = 0;
            state.log.length = 0;
            state.config = defaults();
            return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && route === '/config') {
            const { mp4, ...rest } = body;
            Object.assign(state.config, rest);
            if (mp4) Object.assign(state.config.mp4, mp4);
            return json(res, 200, { ok: true, config: state.config });
        }
        if (req.method === 'POST' && route === '/ticket') {
            const ticket = `mock-ticket-${randomBytes(6).toString('hex')}`;
            state.tickets.add(ticket);
            return json(res, 200, { ticket, expiresAt: Date.now() + 60_000 });
        }
        if (req.method === 'POST' && route === '/clips') {
            const rec = createClip(body);
            return json(res, 200, withMine(rec, state.config.me));
        }
        if (req.method === 'POST' && route === '/sse/drop') {
            for (const client of state.sse) client.end();
            state.sse.clear();
            return json(res, 200, { ok: true });
        }
        const clipRoute = /^\/clips\/([^/]+)(\/mp4)?$/.exec(route);
        if (clipRoute) {
            const rec = state.clips.get(clipRoute[1]);
            if (!rec) return json(res, 404, { error: 'unknown clip', code: 'NOT_FOUND' });
            if (req.method === 'DELETE' && !clipRoute[2]) return json(res, 200, { ok: deleteClip(rec.id) });
            if (req.method === 'POST' && clipRoute[2]) {
                setMp4(rec, body);
                return json(res, 200, { ok: true, mp4: mp4Answer(rec) });
            }
        }
        return json(res, 404, { error: 'unknown control endpoint', code: 'NOT_FOUND' });
    }

    // -- the API of docs/REPLAY.md section 6

    async function api(req, res, url) {
        const route = url.pathname.slice('/replay/api'.length);
        const peer = peerOf(req);

        if (req.method === 'POST' && route === '/session') {
            const { ticket } = await readJson(req).catch(() => ({}));
            if (!ticket || !state.tickets.has(ticket))
                return json(res, 401, { error: 'ticket inválido', code: 'BAD_TICKET' });
            state.tickets.delete(ticket);
            state.stats.sessions++;
            grantCookie(res);
            return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && route === '/login') {
            const { password } = await readJson(req).catch(() => ({}));
            const now = Date.now();
            if (now < state.lockedUntil) {
                const wait = Math.ceil((state.lockedUntil - now) / 1000);
                return json(
                    res,
                    429,
                    { error: 'tentativas demais', code: 'RATE_LIMITED' },
                    { 'Retry-After': String(wait) }
                );
            }
            if (typeof password !== 'string' || password !== state.config.password) {
                state.stats.badLogins++;
                if (++state.failures >= state.config.maxLoginFailures) {
                    state.failures = 0;
                    state.lockedUntil = now + state.config.lockMs;
                }
                return json(res, 401, { error: 'senha incorreta', code: 'BAD_PASSWORD' });
            }
            state.failures = 0;
            state.stats.logins++;
            grantCookie(res);
            return json(res, 200, { ok: true });
        }

        if (!isAuthorized(req)) return json(res, 401, { error: 'sem acesso', code: 'UNAUTHORIZED' });

        if (req.method === 'GET' && route === '/me') return json(res, 200, { ok: true });

        if (req.method === 'GET' && route === '/clips') {
            state.stats.listRequests++;
            if (state.config.listDelayMs) await new Promise((resolve) => setTimeout(resolve, state.config.listDelayMs));
            if (state.config.listStatus)
                return json(res, state.config.listStatus, { error: 'falha simulada', code: 'MOCK' });
            const clips = newestFirst().map((rec) => withMine(rec, peer));
            return json(res, 200, { clips, now: Date.now(), retentionDays: state.config.retentionDays });
        }

        if (req.method === 'GET' && route === '/stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.write('retry: 1000\n: connected\n\n');
            state.sse.add(res);
            req.on('close', () => state.sse.delete(res));
            return;
        }

        const clipRoute = /^\/clips\/([^/]+)(\/mp4)?$/.exec(route);
        if (clipRoute) {
            const rec = state.clips.get(clipRoute[1]);
            if (!rec) return json(res, 404, { error: 'replay não encontrado', code: 'NOT_FOUND' });
            if (req.method === 'GET' && !clipRoute[2]) return json(res, 200, withMine(rec, peer));
            if (req.method === 'DELETE' && !clipRoute[2]) {
                if (!peer || !rec.owners.includes(peer)) {
                    return json(res, 403, {
                        error: 'só quem salvou ou quem compartilhou pode excluir',
                        code: 'FORBIDDEN',
                    });
                }
                state.stats.deletes++;
                deleteClip(rec.id);
                return json(res, 200, { ok: true });
            }
            if (req.method === 'POST' && clipRoute[2]) {
                state.stats.mp4Requests++;
                if (rec.files.mp4) return json(res, 200, { state: 'ready', progress: 1, etaSeconds: 0 });
                if (rec.mp4.state === 'none' || rec.mp4.state === 'error') startMp4(rec);
                return json(res, 200, mp4Answer(rec));
            }
        }
        return json(res, 404, { error: 'rota desconhecida', code: 'NOT_FOUND' });
    }

    function media(req, res, url) {
        const parts = url.pathname.split('/'); // '', 'replay', 'media', id, file
        const [id, file] = [parts[3], parts[4]];
        if (!isAuthorized(req)) return json(res, 401, { error: 'sem acesso', code: 'UNAUTHORIZED' });
        const rec = state.clips.get(id);
        if (!rec) return json(res, 404, { error: 'replay não encontrado', code: 'NOT_FOUND' });
        const download = url.searchParams.get('download') === '1';
        const base = `replay-${safeName(rec.sharer)}-${rec.id}`;
        if (file === 'thumb.jpg') return serveFile(req, res, samples[rec.key].thumb, { type: 'image/jpeg' });
        if (file === rec.files.original.name) {
            return serveFile(req, res, samples[rec.key].webm, { type: 'video/webm', download, name: `${base}.webm` });
        }
        if (file === 'clip.mp4' && rec.files.mp4) {
            return serveFile(req, res, samples[rec.key].mp4, { type: 'video/mp4', download, name: `${base}.mp4` });
        }
        return json(res, 404, { error: 'arquivo não encontrado', code: 'NOT_FOUND' });
    }

    // -- the server

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://mock');
        const { pathname } = url;
        try {
            if (pathname.startsWith('/__mock/')) return await control(req, res, url);
            if (pathname === '/__harness/room.html') return servePage(res, harnessPage);
            if (pathname === '/config') {
                const { replayEnabled, maxSeconds, options } = state.config;
                return json(res, 200, {
                    message: false,
                    singleRoom: false,
                    healthMeter: false,
                    replay: replayEnabled ? { enabled: true, maxSeconds, options } : false,
                });
            }
            if (pathname === '/favicon.ico') return res.writeHead(204).end();
            if (pathname === '/replay') {
                return res.writeHead(301, { Location: `/replay/${url.search}` }).end();
            }
            if (pathname === '/replay/') return servePage(res, galleryPage);
            if (pathname.startsWith('/replay/api/')) {
                const peer = peerOf(req);
                res.on('finish', () => {
                    state.log.push({ method: req.method, path: pathname, status: res.statusCode, peer });
                    if (!quiet) console.log(res.statusCode, req.method, pathname, peer ? `peer=${peer}` : '');
                });
                return await api(req, res, url);
            }
            if (pathname.startsWith('/replay/media/')) return media(req, res, url);
            if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
            return json(res, 405, { error: 'method not allowed' });
        } catch (error) {
            if (!res.headersSent) json(res, 500, { error: String(error.message || error), code: 'MOCK_ERROR' });
            else res.end();
        }
    });
    await new Promise((resolve) => server.listen(port, host, resolve));
    const address = server.address();

    return {
        url: `http://${host}:${address.port}`,
        port: address.port,
        state,
        createClip: (options) => withMine(createClip(options), state.config.me),
        close: async () => {
            clearInterval(beatTimer);
            for (const timer of state.timers) clearInterval(timer);
            for (const res of state.sse) res.end();
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

// ---- run it by hand -----------------------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.env.PORT) || 3099;
    console.log('making the sample clips with ffmpeg (the first time only)...');
    const mock = await startMock({ port, quiet: false });
    // A few clips to look at, newest first in the page: mine (deletable), somebody else's, one with MP4 ready.
    mock.createClip({
        sample: 'a',
        sharer: 'Beltrano',
        requestedBy: 'Fulano',
        mine: true,
        ageMs: 2 * 60_000,
        emit: false,
    });
    mock.createClip({
        sample: 'b',
        sharer: 'Ciclano',
        requestedBy: 'Beltrano',
        ageMs: 47 * 60_000,
        withMp4: true,
        emit: false,
    });
    mock.createClip({ sample: 'a', sharer: 'Fulano', requestedBy: 'Ciclano', ageMs: 5 * 3_600_000, emit: false });
    console.log(`replay mock on ${mock.url}`);
    console.log(`  gallery:  ${mock.url}/replay/?from=room   (peer id that owns "mine": ${TEST_PEER})`);
    console.log(`  room:     ${mock.url}/__harness/room.html`);
    console.log(`  control:  ${mock.url}/__mock/state`);
    console.log(`  tip: set localStorage.peer_uuid = '${TEST_PEER}' in the page to own the "mine" clips`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, async () => {
            await mock.close();
            process.exit(0);
        });
    }
}
