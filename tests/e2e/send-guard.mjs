// The sender guard in a real Chrome: a sender shares a 1080p60 animation, then the PC it runs on gets busy (CPU hogs), the
// encoder falls behind, and the guard has to take the picture one rung down the ladder (a smaller size, a lower bitrate) so
// that the frame rate comes back. The test reads, every few seconds, what the browser sends (frames per second, size) and what
// the guard decided (SendGuard.snapshot, the encoder's scaleResolutionDownBy).
//
//   needs the dev instance with SEND_GUARD=apply
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 20) node tests/e2e/send-guard.mjs
//   HOG=10        how many CPU-hungry processes to start (default: half the logical cores); they run at a low priority, like the
//                 browser, so a game that is running on the same PC still has the CPU it needs
//   SECONDS=120   how long the PC stays busy
//   LOW=1 is the default here (the hogs and the browser both at a low priority)
import { spawn } from 'node:child_process';
import os from 'node:os';
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
const HOG = Number(process.env.HOG || Math.max(2, Math.floor(os.cpus().length / 2)));
const BUSY_SECONDS = Number(process.env.SECONDS || 120);

const hogs = [];
const stopHogs = () => {
    for (const hog of hogs.splice(0)) hog.kill();
};
process.once('exit', stopHogs);

const chrome = await launchChrome({ chrome: chromePath, lowPriority: process.env.LOW !== '0' });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

const read = `(async () => {
    const producer = [...rc.producers.values()].find((p) => p.kind === 'video' && !p.closed);
    if (!producer) return null;
    const report = await producer.getStats();
    let out = null, source = null;
    report.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') out = s; if (s.type === 'media-source') source = s; });
    const parameters = producer.rtpSender.getParameters();
    const guard = window.SendGuard && window.SendGuard.snapshot(producer.id);
    return { frames: out && out.framesEncoded, time: out && out.totalEncodeTime, ts: out && out.timestamp, w: out && out.frameWidth, h: out && out.frameHeight,
        srcFrames: source && source.frames, scale: parameters.encodings[0].scaleResolutionDownBy, maxBitrate: parameters.encodings[0].maxBitrate,
        degr: parameters.degradationPreference, hint: producer.track.contentHint, guard };
})()`;

try {
    const sharer = await chrome.newPage();
    await stubScreenCapture(sharer, { fps: 60 });
    await joinTestRoom(sharer, { origin, token, name: 'SG-Sharer' });
    const config = await sharer.ev("fetch('/config').then((r) => r.json())");
    check('the instance runs the guard in apply mode', config.screen.guard === 'apply', String(config.screen.guard));
    await startScreenShare(sharer);

    let before = await sharer.ev(read);
    const series = [];
    const sampleEvery = async (seconds, label) => {
        const after = await (async () => {
            await sleep(seconds * 1000);
            return sharer.ev(read);
        })();
        const dt = (after.ts - before.ts) / 1000;
        const row = {
            label,
            fps: (after.frames - before.frames) / dt,
            srcFps: (after.srcFrames - before.srcFrames) / dt,
            encMs: ((after.time - before.time) / Math.max(1, after.frames - before.frames)) * 1000,
            w: after.w, scale: after.scale, maxMbps: after.maxBitrate / 1e6, guard: after.guard && `${after.guard.rung}/${after.guard.why}`,
        };
        series.push(row);
        console.log(`  ${label.padEnd(10)} fps ${row.fps.toFixed(1)} (capture ${row.srcFps.toFixed(1)})  encoder ${row.encMs.toFixed(1)} ms/frame  picture ${row.w}px  scale ${row.scale}  ceiling ${row.maxMbps.toFixed(1)} Mbps  guard ${row.guard}`);
        before = after;
        return { row, after };
    };

    // 1. a quiet PC: 25 s for the sender to ramp up, then 15 s of measuring
    await sleep(25000);
    before = await sharer.ev(read);
    const calm = await sampleEvery(15, 'quiet PC');
    check('the guard took over the encoder settings: maintain-framerate and the motion hint', calm.after.degr === 'maintain-framerate' && calm.after.hint === 'motion', JSON.stringify({ degr: calm.after.degr, hint: calm.after.hint }));
    check('on a quiet PC the picture stays at full size and 60 fps', calm.row.fps >= 54 && (calm.after.scale === undefined || calm.after.scale === 1), `${calm.row.fps.toFixed(1)} fps, scale ${calm.after.scale}`);

    // 2. the PC gets busy
    for (let i = 0; i < HOG; i++) {
        const hog = spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' });
        try {
            os.setPriority(hog.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch (error) {
            // runs at the normal priority
        }
        hogs.push(hog);
    }
    console.log(`${HOG} CPU-hungry processes started (low priority) for ${BUSY_SECONDS} s`);
    const slow = [];
    for (let waited = 0; waited < BUSY_SECONDS; waited += 10) slow.push((await sampleEvery(10, `busy ${waited + 10}s`)).row);
    stopHogs();

    const worst = Math.min(...slow.map((r) => r.fps));
    const last = slow[slow.length - 1];
    const lowered = slow.some((r) => r.scale > 1);
    console.log(`lowest frame rate while busy: ${worst.toFixed(1)} fps; at the end: ${last.fps.toFixed(1)} fps at scale ${last.scale}`);
    if (worst >= 54) {
        console.log('(the PC did not get busy enough to slow the encoder: nothing for the guard to do; try a bigger HOG)');
    } else {
        check('the guard lowered the size of the picture when the encoder fell behind', lowered, JSON.stringify(slow.map((r) => r.scale)));
        check('and the frame rate came back (last 20 s average >= 45 fps)', slow.slice(-2).every((r) => r.fps >= 45), JSON.stringify(slow.slice(-2).map((r) => r.fps.toFixed(1))));
    }
} finally {
    stopHogs();
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
