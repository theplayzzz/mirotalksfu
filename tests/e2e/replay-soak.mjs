// The recorder over time and at its largest: a screen shared for MINUTES minutes, the biggest clip (5 minutes) asked
// for once the buffer is full, and two MP4 conversions started together to see the queue. Judged on the clip (length,
// decoding, sound and picture together), on what the room is told while the buffer fills and on the conversions;
// the disk and memory of the recorder over the same period come from a sampler run next to it (see the notes of the
// run in docs/MEASUREMENTS.md).
//
//   MINUTES=14 CLIP_AT=8 E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 60) node tests/e2e/replay-soak.mjs
//   OUT_DIR=...  where the clips are kept
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';
import { beepOnsets, decodeErrors, download, flashOnsets, median, probeJson, waitFor } from './media.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
const MINUTES = Number(process.env.MINUTES || 14);
const CLIP_AT = Number(process.env.CLIP_AT || 8);
const OUT_DIR = process.env.OUT_DIR || path.join(tmpdir(), 'replay-soak');
mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};
const note = (text) => console.log(`      ${text}`);
const minutesSince = (t0) => ((Date.now() - t0) / 60000).toFixed(1);

const watch = `(() => {
    window.__soak = { buffers: [], status: [], created: [] };
    const timer = setInterval(() => {
        try {
            if (typeof socket === 'undefined' || !socket || typeof socket.on !== 'function' || socket.__soakWatched) return;
            socket.__soakWatched = true;
            socket.on('replayBuffers', (data) => window.__soak.buffers.push({ at: Date.now(), data }));
            socket.on('replayStatus', (data) => window.__soak.status.push({ at: Date.now(), data }));
            clearInterval(timer);
        } catch (e) {}
    }, 10);
})();`;
const viewerStats = `(async () => {
    for (const c of rc.consumers.values()) {
        if (c.kind !== 'video' || c.closed) continue;
        for (const s of (await c.getStats()).values()) if (s.type === 'inbound-rtp') return { t: s.timestamp, frames: s.framesDecoded, freezes: s.freezeCount || 0, freezeS: s.totalFreezesDuration || 0, bytes: s.bytesReceived };
    }
    return null;
})()`;

