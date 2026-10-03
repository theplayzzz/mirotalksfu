'use strict';

const crypto = require('node:crypto');

const roomId = process.env.SINGLE_ROOM_ID || '';
const password = process.env.SINGLE_ROOM_PASSWORD || '';

if (roomId && (!/^[a-zA-Z0-9_-]+$/.test(roomId) || !password)) {
    throw new Error('SINGLE_ROOM_ID requires a valid room ID and SINGLE_ROOM_PASSWORD');
}

/*
 * Development-only test room.
 *
 * Automated tests need a room they can enter without the real room password. When DEV_TEST_ROOM_ID is set,
 * that room is also allowed, and it is entered with a short-lived token (in the place of the room password,
 * for example /join?room=teste&roomPassword=<token>) minted by mintTestToken(). The token is an HMAC of the
 * room id and an expiry time, so nothing is stored and it stops working by itself.
 *
 * The server refuses to start if this is configured anywhere but APP_ENV=dev.
 */
const testRoomId = process.env.DEV_TEST_ROOM_ID || '';
const testRoomKey = process.env.DEV_TEST_ROOM_KEY || '';

if (testRoomId) {
    if (process.env.APP_ENV !== 'dev') {
        throw new Error('DEV_TEST_ROOM_ID is only allowed when APP_ENV=dev');
    }
    if (!roomId) {
        throw new Error('DEV_TEST_ROOM_ID requires SINGLE_ROOM_ID');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(testRoomId) || testRoomId === roomId) {
        throw new Error('DEV_TEST_ROOM_ID must be a valid room ID different from SINGLE_ROOM_ID');
    }
    if (testRoomKey.length < 32) {
        throw new Error('DEV_TEST_ROOM_ID requires a DEV_TEST_ROOM_KEY of at least 32 characters');
    }
}

const MAX_TEST_TOKEN_SECONDS = 24 * 60 * 60;
// Used as the stored room password of the test room: random, never shown to anyone.
const testRoomInternalPassword = testRoomId ? crypto.randomBytes(24).toString('hex') : '';

function signTestToken(expiresAt) {
    return crypto.createHmac('sha256', testRoomKey).update(`${testRoomId}|${expiresAt}`).digest('base64url');
}

function mintTestToken(ttlSeconds = 2 * 60 * 60) {
    if (!testRoomId) throw new Error('The test room is not enabled');
    const ttl = Math.min(Math.max(1, Math.floor(Number(ttlSeconds) || 0)), MAX_TEST_TOKEN_SECONDS);
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    return `${expiresAt}.${signTestToken(expiresAt)}`;
}

function validTestToken(candidate) {
    if (!testRoomId || typeof candidate !== 'string') return false;
    const [expiresAt, signature, ...extra] = candidate.split('.');
    if (extra.length || !/^\d{10}$/.test(expiresAt || '') || !signature) return false;
    if (Number(expiresAt) < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(signTestToken(expiresAt));
    const provided = Buffer.from(signature);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function isTestRoom(candidate) {
    return Boolean(testRoomId) && candidate === testRoomId;
}

// `candidate` is what the client sent as the room password; `id` is the room it is trying to enter.
function matches(candidate, id = roomId) {
    if (isTestRoom(id)) return validTestToken(candidate);
    if (typeof candidate !== 'string') return false;
    const provided = Buffer.from(candidate);
    const expected = Buffer.from(password);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

module.exports = {
    enabled: Boolean(roomId),
    roomId,
    password,
    allows: (candidate) => !roomId || candidate === roomId || isTestRoom(candidate),
    passwordFor: (id) => (isTestRoom(id) ? testRoomInternalPassword : password),
    matches,
    mintTestToken,
    testRoomId,
};
