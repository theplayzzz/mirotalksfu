'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

function captchaRoutes({ control, adminDir, playerDir, adminKey }) {
    const router = express.Router();
    if (!control.enabled) {
        router.use((req, res) => res.sendStatus(404));
        return router;
    }
    if (!adminKey) {
        const file = path.join(control.dataDir, 'admin-key');
        try {
            adminKey = fs.readFileSync(file, 'utf8').trim();
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            adminKey = randomBytes(32).toString('base64url');
            fs.writeFileSync(file, adminKey + '\n', { mode: 0o600, flag: 'wx' });
        }
    }
    if (adminKey.length < 24) throw new Error('CAPTCHA_ADMIN_KEY must contain at least 24 characters');
    const digest = (value) => createHash('sha256').update(value).digest();
    const sessions = new Map(),
        logins = new Map();
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        next();
    });
    router.get('/', (req, res) => res.sendFile(path.join(adminDir, 'CaptchaAdmin.html')));
    router.use('/ui', express.static(adminDir, { index: false }));
    router.use(
        '/play',
        (req, res, next) => {
            res.set('Content-Security-Policy', "frame-ancestors 'self'");
            res.set('X-Frame-Options', 'SAMEORIGIN');
            next();
        },
        express.static(playerDir, {
            index: 'room.html',
            setHeaders: (res, file) => {
                if (!file.endsWith('.html'))
                    res.set(
                        'Cache-Control',
                        file.endsWith('dice.js') ? 'no-cache' : 'public, max-age=31536000, immutable'
                    );
            },
        })
    );
    router.post('/login', (req, res) => {
        const key = req.ip,
            now = control.now();
        let login = logins.get(key);
        if (!login || now > login.until) {
            login = { count: 0, until: now + 900000 };
            logins.set(key, login);
        }
        if (login.count >= 8)
            return res.status(429).json({ error: 'Aguarde alguns minutos antes de tentar novamente.' });
        login.count++;
        const password = typeof req.body?.key === 'string' ? req.body.key : '';
        if (password.length > 256 || !timingSafeEqual(digest(password), digest(adminKey)))
            return res.status(401).json({ error: 'Chave de acesso inválida.' });
        login.count = 0;
        for (const [token, expiresAt] of sessions) if (now >= expiresAt) sessions.delete(token);
        if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString('base64url');
        sessions.set(token, now + 7200000);
        res.json({ token, expiresAt: now + 7200000 });
    });
    router.use('/api', (req, res, next) => {
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (!sessions.has(token) || control.now() >= sessions.get(token)) {
            sessions.delete(token);
            return res.status(401).json({ error: 'Entre novamente para continuar.' });
        }
        if (Number(req.headers['content-length'] || 0) > 32768)
            return res.status(413).json({ error: 'Solicitação muito grande.' });
        req.captchaAdminToken = token;
        next();
    });
    const action = (fn) => async (req, res) => {
        try {
            res.json(await fn(req.body || {}, req));
        } catch (error) {
            res.status(400).json({ error: error.message, code: error.code || 'INVALID_REQUEST' });
        }
    };
    router.get('/api/state', (req, res) => res.json(control.snapshot()));
    router.post(
        '/api/settings',
        action((body) => control.configure(body))
    );
    router.post(
        '/api/trigger',
        action((body) =>
            body.peerId
                ? control.trigger({ roomId: body.roomId, peerId: body.peerId, gameId: body.gameId })
                : { assignments: control.randomTargets(body.roomId, body.mode === 'all' ? 'all' : 'one', body.gameId) }
        )
    );
    router.post(
        '/api/votes',
        action((body) => control.openVote(body))
    );
    router.post(
        '/api/cancel-vote',
        action((body) => control.cancelVote(body.id))
    );
    router.post(
        '/api/release',
        action((body) => control.release(body.peerId, 'admin'))
    );
    router.post(
        '/api/pause-room',
        action(async (body) => {
            const settings = JSON.parse(JSON.stringify(control.settings));
            if (settings.rooms[body.roomId]) settings.rooms[body.roomId].enabled = false;
            await control.configure(settings);
            for (const [id, a] of control.active) if (a.roomId === body.roomId) control.release(id, 'admin');
            for (const vote of control.votes.values()) if (vote.roomId === body.roomId) control.cancelVote(vote.id);
            return { released: true };
        })
    );
    router.post('/api/logout', (req, res) => {
        sessions.delete(req.captchaAdminToken);
        res.json({ loggedOut: true });
    });
    return router;
}

module.exports = { captchaRoutes };
