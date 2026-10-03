// What does KEYFRAME_REQUEST_DELAY_MS change for the people in the room?
//
// A sharer streams a 1080p60 animation. A normal viewer watches. A "storm" viewer asks the sharer for a new full
// frame (key frame, a PLI) several times per second, like a viewer with packet loss does. Phases:
//   calm   - nothing special; new viewers join twice
//   storm  - the storm viewer asks for key frames at STORM_HZ; new viewers join three times
// For each phase it reports how many key frames the sharer had to produce, how the normal viewer fared (frames
// per second, freezes, dropped frames) and how long a new viewer waited for its first image.
//
// Run it once per server setting and compare (the dev compose file sets KEYFRAME_REQUEST_DELAY_MS):
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 30) \
//   node tests/e2e/keyframe-delay.mjs <label> [out.json]
import { writeFileSync } from 'node:fs';
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
const label = process.argv[2] || 'run';
const out = process.argv[3];
const STORM_HZ = Number(process.env.STORM_HZ || 5);
const CALM_S = Number(process.env.CALM_S || 36);
const STORM_S = Number(process.env.STORM_S || 48);
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');

const chrome = await launchChrome({ chrome: chromePath });
const started = Date.now();
const log = (...args) => console.log(`+${Math.round((Date.now() - started) / 1000)}s`, ...args);

const sharerStats = `(async () => {
    for (const p of rc.producers.values()) {
        if (p.kind !== 'video' || p.closed) continue;
        for (const s of (await p.getStats()).values()) {
            if (s.type === 'outbound-rtp') return { t: s.timestamp, frames: s.framesEncoded, key: s.keyFramesEncoded, pli: s.pliCount, fir: s.firCount, bytes: s.bytesSent, lim: s.qualityLimitationReason, w: s.frameWidth, enc: s.totalEncodeTime };
        }
    }
    return null;
})()`;
const viewerStats = `(async () => {
    for (const c of rc.consumers.values()) {
        if (c.kind !== 'video' || c.closed) continue;
        for (const s of (await c.getStats()).values()) {
            if (s.type === 'inbound-rtp' && s.kind === 'video') return { t: s.timestamp, frames: s.framesDecoded, key: s.keyFramesDecoded, freeze: s.freezeCount, freezeS: s.totalFreezesDuration, drop: s.framesDropped, bytes: s.bytesReceived, jb: s.jitterBufferDelay, jbN: s.jitterBufferEmittedCount, w: s.frameWidth };
        }
    }
    return null;
})()`;

// Installed in the probe pages before the app runs: records when the video consumer appears and when its first image is on screen.
const probeScript = `(() => {
    window.__probe = { t0: null, t1: null };
    const timer = setInterval(() => {
        try {
            if (typeof rc === 'undefined' || !rc || !rc.consumers) return;
            const consumer = [...rc.consumers.values()].find((c) => c.kind === 'video');
            if (!consumer) return;
            if (window.__probe.t0 === null) window.__probe.t0 = performance.now();
            const video = document.getElementById(consumer.id);
            if (video && video.videoWidth > 0 && video.readyState >= 2) {
                window.__probe.t1 = performance.now();
                clearInterval(timer);
            }
        } catch (e) {}
    }, 20);
})();`;

const stormScript = (hz) => `(() => {
    const code = 'let tr; self.onrtctransform = (e) => { tr = e.transformer; tr.readable.pipeTo(tr.writable); };' +
                 'self.onmessage = async (m) => { if (m.data === "kf" && tr) { try { await tr.sendKeyFrameRequest(); } catch (e) {} } };';
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const consumer = [...rc.consumers.values()].find((c) => c.kind === 'video');
    consumer.rtpReceiver.transform = new RTCRtpScriptTransform(worker, {});
    window.__storm = setInterval(() => worker.postMessage('kf'), ${1000 / hz});
    return true;
})()`;

async function probe(name) {
    const page = await chrome.newPage();
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: probeScript });
    try {
        await joinTestRoom(page, { origin, token, name });
        for (let i = 0; i < 100; i++) {
            const p = await page.ev('window.__probe');
            if (p && p.t1 !== null) return Math.round(p.t1 - p.t0);
            await sleep(100);
        }
        return null;
    } finally {
        await page.close();
    }
}

