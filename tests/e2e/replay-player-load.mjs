// The gallery's player, in a real Chrome, against the development instance: a person opens a saved clip and presses
// play. How long until the first picture, how many requests the <video> makes for the file, and does anything start
// an MP4 conversion on its own (it must not: only the "Baixar MP4" button does).
//
// A sharer streams a 1080p60 animation into the test room, a viewer asks for a clip once enough is buffered, and a
// third page, which has the gallery session, opens the clip like a person would. The page speaks HTTP/3 to the proxy
// like the people of the room do (--origin-to-force-quic-on).
//
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 30) node tests/e2e/replay-player-load.mjs
//   CLIP_SECONDS=60      how much to ask for (a lead-in before the first key frame comes on top)
//   CLIP_ID=...          open a clip that is already there instead of sharing and asking for one (saves 2.5 minutes)
//   THROTTLE_MBPS=20     limit the gallery page's download (default: the line of the PC that runs the test)
//   HOG=10               keep this many CPU-hungry processes busy while the clip loads: the people of the room open the
//                        gallery on a PC that is playing a game, where decoding a lead-in takes many times longer
//   MAX_FIRST_PICTURE_S  fail if the first picture takes longer (default 3)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';
import { waitFor } from './media.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
const CLIP_SECONDS = Number(process.env.CLIP_SECONDS || 60);
const THROTTLE_MBPS = Number(process.env.THROTTLE_MBPS || 0);
const HOG = Number(process.env.HOG || 0);
const MAX_FIRST_PICTURE_S = Number(process.env.MAX_FIRST_PICTURE_S || 3);
const hogs = [];
const stopHogs = () => {
    for (const hog of hogs.splice(0)) hog.kill();
};
process.once('exit', stopHogs);
const BUFFER_NEEDED = Number(process.env.BUFFER_NEEDED || CLIP_SECONDS + 45);
const OUT_DIR = process.env.OUT_DIR || path.join(tmpdir(), 'replay-player-load');
mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};
const note = (text) => console.log(`      ${text}`);

const host = new URL(origin).host;
const chrome = await launchChrome({ chrome: chromePath, extraFlags: ['--enable-quic', `--origin-to-force-quic-on=${host}:443`] });

// What the <video> of the gallery does, with times from the moment the page started
const videoSpy = `(() => {
    window.__video = { events: [] };
    const mark = (name, v) => window.__video.events.push({
        t: Math.round(performance.now()), name,
        ct: Math.round((v.currentTime || 0) * 100) / 100, rs: v.readyState, ns: v.networkState,
        buffered: (() => { try { return Array.from({ length: v.buffered.length }, (_, i) => [Math.round(v.buffered.start(i)), Math.round(v.buffered.end(i))]); } catch (e) { return []; } })(),
    });
    const hook = () => {
        const v = document.getElementById('rpVideo');
        if (!v || v.__spied) return;
        v.__spied = true;
        for (const name of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'error', 'emptied', 'ended']) {
            v.addEventListener(name, () => mark(name, v));
        }
    };
    new MutationObserver(hook).observe(document, { subtree: true, childList: true });
    document.addEventListener('DOMContentLoaded', hook);
})();`;

