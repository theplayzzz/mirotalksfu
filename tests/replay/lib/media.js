'use strict';

/**
 * Helpers of the replay tests that need FFmpeg: detection, ffprobe, temporary directories.
 * Everything the tests produce goes to os.tmpdir() and is removed afterwards; no media file is ever committed.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let ffmpegAvailable;

function hasFfmpeg() {
    if (ffmpegAvailable === undefined) {
        const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
        const ffprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
        ffmpegAvailable = ffmpeg.status === 0 && ffprobe.status === 0;
    }
    return ffmpegAvailable;
}

/** Call from a mocha `before` (function form): skips the whole suite with a clear message without ffmpeg. */
function requireFfmpeg(context) {
    if (!hasFfmpeg()) {
        console.log('      [skipped] ffmpeg/ffprobe not found on PATH: these tests need them to build and check media');
        context.skip();
    }
}

function tmpDir(prefix = 'replay-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
        // a leftover in the temp directory is not worth failing a test for
    }
}

/** Runs a command to completion; resolves { code, stdout, stderr } and never rejects on a non-zero exit. */
function run(command, args, { input, timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
        const out = [];
        const err = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => err.push(d));
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
        });
        if (input) child.stdin.end(input);
    });
}

/** ffprobe of a file: { format, streams, packets? } as JSON. */
async function probe(file, { packets = false } = {}) {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
    if (packets) args.push('-show_packets');
    args.push(file);
    const result = await run('ffprobe', args);
    if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
    return JSON.parse(result.stdout.toString());
}

/** Decodes everything to nothing: returns the errors ffmpeg printed (an empty string means a clean decode). */
async function decodeErrors(file) {
    const result = await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
    return result.code === 0 ? result.stderr.trim() : `exit ${result.code}: ${result.stderr.trim()}`;
}

/** Returns the packets of one stream of a file with pts_time, size and flags (K = key frame). */
async function streamPackets(file, selector) {
    const result = await run('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        selector,
        '-show_entries',
        'packet=pts_time,dts_time,size,flags',
        '-print_format',
        'json',
        file,
    ]);
    if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
    return JSON.parse(result.stdout.toString()).packets.map((p) => ({
        pts: Number(p.pts_time),
        dts: Number(p.dts_time),
        size: Number(p.size),
        key: typeof p.flags === 'string' && p.flags.includes('K'),
    }));
}

module.exports = { hasFfmpeg, requireFfmpeg, tmpDir, rmDir, run, probe, decodeErrors, streamPackets };
