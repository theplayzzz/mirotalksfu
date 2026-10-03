'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

/**
 * Small helpers around the ffmpeg process: low priority start (the recorder's own packet loop must always win the
 * CPU), waiting for the exit with the tail of stderr, and the version check that picks options by FFmpeg version.
 */

const NICE_LEVEL = 10;
let niceAvailable = null;

function hasNice() {
    if (niceAvailable === null) {
        niceAvailable = process.platform !== 'win32' && ['/usr/bin/nice', '/bin/nice'].some((p) => fs.existsSync(p));
    }
    return niceAvailable;
}

/**
 * Starts a process with a lower priority: `nice -n 10 file args...` on Linux and macOS (the priority is set before
 * the program starts, so all its threads have it), "below normal" on Windows.
 */
function spawnLowPriority(file, args, options = {}) {
    if (hasNice()) return spawn('nice', ['-n', String(NICE_LEVEL), file, ...args], options);
    const child = spawn(file, args, options);
    if (child.pid) {
        try {
            os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
            // not fatal: the job just runs at normal priority
        }
    }
    return child;
}

/** Resolves with { code, signal, stderr } (the last stderrLimit characters) when the process closes. */
function waitForExit(child, { stderrLimit = 8192 } = {}) {
    return new Promise((resolve, reject) => {
        let stderr = '';
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                stderr = (stderr + chunk.toString()).slice(-stderrLimit);
            });
        }
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stderr }));
    });
}

/** The last meaningful line of ffmpeg's stderr, for error messages. */
function lastLine(stderr) {
    const lines = String(stderr || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    return (lines[lines.length - 1] || 'no output').slice(0, 300);
}

const versions = new Map();

/** { major, minor, raw } of the ffmpeg binary, or null when it cannot be run. */
function ffmpegVersion(ffmpegPath = 'ffmpeg') {
    if (versions.has(ffmpegPath)) return versions.get(ffmpegPath);
    let result = null;
    try {
        const out = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf8', timeout: 10000 });
        if (out.status === 0) {
            const first = String(out.stdout).split(/\r?\n/)[0] || '';
            const match = /version\s+n?(\d+)\.(\d+)/i.exec(first);
            // Builds from git (N-12345-g...) have no number: they are recent.
            result = { major: match ? Number(match[1]) : 99, minor: match ? Number(match[2]) : 0, raw: first };
        }
    } catch {
        result = null;
    }
    versions.set(ffmpegPath, result);
    return result;
}

/** -fps_mode exists since FFmpeg 5.1; older versions only know -vsync, newer ones have dropped it. */
function vfrArgs(ffmpegPath = 'ffmpeg') {
    const v = ffmpegVersion(ffmpegPath);
    if (v && (v.major > 5 || (v.major === 5 && v.minor >= 1))) return ['-fps_mode', 'vfr'];
    return ['-vsync', 'vfr'];
}

module.exports = { spawnLowPriority, waitForExit, lastLine, ffmpegVersion, vfrArgs, NICE_LEVEL };