try {
    let clip;
    if (process.env.CLIP_ID) {
        // a clip that is already there: all that is needed is a page with the gallery session
        const viewer = await chrome.newPage();
        await joinTestRoom(viewer, { origin, token, name: 'PL-Viewer' });
        await waitFor('the gallery session', () => viewer.ev("fetch('/replay/api/me').then((r) => r.status === 200)"), 15, 300);
        clip = await viewer.ev(`fetch('/replay/api/clips/${process.env.CLIP_ID}').then((r) => r.json())`);
        if (!clip || clip.id !== process.env.CLIP_ID) throw new Error(`no such clip: ${JSON.stringify(clip)}`);
    } else {
        // 1. a sharer and a viewer in the test room, like the other flow tests
        const sharer = await chrome.newPage();
        await stubScreenCapture(sharer, { withAudio: true });
        await joinTestRoom(sharer, { origin, token, name: 'PL-Sharer' });
        await startScreenShare(sharer);
        const producers = await waitFor('the screen producers', () => sharer.ev("[...rc.producers.values()].filter((p) => !p.closed).map((p) => ({ id: p.id, kind: p.kind }))").then((l) => (l.some((p) => p.kind === 'video') ? l : null)), 20);
        const screen = producers.find((p) => p.kind === 'video');

        const viewer = await chrome.newPage();
        await viewer.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `(() => { window.__buffers = null; const t = setInterval(() => { try { if (typeof socket === 'undefined' || !socket || socket.__w) return; socket.__w = true; socket.on('replayBuffers', (d) => (window.__buffers = d)); socket.on('replayStatus', (d) => ((window.__status = window.__status || []).push(d))); clearInterval(t); } catch (e) {} }, 20); })();`,
        });
        await joinTestRoom(viewer, { origin, token, name: 'PL-Viewer' });
        await waitFor('the gallery session', () => viewer.ev("fetch('/replay/api/me').then((r) => r.status === 200)"), 15, 300);

        console.log(`waiting for ${BUFFER_NEEDED} s of buffer ...`);
        const share = await waitFor(`${BUFFER_NEEDED} s of buffer`, async () => {
            const b = await viewer.ev('window.__buffers');
            const s = b && b.shares.find((x) => x.producerId === screen.id);
            return s && s.bufferSeconds >= BUFFER_NEEDED ? s : null;
        }, BUFFER_NEEDED + 90, 1000);
        note(`the screen has ${share.bufferSeconds} s buffered`);

        // 2. a clip
        const answer = await viewer.ev(`new Promise((resolve) => socket.emit('replayRequest', ${JSON.stringify({ producerId: screen.id, seconds: CLIP_SECONDS })}, resolve))`);
        check('the clip is requested', answer && answer.ok === true, JSON.stringify(answer));
        const done = await waitFor('the clip', async () => {
            const status = await viewer.ev(`(window.__status || []).filter((s) => s.requestId === ${JSON.stringify(answer.requestId)})`);
            return status.find((s) => s.state === 'done' || s.state === 'error') || null;
        }, 30, 200);
        check('the clip is ready', done.state === 'done', JSON.stringify(done).slice(0, 200));
        clip = done.clip;
        // the sharer and the viewer have done their part: leave the room quiet, the player is what is measured now
        await sharer.send('Page.navigate', { url: 'about:blank' });
    }
    note(`clip ${clip.id}: durationS ${clip.durationS}, startOffsetS ${clip.startOffsetS} (lead-in), ${(clip.files.original.bytes / 1e6).toFixed(0)} MB, ${clip.files.original.name}`);

    if (HOG > 0) {
        for (let i = 0; i < HOG; i++) hogs.push(spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
        note(`${HOG} CPU-hungry processes started: the PC is busy like one that runs a game`);
        await sleep(1500);
    }

    // 3. a person opens it in the gallery
    const gallery = await chrome.newPage();
    await gallery.send('Page.addScriptToEvaluateOnNewDocument', { source: videoSpy });
    await gallery.send('Network.enable');
    if (THROTTLE_MBPS > 0) {
        await gallery.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: (THROTTLE_MBPS * 1e6) / 8, uploadThroughput: 1e6 });
        note(`the gallery page is limited to ${THROTTLE_MBPS} Mbps`);
    }
    const requests = new Map();
    const t0 = Date.now();
    gallery.ws.addEventListener('message', (message) => {
        const data = JSON.parse(message.data);
        const p = data.params || {};
        const now = Date.now() - t0;
        if (data.method === 'Network.requestWillBeSent') {
            const url = new URL(p.request.url);
            const kind = url.pathname.includes('/replay/media/') ? 'media' : url.pathname.includes('/mp4') ? 'mp4' : 'other';
            requests.set(p.requestId, { t: now, method: p.request.method, path: url.pathname.replace(/[0-9]{8}-[0-9]{6}-[0-9a-f]{8}-[0-9a-f]{4}/, '<clip>'), kind, range: p.request.headers.Range || p.request.headers.range || '', bytes: 0 });
        } else if (data.method === 'Network.responseReceived' && requests.has(p.requestId)) {
            Object.assign(requests.get(p.requestId), { status: p.response.status, protocol: p.response.protocol });
        } else if (data.method === 'Network.dataReceived' && requests.has(p.requestId)) {
            requests.get(p.requestId).bytes += p.dataLength;
        } else if (data.method === 'Network.loadingFinished' && requests.has(p.requestId)) {
            Object.assign(requests.get(p.requestId), { end: now, ok: true });
        } else if (data.method === 'Network.loadingFailed' && requests.has(p.requestId)) {
            Object.assign(requests.get(p.requestId), { end: now, ok: false, why: p.errorText + (p.canceled ? ' (canceled)' : '') });
        }
    });
    await gallery.send('Page.navigate', { url: `${origin}/replay/?clip=${clip.id}&from=room` });
    const navigatedAt = Date.now();
    const state = () => gallery.ev("(() => { const v = document.getElementById('rpVideo'); return v ? { ct: v.currentTime, rs: v.readyState, paused: v.paused, src: !!v.currentSrc, dur: v.duration, err: v.error && v.error.code } : null; })()").catch(() => null);

    // wait for the player to have a source, then press play like a person (the big button on the picture)
    await waitFor('the player has the clip', async () => (await state())?.src, 20, 200);
    const sourceAt = Date.now();
    await gallery.ev("document.getElementById('rpBig').click(); true");
    const playAt = Date.now();

    // the first picture: the video plays from its first frame (the lead-in is part of what is shown; skipping it would
    // make the browser decode all of it before any picture), so the time on screen just has to start moving
    const start = 0;
    let firstPictureAt = 0;
    let lastCt = 0;
    for (let i = 0; i < 400; i++) {
        const s = await state();
        if (s && s.rs >= 2 && s.ct > start + 0.3 && !s.paused) {
            firstPictureAt = Date.now();
            break;
        }
        if (s && s.ct) lastCt = s.ct;
        await sleep(250);
    }
    const sinceOpen = firstPictureAt ? (firstPictureAt - sourceAt) / 1000 : Infinity;
    const sincePlay = firstPictureAt ? (firstPictureAt - playAt) / 1000 : Infinity;
    note(`from the page having the clip to the first moving picture: ${firstPictureAt ? sinceOpen.toFixed(1) + ' s' : 'NEVER (last time ' + lastCt.toFixed(1) + ')'}; from the press of play: ${firstPictureAt ? sincePlay.toFixed(1) + ' s' : '-'}`);

    // let it play 6 s more to see whether it keeps going
    await sleep(6000);
    const after = await state();
    note(`6 s later: ${JSON.stringify(after)}`);

    // what skipping into the middle costs: the browser decodes from the key frame before the target (a GOP of a real
    // screen is ~30 s), so this is the part that still depends on how often the sender makes key frames
    let seekS = null;
    if (process.env.SEEK !== '0' && after && after.dur > 20) {
        const target = after.dur * 0.5;
        const askedAt = Date.now();
        await gallery.ev(`(() => { document.getElementById('rpVideo').currentTime = ${target}; return true; })()`);
        for (let i = 0; i < 480; i++) {
            const s = await state();
            if (s && s.ct >= target + 0.2 && s.rs >= 3 && !s.paused) {
                seekS = (Date.now() - askedAt) / 1000;
                break;
            }
            await sleep(250);
        }
        note(`skipping to ${target.toFixed(0)} s of ${after.dur.toFixed(0)}: ${seekS === null ? 'NEVER (2 minutes)' : seekS.toFixed(1) + ' s until it plays there'}`);
    }

    const events = await gallery.ev('window.__video && window.__video.events');
    console.log('\nvideo events (ms since page start):');
    for (const e of events || []) console.log(`  ${String(e.t).padStart(6)}  ${e.name.padEnd(15)} ct=${String(e.ct).padEnd(7)} rs=${e.rs} ns=${e.ns} buffered=${JSON.stringify(e.buffered)}`);

    const list = [...requests.values()];
    const media = list.filter((r) => r.kind === 'media' && r.path.endsWith('.webm'));
    const mp4 = list.filter((r) => r.kind === 'mp4' || r.path.endsWith('.mp4'));
    console.log(`\nrequests for the clip file: ${media.length}`);
    for (const r of media.slice(0, 40)) console.log(`  +${String(r.t).padStart(6)} ms  ${r.range.padEnd(24)} ${r.status || '-'} ${r.protocol || ''}  ${(r.bytes / 1024).toFixed(0)} KiB  ${r.ok === false ? 'FAILED ' + r.why : r.ok ? 'finished' : 'open'}  ${r.end ? '(' + (r.end - r.t) + ' ms)' : ''}`);
    if (media.length > 40) console.log(`  ... ${media.length - 40} more`);
    const totalBytes = media.reduce((sum, r) => sum + r.bytes, 0);
    note(`bytes received for the clip file in all: ${(totalBytes / 1e6).toFixed(1)} MB (the file is ${(clip.files.original.bytes / 1e6).toFixed(0)} MB)`);

    check('nothing asked for an MP4 while the clip was opened and played', mp4.length === 0, JSON.stringify(mp4.map((r) => ({ m: r.method, p: r.path }))));
    check(`the first picture is on screen within ${MAX_FIRST_PICTURE_S} s of the clip being open`, sinceOpen <= MAX_FIRST_PICTURE_S, `${sinceOpen.toFixed(1)} s`);
    check('the file is asked for in a handful of requests, not hundreds', media.length <= 12, `${media.length} requests`);
    check('it keeps playing', !!after && after.ct > start + 2 && !after.paused, JSON.stringify(after));
    // no seek at all to get started: a seek past the lead-in is what made the first version wait (decoding all of it)
    check('the player did not seek past the lead-in', !(events || []).some((e) => e.name === 'seeking' && e.ct > 1), JSON.stringify((events || []).filter((e) => e.name === 'seeking')));
} finally {
    stopHogs();
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
