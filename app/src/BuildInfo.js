'use strict';

/*
 * Which build is this, and which switches are on.
 *
 * The image is made by the CI with the commit it was built from (build-info.json, see the Dockerfile). Every record of
 * the health meter carries the short commit and the browsers report the commit of the page they run, so a change in
 * what people saw can be told from a change in the internet: compare the same person before and after a build, and a
 * tab that kept an old page from one that was reloaded.
 */

const fs = require('node:fs');
const path = require('node:path');

function readFile() {
    for (const file of [process.env.BUILD_INFO_FILE, path.join(__dirname, '../../build-info.json')]) {
        if (!file) continue;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            // the next place
        }
    }
    return {};
}

const raw = readFile();
const clean = (value, max) => String(value || '').replace(/[^\w.\-/]/g, '').slice(0, max);
const sha = clean(process.env.BUILD_SHA || raw.sha, 40) || 'dev-local';

const info = {
    sha,
    sha7: sha.slice(0, 7),
    ref: clean(process.env.BUILD_REF || raw.ref, 60),
    date: clean(raw.date, 30),
};

// The settings that change what a person sees, in a short stable form (stamped on the records of the health meter).
function flagsOf(env = process.env) {
    const on = (v) => (v === 'true' ? 1 : 0);
    const parts = {
        // the same rule as the server's: 'adaptive' unless the mode asked for is 'tile'
        sel: env.SELECTIVE_RECEPTION === 'true' ? (['tile', 'adaptive'].includes(env.SELECTIVE_MODE) ? env.SELECTIVE_MODE : 'adaptive') : 'off',
        kfd: parseInt(env.KEYFRAME_REQUEST_DELAY_MS, 10) || 0,
        replay: on(env.REPLAY_ENABLED),
        codec: ['vp8', 'vp9', 'h264', 'auto'].includes(env.SCREEN_CODEC) ? env.SCREEN_CODEC : 'vp8',
        layers: Math.min(3, Math.max(1, parseInt(env.SCREEN_SIMULCAST_LAYERS, 10) || 1)),
        guard: ['observe', 'apply'].includes(env.SEND_GUARD) ? env.SEND_GUARD : 'off',
        pause: on(env.SELECTIVE_PAUSE_HIDDEN),
    };
    return Object.entries(parts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
}

module.exports = { info, flagsOf };
