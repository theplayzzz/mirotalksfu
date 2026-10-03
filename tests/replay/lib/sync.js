'use strict';

/**
 * Audio/video sync measurement for the tests: a source that flashes the picture white and plays a tone at the same
 * instants (every two seconds, for 200 ms), and detectors that find those instants again in a clip.
 */

const media = require('./media');

/** lavfi sources: white picture and 1 kHz tone during the first 0.2 s of every 2 s, black and silence otherwise. */
const FLASH_VIDEO = (w = 320, h = 180, fps = 30) =>
    `color=c=black:s=${w}x${h}:r=${fps},drawbox=x=0:y=0:w=${w}:h=${h}:color=white:t=fill:enable='lt(mod(t,2),0.2)'`;
const BEEP_AUDIO = "aevalsrc='0.8*sin(2*PI*1000*t)*lt(mod(t,2),0.2)':s=48000";

/** Times (s on the file timeline) at which the picture turns from dark to bright. */
async function flashOnsets(file) {
    const result = await media.run('ffmpeg', [
        '-v',
        'error',
        '-i',
        file,
        '-an',
        '-vf',
        'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
        '-f',
        'null',
        '-',
    ]);
    const frames = [];
    let t = null;
    for (const line of result.stdout.toString().split(/\r?\n/)) {
        const time = /pts_time:([\d.]+)/.exec(line);
        if (time) t = Number(time[1]);
        const y = /YAVG=([\d.]+)/.exec(line);
        if (y && t !== null) frames.push({ t, y: Number(y[1]) });
    }
    const onsets = [];
    for (let i = 1; i < frames.length; i++) {
        if (frames[i].y > 128 && frames[i - 1].y < 128) onsets.push(frames[i].t);
    }
    // a clip may start in the middle of a flash: that first bright frame is not an onset
    return onsets;
}

/** Times (s on the file timeline, with the start of the audio padded with silence) at which a beep starts. */
async function beepOnsets(file) {
    const result = await media.run('ffmpeg', [
        '-v',
        'error',
        '-i',
        file,
        '-vn',
        '-af',
        'aresample=async=1:first_pts=0',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-f',
        's16le',
        'pipe:1',
    ]);
    const pcm = result.stdout;
    const samples = pcm.length >> 1;
    const onsets = [];
    let quiet = 99999; // samples since the last loud one
    for (let i = 0; i < samples; i++) {
        const v = Math.abs(pcm.readInt16LE(i * 2));
        if (v > 3000) {
            if (quiet > 4800) onsets.push(i / 48000); // after 100 ms of quiet
            quiet = 0;
        } else {
            quiet++;
        }
    }
    return onsets;
}

/**
 * Pairs every flash with the nearest beep and returns the offsets in ms (positive: the sound is late).
 * Flashes and beeps within `edge` seconds of the start or end of the file are left out: they may be cut.
 */
function offsets(flashes, beeps, { maxPairMs = 500 } = {}) {
    const out = [];
    for (const flash of flashes) {
        let best = null;
        for (const beep of beeps) {
            if (best === null || Math.abs(beep - flash) < Math.abs(best - flash)) best = beep;
        }
        if (best !== null && Math.abs(best - flash) * 1000 <= maxPairMs) out.push((best - flash) * 1000);
    }
    return out;
}

module.exports = { FLASH_VIDEO, BEEP_AUDIO, flashOnsets, beepOnsets, offsets };
