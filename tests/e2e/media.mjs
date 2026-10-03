// Helpers of the replay tests that look at a clip file (ffprobe, ffmpeg) and wait for things. Needs ffmpeg and ffprobe
// on the PATH, or FFMPEG / FFPROBE in the environment.
import { spawnSync } from 'node:child_process';
import { createWriteStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sleep } from './lib.mjs';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

export async function waitFor(what, test, seconds, everyMs = 500) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
        const value = await test();
        if (value) return value;
        await sleep(everyMs);
    }
    throw new Error(`timed out waiting for ${what}`);
}

export const probe = (file, ...args) => {
    const r = spawnSync(FFPROBE, ['-v', 'error', ...args, file], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return r.status === 0 ? r.stdout : null;
};
export const probeJson = (file) => {
    const out = probe(file, '-print_format', 'json', '-show_streams', '-show_format');
    return out ? JSON.parse(out) : null;
};

// Does the whole file decode without a single error?
export function decodeErrors(file) {
    // -enc_time_base 1:90000: with the default base (the frame rate, 1/60) two frames of a variable-rate video that are
    // 16 ms apart can land on the same tick and ffmpeg reports "non monotonically increasing dts", which is about the
    // check and not about the file
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-enc_time_base', '1:90000', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return r.status === 0 ? r.stderr.trim() : `ffmpeg exit ${r.status}: ${r.stderr.trim().slice(0, 200)}`;
}

// "frame:N pts:P pts_time:T" lines followed by "key=value" lines of ffmpeg's metadata filter -> [{ time, value }]
export function metadataSeries(file, filter, key, extra = []) {
    const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, ...extra, '-af' === filter[0] ? '-vn' : '-an', ...filter, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const series = [];
    let time = null;
    for (const line of r.stdout.split(/\r?\n/)) {
        const t = /pts_time:([\d.]+)/.exec(line);
        if (t) time = Number(t[1]);
        const v = new RegExp(`${key.replace(/\./g, '\\.')}=(\\S+)`).exec(line);
        if (v && time !== null) series.push({ time, value: v[1] === '-inf' ? -200 : Number(v[1]) });
    }
    return series;
}

// the moments the picture goes white / the sound goes loud, from the clap board
export function flashOnsets(file) {
    const series = metadataSeries(file, ['-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-'], 'lavfi.signalstats.YAVG');
    const onsets = [];
    let was = false;
    for (const { time, value } of series) {
        const white = value >= 225;
        if (white && !was) onsets.push(time);
        was = white;
    }
    return onsets;
}
export function beepOnsets(file) {
    const series = metadataSeries(file, ['-af', 'asetnsamples=n=480:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-'], 'lavfi.astats.Overall.RMS_level');
    const onsets = [];
    let was = false;
    for (const { time, value } of series) {
        const loud = value > -30;
        if (loud && !was) onsets.push(time);
        was = loud;
    }
    return onsets;
}

export function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

export async function download(url, file, headers) {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
    return { size: statSync(file).size, headers: response.headers };
}
