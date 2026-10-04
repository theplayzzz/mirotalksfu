// The sender guard's trial of a smaller capture, in a real Chrome on the development instance (SEND_GUARD=apply): a sender
// shares a "screen" whose capture is slow (30 frames per second while the picture is big, as a whole 2K screen can be),
// the guard notices that the capture and not the encoder is the limit, asks the capture for a smaller size
// (track.applyConstraints) and sees what it gives. Two screens are tried:
//
//   fast-when-small   the capture is 30 fps at 1920x1080 and 60 fps at the 80% size: the smaller size has to be kept
//   same-everywhere   the capture is 30 fps whatever the size (a video that really is 30 fps): the guard has to try, see that
//                     it did not help, and go back to the size it had, and not try again for minutes
//   TIP=1 adds a third one, 33 fps whatever the size (not a film's rate): after 90 s with nothing left to try the sender is told,
//                     once, in a notice of its own, what usually helps
//
// The page asks for the screen the way the room does; what is replaced is the capture itself (a canvas whose drawing rate
// and size follow what the track is asked for, like the capture of a screen does).
//
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 20) node tests/e2e/capture-trial.mjs
//   HEADED=1  a real window      LOW=1  low priority (the default here)
import { joinTestRoom, launchChrome, sleep, startScreenShare } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');

const chrome = await launchChrome({ chrome: chromePath, headless: process.env.HEADED !== '1', lowPriority: process.env.LOW !== '0' });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

// A capture with a speed that depends on its size: `slowAbove` = the width above which it only gives every other frame
const stub = (slowAbove, slowFps = 30) => `(() => {
    window.__applied = [];
    navigator.mediaDevices.getDisplayMedia = async (options) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1920; canvas.height = 1080;
        const ctx = canvas.getContext('2d');
        const balls = Array.from({ length: 160 }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.012, vy: (Math.random() - 0.5) * 0.012, r: 0.01 + Math.random() * 0.03, h: Math.floor(Math.random() * 360) }));
        let tick = 0;
        let track = null;
        let owed = 0;
        let last = performance.now();
        (function draw() {
            const now = performance.now();
            owed += now - last;
            last = now;
            // a slow capture gives 30 frames a second, a fast one 60 (the animation frames come faster than that in a headless
            // Chrome, so the rate is kept by time): the canvas is only drawn, and so only captured, when a frame is due
            const interval = canvas.width > ${slowAbove} ? 1000 / ${slowFps} : 1000 / 60;
            if (owed < interval) return requestAnimationFrame(draw);
            owed = Math.min(owed - interval, interval);
            tick++;
            const W = canvas.width, H = canvas.height;
            // a still background and balls that move: like a game, it needs real bits but not the whole picture changing every frame
            ctx.fillStyle = '#10141c'; ctx.fillRect(0, 0, W, H);
            for (const b of balls) { b.x += b.vx; b.y += b.vy; if (b.x < 0 || b.x > 1) b.vx *= -1; if (b.y < 0 || b.y > 1) b.vy *= -1; ctx.beginPath(); ctx.fillStyle = 'hsl(' + ((b.h + tick) % 360) + ' 80% 55%)'; ctx.arc(b.x * W, b.y * H, b.r * W, 0, 7); ctx.fill(); }
            // frames are captured when this says so (captureStream(0)): a canvas that is drawn less often is NOT repeated
            if (track && track.requestFrame) track.requestFrame();
            requestAnimationFrame(draw);
        })();
        const stream = canvas.captureStream(0);
        track = stream.getVideoTracks()[0];
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), displaySurface: 'monitor', width: canvas.width, height: canvas.height, frameRate: 60 });
        track.applyConstraints = async (c) => {
            window.__applied.push({ at: Math.round(performance.now()), w: c.width.max || c.width.ideal, h: c.height.max || c.height.ideal });
            canvas.width = c.width.max || c.width.ideal;
            canvas.height = c.height.max || c.height.ideal;
        };
        return stream;
    };
})();`;

const read = `(async () => {
    const producer = [...rc.producers.values()].find((p) => p.kind === 'video' && !p.closed);
    if (!producer) return null;
    const report = await producer.getStats();
    let out = null, source = null;
    report.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') out = s; if (s.type === 'media-source') source = s; });
    const guard = window.SendGuard && window.SendGuard.snapshot(producer.id);
    return { frames: out && out.framesEncoded, srcFrames: source && source.frames, ts: out && out.timestamp, w: source && source.width, h: source && source.height, sentW: out && out.frameWidth,
        kbps: out && out.bytesSent, guard, applied: window.__applied };
})()`;