const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : null);
const round = (v, d = 1) => (typeof v === 'number' ? Math.round(v * 10 ** d) / 10 ** d : v);

function summarize(name, start, end, sharer, viewer, probes) {
    const dt = (end.pub.t - start.pub.t) / 1000;
    const dv = (end.view.t - start.view.t) / 1000;
    const buffered = end.view.jbN - start.view.jbN;
    return {
        phase: name,
        seconds: round(dt, 0),
        sharer: {
            keyFramesPerSecond: round((end.pub.key - start.pub.key) / dt, 2),
            keyRequestsPerSecond: round((end.pub.pli + end.pub.fir - start.pub.pli - start.pub.fir) / dt, 2),
            mbps: round(((end.pub.bytes - start.pub.bytes) * 8) / 1e6 / dt),
            encodeMsPerFrame: round(((end.pub.enc - start.pub.enc) / Math.max(1, end.pub.frames - start.pub.frames)) * 1000, 2),
            size: end.pub.w,
        },
        viewer: {
            fps: round((end.view.frames - start.view.frames) / dv),
            freezes: end.view.freeze - start.view.freeze,
            freezeSeconds: round(end.view.freezeS - start.view.freezeS, 2),
            dropped: end.view.drop - start.view.drop,
            jitterBufferMs: buffered ? round(((end.view.jb - start.view.jb) / buffered) * 1000, 1) : null,
        },
        newViewerFirstImageMs: probes,
        newViewerMedianMs: median(probes.filter((x) => x !== null)),
    };
}

try {
    console.log(`[${label}]`, chrome.version);
    const pub = await chrome.newPage();
    await stubScreenCapture(pub);
    await joinTestRoom(pub, { origin, token, name: 'KF-Sharer' });
    log('sharer joined');
    await startScreenShare(pub);
    log('sharing');

    const view = await chrome.newPage();
    await joinTestRoom(view, { origin, token, name: 'KF-Viewer' });
    for (let i = 0; i < 60 && !(await view.ev("[...rc.consumers.values()].some((c) => c.kind === 'video')")); i++) await sleep(500);
    log('viewer receiving');

    const storm = await chrome.newPage();
    await joinTestRoom(storm, { origin, token, name: 'KF-Storm' });
    for (let i = 0; i < 60 && !(await storm.ev("[...rc.consumers.values()].some((c) => c.kind === 'video')")); i++) await sleep(500);
    log('storm viewer receiving, settling');
    await sleep(8000); // settle: bitrate estimate and resolution stop changing

    const snapshot = async () => ({ pub: await pub.ev(sharerStats), view: await view.ev(viewerStats) });
    const results = [];

    // calm: new viewers join at ~25% and ~65% of the phase
    let start = await snapshot();
    let probes = [];
    await sleep(CALM_S * 0.2 * 1000);
    probes.push(await probe('KF-Probe-1'));
    log('probe 1', probes[0]);
    await sleep(CALM_S * 0.2 * 1000);
    probes.push(await probe('KF-Probe-2'));
    log('probe 2', probes[1]);
    await sleep(Math.max(0, CALM_S * 0.2 * 1000));
    results.push(summarize('calm', start, await snapshot(), null, null, probes));

    // storm
    log('calm done, starting the storm');
    await storm.ev(stormScript(STORM_HZ));
    await sleep(3000);
    start = await snapshot();
    probes = [];
    for (let i = 0; i < 3; i++) {
        await sleep((STORM_S / 5) * 1000);
        probes.push(await probe(`KF-Probe-S${i + 1}`));
        log(`storm probe ${i + 1}`, probes[i]);
    }
    await sleep((STORM_S / 5) * 1000);
    results.push(summarize(`storm ${STORM_HZ}/s`, start, await snapshot(), null, null, probes));
    await storm.ev('clearInterval(window.__storm); true');

    const report = { label, stormHz: STORM_HZ, results };
    console.log(JSON.stringify(report, null, 1));
    if (out) writeFileSync(out, JSON.stringify(report, null, 1));
} finally {
    chrome.close();
}
