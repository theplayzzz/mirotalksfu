'use strict';

const crypto = require('node:crypto');

const roomId = process.env.SINGLE_ROOM_ID || '';
const password = process.env.SINGLE_ROOM_PASSWORD || '';

if (roomId && (!/^[a-zA-Z0-9_-]+$/.test(roomId) || !password)) {
    throw new Error('SINGLE_ROOM_ID requires a valid room ID and SINGLE_ROOM_PASSWORD');
}

function matches(candidate) {
    if (typeof candidate !== 'string') return false;
    const provided = Buffer.from(candidate);
    const expected = Buffer.from(password);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

module.exports = {
    enabled: Boolean(roomId),
    roomId,
    password,
    allows: (candidate) => !roomId || candidate === roomId,
    matches,
};
