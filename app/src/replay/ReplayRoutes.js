'use strict';

/*
 * The HTTP side of replay (docs/REPLAY.md, section 6), mounted on /replay:
 *
 *   GET  /replay/                      the gallery page
 *   POST /replay/api/session           { ticket }   cookie for people who are in the room
 *   POST /replay/api/login             { password } cookie for people who are not
 *   GET  /replay/api/me, /clips, /clips/:id, /stream (Server-Sent Events)
 *   POST /replay/api/clips/:id/mp4     starts (or reports) the conversion
 *   DELETE /replay/api/clips/:id       only who saved the clip and whose screen it was
 *   GET  /replay/media/:id/:file       the clip, its MP4 and its thumbnail, with Range support
 *
 * Everything but the page, /session and /login needs the cookie. The recorder's own events come in on
 * /internal/replay/events, which is only for the recorder (secret header, private network).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const CLIP_ID = /^[a-z0-9-]{8,64}$/;
const MEDIA = {
    'clip.webm': 'video/webm',
    'clip.mkv': 'video/x-matroska',
    'clip.mp4': 'video/mp4',
    'thumb.jpg': 'image/jpeg',
};

const noStore = (res) => res.set('Cache-Control', 'no-store');
const peerOf = (req) => String(req.get('x-replay-peer') || '').slice(0, 200);

function safeName(text) {
    const folded = String(text || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return folded || 'replay';
}

function pad(number) {
    return String(number).padStart(2, '0');
}

function stamp(ms) {
    const date = new Date(Number(ms) || Date.now());
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

// `true` when the request was made on the private network without passing a proxy (the recorder), never from outside
function isInternalRequest(req) {
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded) return false;
    const address = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    return (
        address === '127.0.0.1' ||
        address === '::1' ||
        /^10\./.test(address) ||
        /^192\.168\./.test(address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    );
}

function secretMatches(provided, expected) {
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function createReplayRouter({ hub, access, client, singleRoom, pageFile, dataDir, retentionDays = 7, log = console }) {
    const router = express.Router();

    const loginLimiter = rateLimit({
        windowMs: 10 * 60 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many attempts, try again later', code: 'RATE_LIMIT' },
    });
    const sessionLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

    const secure = (req) => req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
    const grant = (req, res) => res.set('Set-Cookie', access.cookieHeader(access.signAccess(), { secure: secure(req) }));

    const requireAccess = (req, res, next) => {
        if (access.isAllowed(req)) return next();
        noStore(res);
        return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    };

    const recorderDown = (res, error) => {
        log.warn(`replay: the recorder failed a request: ${error.message}`);
        noStore(res);
        return res.status(error.status >= 400 && error.status < 500 ? error.status : 502).json({
            error: 'The replay recorder is not available',
            code: error.code || 'RECORDER_ERROR',
        });
    };

    // ---- the page -------------------------------------------------------------------------------------------------

    router.get('/', (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.sendFile(pageFile);
    });

    // ---- getting access -------------------------------------------------------------------------------------------

    router.post('/api/session', sessionLimiter, (req, res) => {
        noStore(res);
        if (!access.consumeTicket(req.body && req.body.ticket)) {
            return res.status(401).json({ error: 'Invalid or expired ticket', code: 'BAD_TICKET' });
        }
        grant(req, res);
        res.json({ ok: true });
    });

    router.post('/api/login', loginLimiter, (req, res) => {
        noStore(res);
        const password = req.body && req.body.password;
        if (!singleRoom.enabled || typeof password !== 'string' || !singleRoom.matches(password, singleRoom.roomId)) {
            return res.status(401).json({ error: 'Incorrect password', code: 'INVALID_PASSWORD' });
        }
        grant(req, res);
        res.json({ ok: true });
    });

    // ---- the API --------------------------------------------------------------------------------------------------

    router.use('/api', requireAccess);

    router.get('/api/me', (req, res) => {
        noStore(res);
        res.json({ ok: true });
    });

    router.get('/api/clips', async (req, res) => {
        try {
            const { clips = [] } = await client.listClips();
            const uuid = peerOf(req);
            noStore(res);
            res.json({ clips: clips.map((clip) => access.publicClip(clip, uuid)), now: Date.now(), retentionDays });
        } catch (error) {
            recorderDown(res, error);
        }
    });

    router.get('/api/clips/:id', async (req, res) => {
        if (!CLIP_ID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        try {
            noStore(res);
            res.json(access.publicClip(await client.getClip(req.params.id), peerOf(req)));
        } catch (error) {
            recorderDown(res, error);
        }
    });

    router.post('/api/clips/:id/mp4', async (req, res) => {
        if (!CLIP_ID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        try {
            noStore(res);
            res.json(await client.startMp4(req.params.id));
        } catch (error) {
            recorderDown(res, error);
        }
    });

    router.delete('/api/clips/:id', async (req, res) => {
        if (!CLIP_ID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
        try {
            noStore(res);
            const clip = await client.getClip(req.params.id);
            if (!access.owns(clip, peerOf(req))) {
                return res.status(403).json({ error: 'Only who saved the clip or shared the screen can delete it', code: 'NOT_OWNER' });
            }
            await client.deleteClip(req.params.id);
            res.json({ ok: true });
        } catch (error) {
            recorderDown(res, error);
        }
    });

    router.get('/api/stream', (req, res) => hub.subscribe(req, res));

    // ---- the files ------------------------------------------------------------------------------------------------

    router.get('/media/:id/:file', requireAccess, async (req, res) => {
        const { id, file } = req.params;
        if (!CLIP_ID.test(id) || !Object.prototype.hasOwnProperty.call(MEDIA, file)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const directory = path.join(dataDir, 'clips', id);
        const headers = { 'Content-Type': MEDIA[file], 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };

        if (req.query.download === '1') {
            let meta = {};
            try {
                meta = JSON.parse(await fs.promises.readFile(path.join(directory, 'meta.json'), 'utf8'));
            } catch (error) {
                // the name just falls back to the id
            }
            const extension = path.extname(file).slice(1);
            const name = meta.sharer ? `replay-${safeName(meta.sharer)}-${stamp(meta.createdAt)}.${extension}` : `replay-${id}.${extension}`;
            headers['Content-Disposition'] = `attachment; filename="${name}"`;
        }

        res.sendFile(file, { root: directory, dotfiles: 'deny', acceptRanges: true, cacheControl: false, headers }, (error) => {
            if (!error || res.headersSent) return;
            res.status(error.status === 404 || error.code === 'ENOENT' ? 404 : 500).json({ error: 'Not found' });
        });
    });

    return router;
}

/*
 * POST /internal/replay/events: the recorder reports what happens to clips and what it is keeping. Only the recorder
 * may call it: the secret, and a request that came straight over the private network (not through the public proxy).
 */
function createInternalEventsHandler({ hub, secret }) {
    return (req, res) => {
        if (!isInternalRequest(req) || !secretMatches(req.get('x-replay-secret'), secret)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        try {
            hub.handleRecorderEvent(req.body);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
        res.json({ ok: true });
    };
}

module.exports = { createReplayRouter, createInternalEventsHandler, isInternalRequest, secretMatches, safeName, CLIP_ID };
