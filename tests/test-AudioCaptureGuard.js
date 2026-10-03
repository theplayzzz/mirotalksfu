'use strict';

require('should');

const fs = require('fs');
const path = require('path');

/*
 * Guards the audio rules of screen sharing.
 *
 * When someone shares a single window, only that application's audio must reach the room; sharing a whole
 * screen sends the system audio. The browser decides this from the two options below, so every call that
 * starts a screen share must pass them. Without 'windowAudio: "window"' Chrome offers the audio of the
 * whole system for a window, and everything the person hears (voice chat, music, notifications) is
 * broadcast. This was fixed in September 2026 and must not regress when the upstream code is merged.
 *
 * If this test fails after merging upstream, check the new or changed getDisplayMedia() call before
 * touching the test.
 */

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');

// Returns the text from the first '{' after `header` to its matching '}'.
function blockAfter(source, header) {
    const start = source.indexOf(header);
    if (start === -1) throw new Error(`"${header}" was not found, the screen sharing code moved`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error(`unbalanced braces after "${header}"`);
}

// Returns the argument text of the first `.getDisplayMedia(` call found after `from`.
function displayMediaArgs(source, from) {
    const call = source.indexOf('.getDisplayMedia(', from);
    if (call === -1) throw new Error('getDisplayMedia call not found');
    const open = source.indexOf('(', call);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')' && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error('unbalanced parentheses in getDisplayMedia call');
}

describe('test-AudioCaptureGuard', () => {
    const roomClient = read('RoomClient.js');
    const room = read('Room.js');

    it('shares from inside the room with window audio for windows and system audio for screens', () => {
        const body = blockAfter(roomClient, 'getScreenConstraints() {');

        body.should.match(/audio:\s*true/);
        body.should.match(/windowAudio:\s*'window'/);
        body.should.match(/systemAudio:\s*'include'/);
    });

    it('uses getScreenConstraints() when the in-room share starts', () => {
        const produce = blockAfter(roomClient, 'async produce(type, deviceId = null, swapCamera = false, init = false) {');

        produce.should.match(/this\.getScreenConstraints\(\)/);
        produce.should.match(/getDisplayMedia\(mediaConstraints\)/);
    });

    it('shares before joining the room with the same audio options', () => {
        const toggle = blockAfter(room, 'async function toggleScreenSharing() {');
        const args = displayMediaArgs(toggle, 0);

        args.should.match(/audio:\s*true/);
        args.should.match(/windowAudio:\s*'window'/);
        args.should.match(/systemAudio:\s*'include'/);
    });

    it('never asks for the audio of the whole system when a window is shared', () => {
        for (const source of [roomClient, room]) {
            source.should.not.match(/windowAudio:\s*'system'/);
        }
    });

    it('has no unreviewed getDisplayMedia() call sites', () => {
        // RoomClient.js: the share started inside the room, the local recorder and the screen snapshot.
        // Room.js: the share started before joining. A new or removed call site needs a review of its audio.
        const count = (source) => (source.match(/\.getDisplayMedia\(/g) || []).length;

        count(roomClient).should.equal(3);
        count(room).should.equal(1);
    });
});