const chrome = await launchChrome({ chrome: chromePath });
try {
    const sharer = await chrome.newPage();
    await stubScreenCapture(sharer, { withAudio: true, claquete: true });
    await joinTestRoom(sharer, { origin, token, name: 'SK-Sharer' });
    const viewer = await chrome.newPage();
    await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: watch });
    await joinTestRoom(viewer, { origin, token, name: 'SK-Viewer' });
    await startScreenShare(sharer);
    const t0 = Date.now();
    await waitFor('the first picture at the viewer', async () => (await viewer.ev(viewerStats))?.frames > 0, 40, 500);
    const statsStart = await viewer.ev(viewerStats);

    const cookies = (await viewer.send('Network.getCookies', { urls: [`${origin}/replay/`] })).result.cookies;
    const access = cookies.find((c) => c.name === 'replay_access');
    const peerUuid = await viewer.ev("localStorage.getItem('peer_uuid')");
    const auth = { cookie: `replay_access=${access.value}`, 'x-replay-peer': peerUuid || '' };
    const api = (p, options = {}) => fetch(`${origin}/replay/api/${p}`, { ...options, headers: { ...auth, ...(options.headers || {}) } }).then((r) => r.json());

    const kept = async () => {
        const last = await viewer.ev('(() => { const l = window.__soak.buffers; return l.length ? l[l.length - 1].data : null; })()');
        const share = last && last.shares && last.shares[0];
        return share ? share.bufferSeconds : null;
    };
    const askClip = async (seconds) => {
        const answer = await viewer.ev(`new Promise((resolve) => {
            const share = window.__soak.buffers[window.__soak.buffers.length - 1].data.shares[0];
            socket.emit('replayRequest', { producerId: share.producerId, seconds: ${seconds} }, resolve);
        })`);
        if (answer.error) throw new Error(`the clip of ${seconds} s was refused: ${JSON.stringify(answer)}`);
        const asked = Date.now();
        const done = await waitFor(`the clip of ${seconds} s`, () => viewer.ev(`window.__soak.status.map((s) => s.data).find((s) => s.requestId === ${JSON.stringify(answer.requestId)} && (s.state === 'done' || s.state === 'error'))`), 60, 300);
        return { ...done, tookMs: Date.now() - asked };
    };

    // 1. the buffer fills, for CLIP_AT minutes
    const timeline = [];
    while (Date.now() - t0 < CLIP_AT * 60000) {
        await sleep(30000);
        timeline.push({ minute: Number(minutesSince(t0)), kept: await kept() });
    }
    console.log('minutes shared -> seconds kept:', timeline.map((t) => `${t.minute}->${t.kept}`).join('  '));
    const lastKept = timeline[timeline.length - 1].kept;
    check('the room says a full buffer (5 minutes) is kept once the screen has been shared long enough', lastKept >= 295, `${lastKept} s after ${CLIP_AT} min`);
    let backwards = 0;
    for (let i = 1; i < timeline.length; i++) if (timeline[i].kept < timeline[i - 1].kept - 1) backwards++;
    check('and it never went back while it grew', backwards === 0, `${backwards} times`);

    // 2. the biggest clip
    const big = await askClip(300);
    check('a clip of 5 minutes is made', big.state === 'done', JSON.stringify(big).slice(0, 200));
    if (big.state !== 'done') throw new Error('no clip');
    const bigClip = big.clip;
    note(`5-minute clip ${bigClip.id}: made in ${big.tookMs} ms, ${JSON.stringify({ durationS: bigClip.durationS, startOffsetS: bigClip.startOffsetS, bytes: bigClip.files.original.bytes })}`);
    check('it is ready in under 10 s', big.tookMs < 10000, `${big.tookMs} ms`);
    check('it covers the five minutes asked for', Math.abs(bigClip.durationS - bigClip.startOffsetS - 300) < 4, `${(bigClip.durationS - bigClip.startOffsetS).toFixed(1)} s`);

    // 3. both conversions at once: one runs, the other waits its turn
    const mp4Big = await api(`clips/${bigClip.id}/mp4`, { method: 'POST' });
    const started = Date.now();
    note(`MP4 of the big clip: ${JSON.stringify(mp4Big)}`);
    const small = await askClip(30);
    const smallClip = small.clip;
    const mp4Small = await api(`clips/${smallClip.id}/mp4`, { method: 'POST' });
    note(`MP4 of the small clip, asked while the big one converts: ${JSON.stringify(mp4Small)}`);
    check('the second conversion waits for the first and says so', mp4Small.state === 'queued' && mp4Small.ahead >= 1, JSON.stringify(mp4Small));
    check('the estimate for the big one is given before it starts', typeof mp4Big.etaSeconds === 'number' && mp4Big.etaSeconds > 0, JSON.stringify(mp4Big));

    // 4. meanwhile the big original is downloaded and looked at
    const bigFile = path.join(OUT_DIR, 'big.webm');
    const t1 = Date.now();
    const got = await download(`${origin}/replay/media/${bigClip.id}/${bigClip.files.original.name}`, bigFile, auth);
    note(`downloaded ${(got.size / 1e6).toFixed(0)} MB in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
    check('the original downloads whole', got.size === bigClip.files.original.bytes, `${got.size} of ${bigClip.files.original.bytes}`);
    const info = probeJson(bigFile);
    check('ffprobe reads it: VP8 and Opus', !!info && info.streams.some((s) => s.codec_name === 'vp8') && info.streams.some((s) => s.codec_name === 'opus'));
    const errors = decodeErrors(bigFile);
    check('it decodes from start to end without a single error', errors === '', errors.slice(0, 200));
    const flashes = flashOnsets(bigFile);
    const beeps = beepOnsets(bigFile);
    const offsets = [];
    for (const flash of flashes) {
        const nearest = beeps.reduce((best, beep) => (Math.abs(beep - flash) < Math.abs(best - flash) ? beep : best), Infinity);
        if (Math.abs(nearest - flash) < 0.6) offsets.push(Math.round((nearest - flash) * 1000));
    }
    const settled = offsets.slice(Math.ceil(offsets.length / 5)); // all but the first fifth: the sender has long settled
    note(`clap board over 5 minutes: ${flashes.length} flashes, ${beeps.length} beeps; median ${median(settled)} ms, worst ${Math.max(...settled.map(Math.abs))} ms`);
    check('sound and picture stay together over five minutes (median under 80 ms, none over 150 ms)', Math.abs(median(settled)) < 80 && settled.every((o) => Math.abs(o) < 150), `median ${median(settled)} ms, worst ${Math.max(...settled.map(Math.abs))} ms`);

    // 5. the conversions finish, in order
    const finished = {};
    await waitFor('both MP4s', async () => {
        for (const [name, clip] of [['big', bigClip], ['small', smallClip]]) {
            if (finished[name]) continue;
            const state = await api(`clips/${clip.id}/mp4`, { method: 'POST' });
            if (state.state === 'ready') finished[name] = Date.now() - started;
            else if (state.state === 'error') throw new Error(`the MP4 of the ${name} clip failed: ${JSON.stringify(state)}`);
        }
        return finished.big && finished.small;
    }, 20 * 60, 5000);
    note(`MP4 of the 5-minute clip ready after ${(finished.big / 1000).toFixed(0)} s (the estimate was ${mp4Big.etaSeconds} s); the 30-second one after ${(finished.small / 1000).toFixed(0)} s`);
    check('the big conversion finished first, the small one after it', finished.big <= finished.small);
    const mp4File = path.join(OUT_DIR, 'big.mp4');
    await download(`${origin}/replay/media/${bigClip.id}/clip.mp4`, mp4File, auth);
    const mp4Info = probeJson(mp4File);
    check('the big MP4 is H.264 + AAC with the length asked for', !!mp4Info && mp4Info.streams.some((s) => s.codec_name === 'h264') && mp4Info.streams.some((s) => s.codec_name === 'aac') && Math.abs(Number(mp4Info.format.duration) - 300) < 4, mp4Info && `${Number(mp4Info.format.duration).toFixed(1)} s`);

    // 6. what the people watching went through, the whole time
    const statsEnd = await viewer.ev(viewerStats);
    const dt = (statsEnd.t - statsStart.t) / 1000;
    const summary = { minutes: Number(minutesSince(t0)), fps: Math.round((statsEnd.frames - statsStart.frames) / dt), freezes: statsEnd.freezes - statsStart.freezes, freezeSeconds: Math.round((statsEnd.freezeS - statsStart.freezeS) * 10) / 10 };
    console.log('the viewer over the whole run:', JSON.stringify(summary));
    check('the viewer kept a full frame rate through the buffer filling, the clips and the conversions', summary.fps >= 45, JSON.stringify(summary));

    for (const clip of [bigClip, smallClip]) await api(`clips/${clip.id}`, { method: 'DELETE' });
} catch (error) {
    check('the test ran to the end', false, error.message);
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
console.log(`files kept in ${OUT_DIR}`);
process.exit(failures ? 1 : 0);
