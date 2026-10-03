'use strict';

/*
 * Who may open the replay gallery and who may delete a clip.
 *
 *  - Access to the gallery is a cookie (`replay_access`, a JWT with its own scope and its own key, derived from the
 *    server secret so it cannot be used as any other token of the app). People in the room get it with a one-time
 *    ticket sent over their socket; people outside the room get it with the room password.
 *  - The cookie carries a version of the room password: changing the password invalidates every cookie.
 *  - Who saved a clip and whose screen it was is kept as an HMAC of the browser's peer_uuid, never as the uuid, and
 *    never leaves the server: the browser sends its own uuid (X-Replay-Peer) and the server compares.
 */

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'replay_access';
const COOKIE_PATH = '/replay/';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const TICKET_TTL_MS = 60 * 1000;
const MAX_TICKETS = 2000;
const DEFAULT_JWT_SECRET = 'mirotalksfu_jwt_secret';

const derive = (secret, purpose) => crypto.createHmac('sha256', String(secret)).update(purpose).digest();

class ReplayAccess {
    /**
     * @param {object} o
     * @param {string} o.secret the server's JWT secret (never the default one)
     * @param {string} o.roomPassword the room password: its version goes into the cookie
     * @param {function} [o.now]
     */
    constructor({ secret, roomPassword = '', now = Date.now }) {
        if (!secret || secret === DEFAULT_JWT_SECRET) {
            throw new Error('Replay needs a JWT_SECRET of its own, not the default one');
        }
        this.now = now;
        this.cookieKey = derive(secret, 'replay-view-cookie-v1');
        this.hashKey = derive(secret, 'replay-peer-hash-v1');
        this.passwordVersion = crypto.createHmac('sha256', this.cookieKey).update(`pw|${roomPassword}`).digest('base64url').slice(0, 16);
        this.tickets = new Map(); // ticket -> expiresAt
    }

    // ---- tickets: how a person who is in the room gets the cookie ----------------------------------------------

    issueTicket() {
        const now = this.now();
        for (const [ticket, expiresAt] of this.tickets) {
            if (expiresAt <= now) this.tickets.delete(ticket);
        }
        if (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value);
        const ticket = crypto.randomBytes(24).toString('base64url');
        const expiresAt = now + TICKET_TTL_MS;
        this.tickets.set(ticket, expiresAt);
        return { ticket, expiresAt };
    }

    // One use: a ticket that was accepted is gone
    consumeTicket(ticket) {
        if (typeof ticket !== 'string' || ticket.length > 200) return false;
        const expiresAt = this.tickets.get(ticket);
        this.tickets.delete(ticket);
        return typeof expiresAt === 'number' && expiresAt > this.now();
    }

    // ---- the cookie ---------------------------------------------------------------------------------------------

    signAccess() {
        return jwt.sign({ scope: 'replay-view', pv: this.passwordVersion }, this.cookieKey, {
            algorithm: 'HS256',
            expiresIn: COOKIE_MAX_AGE_S,
        });
    }

    verifyAccess(token) {
        if (typeof token !== 'string' || token.length > 1000) return false;
        try {
            const claims = jwt.verify(token, this.cookieKey, { algorithms: ['HS256'] });
            return claims.scope === 'replay-view' && claims.pv === this.passwordVersion;
        } catch (error) {
            return false;
        }
    }

    // `secure`: the page came over HTTPS (Chrome does not store a Secure cookie from plain http outside localhost)
    cookieHeader(token, { secure = true } = {}) {
        return `${COOKIE_NAME}=${token}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${COOKIE_MAX_AGE_S}`;
    }

    tokenFromRequest(req) {
        const header = String((req.headers && req.headers.cookie) || '');
        for (const part of header.split(';')) {
            const index = part.indexOf('=');
            if (index > 0 && part.slice(0, index).trim() === COOKIE_NAME) return part.slice(index + 1).trim();
        }
        return '';
    }

    isAllowed(req) {
        return this.verifyAccess(this.tokenFromRequest(req));
    }

    // ---- who is who ---------------------------------------------------------------------------------------------

    hashPeer(uuid) {
        if (typeof uuid !== 'string' || !uuid || uuid.length > 200) return '';
        return crypto.createHmac('sha256', this.hashKey).update(uuid).digest('base64url').slice(0, 24);
    }

    // The clip as a browser may see it: no hashes, and `mine` says whether this person may delete it
    publicClip(clip, peerUuid) {
        const { requestedByHash, sharerHash, ...rest } = clip || {};
        const mine = this.owns(clip, peerUuid);
        return { ...rest, mine };
    }

    owns(clip, peerUuid) {
        const hash = this.hashPeer(peerUuid);
        if (!hash || !clip) return false;
        const same = (stored) => {
            if (typeof stored !== 'string' || stored.length !== hash.length) return false;
            return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(hash));
        };
        return same(clip.requestedByHash) || same(clip.sharerHash);
    }
}

module.exports = { ReplayAccess, COOKIE_NAME, COOKIE_PATH, DEFAULT_JWT_SECRET };
