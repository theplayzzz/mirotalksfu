// What a real screen-capture track does when it is asked for another size while it runs (track.applyConstraints), and how
// many frames per second the capture delivers at each size. It captures a WINDOW OF ITS OWN (a second Chrome that plays an
// animation), never the screen of whoever runs it: nothing private is ever in the picture. When Chrome does not find the
// window (it can leave out one that is off the screen) and offers the screen instead, the test stops at once, unless
// ALLOW_SCREEN=1 says the screen may be captured (a desktop with nothing private on it).
//
// Why. The sender guard can lower the size of the picture in two places: in the encoder (scaleResolutionDownBy) or in the
// capture itself (applyConstraints). When the capture is the slow part (Chrome's desktop capture may use at most half of the
// time, and it converts and scales every frame on the CPU), only the second one gives frames back. This is the test of the
// second one with a real capture: does it work, how long do the frames stop, and what does it do to the frame rate.
//
//   E2E_CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" node tests/e2e/capture-constraints.mjs
//   SRC=2560x1440      size of the window that is captured (the animation fills it)
//   SIZES=1920x1080,1280x720,960x540   what the track is asked for, in this order, after the first capture
//   SECONDS=8          how long each size is watched      LOW=1   low priority      FEATURES=...   Chrome features to enable
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, serveAssets, sleep } from './lib.mjs';

if (!process.env.E2E_CHROME) throw new Error('set E2E_CHROME');
const [SRC_W, SRC_H] = (process.env.SRC || '2560x1440').split('x').map(Number);
const SIZES = (process.env.SIZES || '1920x1080,1280x720,960x540').split(',').map((s) => s.split('x').map(Number));
const SECONDS = Number(process.env.SECONDS || 8);
const TITLE = 'E2ECAPSRC';
const features = process.env.FEATURES ? [`--enable-features=${process.env.FEATURES}`] : [];

const dir = mkdtempSync(path.join(os.tmpdir(), 'capture-constraints-'));
writeFileSync(
    path.join(dir, 'source.html'),
    `<!doctype html><meta charset="utf-8"><title>${TITLE}</title><body style="margin:0;background:#000;overflow:hidden"><canvas id="c"></canvas><script>
const c = document.getElementById('c'); const ctx = c.getContext('2d');
function fit() { c.width = innerWidth; c.height = innerHeight; } fit(); addEventListener('resize', fit);
let t = 0; const balls = Array.from({ length: 160 }, () => ({ x: Math.random() * 2560, y: Math.random() * 1440, vx: (Math.random() - .5) * 16, vy: (Math.random() - .5) * 16, r: 10 + Math.random() * 40, h: Math.random() * 360 }));
(function draw() { t++; const W = c.width, H = c.height;
  for (let i = 0; i < 14; i++) { ctx.fillStyle = 'hsl(' + ((t * 2 + i * 26) % 360) + ' 55% ' + (16 + (i % 3) * 8) + '%)'; ctx.fillRect(((i * 220 + t * 7) % (W + 300)) - 220, 0, 220, H); }
  for (const b of balls) { b.x += b.vx; b.y += b.vy; if (b.x < 0 || b.x > W) b.vx *= -1; if (b.y < 0 || b.y > H) b.vy *= -1; ctx.beginPath(); ctx.fillStyle = 'hsl(' + ((b.h + t) % 360) + ' 80% 55%)'; ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#fff'; ctx.font = 'bold 72px sans-serif'; ctx.fillText('frame ' + t, 80 + (t * 4) % (W - 500), H / 2 + Math.sin(t / 25) * H / 4);
  requestAnimationFrame(draw); })();
</script>`
);
writeFileSync(path.join(dir, 'capture.html'), '<!doctype html><meta charset="utf-8"><title>capture</title><body></body>');
const assets = await serveAssets(dir);

