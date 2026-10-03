// What does the recorder cost the people watching? A sharer streams a 1080p60 animation, a viewer watches, and for
// SECONDS the viewer's frames, freezes and dropped frames are counted, with the sender's own view (key frames, PLIs,
// what limits it). Run it against the same instance with replay on and with replay off (REPLAY_ENABLED=false) and
// compare: the difference must be nil. The numbers are printed as one line per run to paste into docs/MEASUREMENTS.md.
//
//   SECONDS=60 RUNS=3 E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 60) node tests/e2e/replay-live-impact.mjs
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
const SECONDS = Number(process.env.SECONDS || 60);
const RUNS = Number(process.env.RUNS || 1);
const LABEL = process.env.LABEL || '';

const viewerStats = `(async () => {
    for (const c of rc.consumers.values()) {
        if (c.kind !== 'video' || c.closed) continue;
        for (const s of (await c.getStats()).values()) {
            if (s.type === 'inbound-rtp' && s.kind === 'video') return { t: s.timestamp, frames: s.framesDecoded, dropped: s.framesDropped || 0, freezes: s.freezeCount || 0, freezeS: s.totalFreezesDuration || 0, bytes: s.bytesReceived, keys: s.keyFramesDecoded || 0, jitterS: s.jitter || 0, lost: s.packetsLost || 0 };
        }
    }
    return null;
})()`;
const senderStats = `(async () => {
    for (const p of rc.producers.values()) {
        if (p.kind !== 'video' || p.closed) continue;
        for (const s of (await p.getStats()).values()) {
            if (s.type === 'outbound-rtp') return { keyFrames: s.keyFramesEncoded, plis: s.pliCount, frames: s.framesEncoded, limit: s.qualityLimitationReason, width: s.frameWidth };
        }
    }
    return null;
})()`;

async function run(index) {
    const chrome = await launchChrome({ chrome: chromePath });
    try {
        const sharer = await chrome.newPage();
        await stubScreenCapture(sharer, { withAudio: true });
        await joinTestRoom(sharer, { origin, token, name: 'LI-Sharer' });
        const viewer = await chrome.newPage();
        await joinTestRoom(viewer, { origin, token, name: 'LI-Viewer' });
        await startScreenShare(sharer);
        await sleep(25000); // the sender needs ~20 s to reach its full rate

        const a = await viewer.ev(viewerStats);
        const senderBefore = await sharer.ev(senderStats);
        const perFive = [];
        for (let waited = 0; waited < SECONDS; waited += 5) {
            const before = await viewer.ev(viewerStats);
            await sleep(5000);
            const after = await viewer.ev(viewerStats);
            if (before && after) perFive.push(Math.round((after.frames - before.frames) / ((after.t - before.t) / 1000)));
        }
        const b = await viewer.ev(viewerStats);
        const senderAfter = await sharer.ev(senderStats);
        if (!a || !b) throw new Error('no video reached the viewer');
        const dt = (b.t - a.t) / 1000;
        const result = {
            label: LABEL,
            run: index + 1,
            seconds: Math.round(dt),
            fps: Math.round((b.frames - a.frames) / dt),
            lowestFps5s: Math.min(...perFive),
            freezes: b.freezes - a.freezes,
            freezeSeconds: Math.round((b.freezeS - a.freezeS) * 10) / 10,
            dropped: b.dropped - a.dropped,
            lostPackets: b.lost - a.lost,
            mbps: Math.round(((b.bytes - a.bytes) * 8) / 1e5 / dt) / 10,
            keyFramesAtViewer: b.keys - a.keys,
            senderKeyFrames: senderAfter.keyFrames - senderBefore.keyFrames,
            senderPlis: senderAfter.plis - senderBefore.plis,
            senderLimit: senderAfter.limit,
            senderWidth: senderAfter.width,
        };
        console.log(JSON.stringify(result));
        return result;
    } finally {
        chrome.close();
    }
}

const results = [];
for (let i = 0; i < RUNS; i++) results.push(await run(i));
const avg = (key) => Math.round((results.reduce((sum, r) => sum + r[key], 0) / results.length) * 10) / 10;
console.log(`${LABEL || 'runs'}: fps ${avg('fps')}, freezes per run ${avg('freezes')}, dropped ${avg('dropped')}, lost packets ${avg('lostPackets')}, Mbps ${avg('mbps')}, sender key frames ${avg('senderKeyFrames')}`);
process.exit(0);