async function scenario(name, slowAbove, expectation, { slowFps = 30, seconds = 75 } = {}) {
    console.log(`\n== ${name}`);
    const sharer = await chrome.newPage();
    await sharer.send('Page.addScriptToEvaluateOnNewDocument', { source: stub(slowAbove, slowFps) });
    await joinTestRoom(sharer, { origin, token, name: `CT-${name}` });
    const config = await sharer.ev("fetch('/config').then((r) => r.json())");
    check('the instance runs the guard in apply mode', config.screen.guard === 'apply', String(config.screen.guard));
    await startScreenShare(sharer);

    let before = await sharer.ev(read);
    const series = [];
    // 75 s: the first 10 s of cooldown, 8 s of slow capture, the trial (11 s), and time for the verdict to show
    for (let t = 2; t <= seconds; t += 3) {
        await sleep(3000);
        const now = await sharer.ev(read);
        const dt = (now.ts - before.ts) / 1000;
        const row = { t, srcFps: (now.srcFrames - before.srcFrames) / dt, fps: (now.frames - before.frames) / dt, w: now.w, h: now.h, rung: now.guard && now.guard.rung, cap: now.guard && now.guard.cap, why: now.guard && now.guard.why, applied: now.applied.length };
        series.push(row);
        console.log(`  ${String(t).padStart(3)} s  capture ${row.srcFps.toFixed(1).padStart(5)} fps  sent ${row.fps.toFixed(1).padStart(5)} fps  picture ${row.w}x${row.h}  guard cap ${row.cap} rung ${row.rung} (${row.why})  applyConstraints calls ${row.applied}`);
        before = now;
    }
    const applied = (await sharer.ev(read)).applied;
    await expectation(series, applied, sharer);
    await sharer.close();
    await sleep(3000);
}

try {
    await scenario('fast-when-small', 1600, async (series, applied) => {
        check('a slow capture at the full size is seen (about 30 fps)', series.slice(2, 5).some((r) => r.srcFps > 20 && r.srcFps < 40), JSON.stringify(series.slice(2, 5).map((r) => r.srcFps.toFixed(0))));
        check('the guard asked the capture for 80% of its size (1536x864)', applied.length >= 1 && applied[0].w === 1536 && applied[0].h === 864, JSON.stringify(applied));
        check('and only that: the smaller size was kept, it was not taken back', applied.length === 1, `${applied.length} call(s)`);
        const last = series[series.length - 1];
        check('the capture now gives 50+ fps at the smaller size', last.srcFps >= 50 && last.w === 1536, `${last.srcFps.toFixed(1)} fps at ${last.w}x${last.h}`);
        // (what the encoder sends then depends on the estimate of the line of the PC that runs the test: it only has to be well above
        // the 30 fps of before)
        check('the picture that is sent follows (well above the 30 fps of before)', last.fps >= 42, `${last.fps.toFixed(1)} fps`);
        check('the guard says so: capture rung 1, kept', last.cap === 1 && /capture-kept|capture-trial|steady|ok|bandwidth/.test(String(last.why)), `${last.cap} ${last.why}`);
    });

    await scenario('same-everywhere', 0, async (series, applied) => {
        check('a capture that is 30 fps at any size is seen', series.slice(2, 5).some((r) => r.srcFps > 20 && r.srcFps < 40), JSON.stringify(series.slice(2, 5).map((r) => r.srcFps.toFixed(0))));
        check('the guard tried the smaller size and then went back to the full one', applied.length === 2 && applied[0].w === 1536 && applied[1].w === 1920, JSON.stringify(applied));
        const last = series[series.length - 1];
        check('it is back at the size it had, with capture rung 0', last.cap === 0 && last.w === 1920, `${last.cap} ${last.w}x${last.h} (${last.why})`);
        const gap = applied.length === 2 ? (applied[1].at - applied[0].at) / 1000 : 0;
        check('the verdict came after the trial time (about 11 s), not at once', gap >= 9 && gap <= 20, `${gap.toFixed(1)} s`);
    });

    if (process.env.TIP === '1') {
        await scenario(
            'tip-after-90-s',
            0,
            async (series, applied, sharer) => {
                check('the guard tried a smaller capture and went back, as in the other case', applied.length === 2, JSON.stringify(applied));
                const tip = await sharer.ev("(() => { const t = document.getElementById('sendGuardTip'); return t ? { text: t.textContent, link: (t.querySelector('a') || {}).getAttribute && t.querySelector('a').getAttribute('href') } : null; })()");
                check('the sender got a notice that says the capture is slow, with the rate, and where to measure it', !!tip && /captura da sua tela est/.test(tip.text) && /3[2-4] fps/.test(tip.text) && tip.link === '/capture-test', JSON.stringify(tip));
                check('the machine translation of the room left the text as written', !!tip && /ligar o PC na tomada/.test(tip.text) && /acelera..o por hardware/.test(tip.text), tip && tip.text.slice(-120));
                const count = await sharer.ev("document.querySelectorAll('#sendGuardTip').length");
                check('only one notice', count === 1, String(count));
            },
            { slowFps: 33, seconds: 111 }
        );
    }
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