const lowPriority = process.env.LOW === '1';
// the window that is captured: its own Chrome, off the screen, the size of a big monitor
const source = await launchChrome({
    chrome: process.env.E2E_CHROME,
    headless: false,
    lowPriority,
    width: SRC_W,
    height: SRC_H,
    extraFlags: ['--disable-features=CalculateNativeWinOcclusion', ...features],
});
// the one that captures it: no dialog, the window with the title above is the source
const capturer = await launchChrome({
    chrome: process.env.E2E_CHROME,
    headless: false,
    lowPriority,
    extraFlags: [`--auto-select-desktop-capture-source=${TITLE}`, '--window-size=600,400', '--disable-features=CalculateNativeWinOcclusion', ...features],
});

try {
    const sourcePage = await source.newPage(`${assets.url}/source.html`);
    await sleep(3000);
    console.log('source window', await sourcePage.ev('innerWidth + "x" + innerHeight'));

    const page = await capturer.newPage(`${assets.url}/capture.html`);
    await sleep(1500);
    const start = await page.ev(`(async () => {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 60, max: 60 } }, audio: false });
        const track = stream.getVideoTracks()[0];
        // the flag that picks the window did not find it and Chrome took the screen: stop at once, nothing of it is used
        if (track.getSettings().displaySurface !== 'window' && ${JSON.stringify(process.env.ALLOW_SCREEN === '1')} === false) {
            stream.getTracks().forEach((t) => t.stop());
            return { refused: 'the capture is of the screen (' + track.label + '), not of the test window: stopped' };
        }
        window.__track = track;
        const video = document.createElement('video'); video.muted = true; video.srcObject = stream; video.style.cssText = 'width:320px'; document.body.appendChild(video); await video.play();
        window.__frames = 0; window.__last = null; window.__size = {};
        const tick = (now, meta) => { window.__frames++; window.__size = { w: meta.width, h: meta.height }; video.requestVideoFrameCallback(tick); };
        video.requestVideoFrameCallback(tick);
        const s = track.getSettings();
        return { label: track.label, surface: s.displaySurface, width: s.width, height: s.height, frameRate: s.frameRate };
    })()`);
    console.log('first capture', JSON.stringify(start));
    if (start.refused) throw new Error(start.refused + ' (ALLOW_SCREEN=1 only when the screen may be captured, with nothing private on it)');

    // frames per second delivered over a stretch of time, and the size of the last frame
    const watch = async (seconds) => {
        const a = await page.ev('window.__frames');
        const t0 = Date.now();
        await sleep(seconds * 1000);
        const b = await page.ev('window.__frames');
        const size = await page.ev('window.__size');
        return { fps: (b - a) / ((Date.now() - t0) / 1000), ...size };
    };
    await sleep(3000);
    const first = await watch(SECONDS);
    console.log(`asked 1920x1080 (the first request):  ${first.fps.toFixed(1)} fps delivered, frames are ${first.w}x${first.h}`);

    for (const [w, h] of SIZES) {
        const framesBefore = await page.ev('window.__frames');
        const t0 = Date.now();
        const result = await page.ev(`(async () => {
            const track = window.__track;
            try {
                await track.applyConstraints({ width: { ideal: ${w}, max: ${w} }, height: { ideal: ${h}, max: ${h} }, frameRate: { ideal: 60, max: 60 } });
            } catch (e) { return { error: e.name + ': ' + e.message }; }
            const s = track.getSettings();
            return { width: s.width, height: s.height, frameRate: s.frameRate };
        })()`);
        const took = Date.now() - t0;
        if (result.error) {
            console.log(`applyConstraints ${w}x${h}: ${result.error}`);
            continue;
        }
        // how long until the first frame of the new size arrives, then the rate over the stretch
        let gap = null;
        for (let i = 0; i < 100 && gap === null; i++) {
            const size = await page.ev('window.__size');
            if (size.w === w || size.h === h || Math.abs(size.w - w) <= 2) gap = Date.now() - t0;
            else await sleep(50);
        }
        await sleep(1500);
        const run = await watch(SECONDS);
        console.log(`applyConstraints ${w}x${h}: settles in ${took} ms (new size seen after ${gap === null ? '>5000' : gap} ms), settings say ${result.width}x${result.height}@${result.frameRate}; delivered ${run.fps.toFixed(1)} fps, frames are ${run.w}x${run.h}`);
        void framesBefore;
    }
} finally {
    capturer.close();
    source.close();
    assets.close();
}
process.exit(0);
