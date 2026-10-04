// How many frames per second does Chrome's capture of a WINDOW deliver, as the size of that window grows, and do the capture
// options of the browser change it? The window is one of its own (a second Chrome that plays an animation that fills it), so
// nothing of the screen of whoever runs this is ever in the picture: only that window is captured. The window is placed so
// that a single pixel column of it is on the monitor (the rest is off the right edge of the screen; the system still draws it
// whole and the capture still reads it whole), which is invisible on the desktop.
//
//   E2E_CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" node tests/e2e/capture-source-size.mjs
//   SIZES=1280x720,1920x1080,2560x1400     the sizes of the window that is captured
//   FEATURES="WebRtcAllowWgcUsingTexture,ZeroCopyDesktopCapture"   Chrome features to enable in the capturing browser as well
//   REQUEST=1920x1080   what the capture is asked for (the room asks 1920x1080)      SECONDS=8   LOW=1   low priority
//   LEFT=2559           the left edge of the window (the monitor ends there)
//
// If Chrome does not find the window it offers the screen instead: the test stops at once (the screen is never used).
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, serveAssets, sleep } from './lib.mjs';

if (!process.env.E2E_CHROME) throw new Error('set E2E_CHROME');
const SIZES = (process.env.SIZES || '1280x720,1920x1080,2560x1400').split(',').map((s) => s.split('x').map(Number));
const [REQ_W, REQ_H] = (process.env.REQUEST || '1920x1080').split('x').map(Number);
const SECONDS = Number(process.env.SECONDS || 8);
const LEFT = Number(process.env.LEFT || 2559);
const features = process.env.FEATURES ? [`--enable-features=${process.env.FEATURES}`] : [];
const lowPriority = process.env.LOW === '1';

const dir = mkdtempSync(path.join(os.tmpdir(), 'capture-source-size-'));
const title = (w, h) => `E2ECAPSRC${w}x${h}`;
for (const [w, h] of SIZES) {
    // the animation fills the window and changes everywhere all the time, like a game
    writeFileSync(
        path.join(dir, `source-${w}x${h}.html`),
        `<!doctype html><meta charset="utf-8"><title>${title(w, h)}</title><body style="margin:0;background:#000;overflow:hidden"><canvas id="c"></canvas><script>
const c = document.getElementById('c'); const ctx = c.getContext('2d');
function fit() { c.width = innerWidth; c.height = innerHeight; } fit(); addEventListener('resize', fit);
let t = 0; window.__ticks = 0;
(function draw() { t++; window.__ticks++; const W = c.width, H = c.height;
  ctx.fillStyle = '#10141c'; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 24; i++) { ctx.fillStyle = 'hsl(' + ((t * 3 + i * 15) % 360) + ' 70% ' + (25 + (i % 3) * 10) + '%)'; ctx.fillRect(((i * (W / 12) + t * 9) % (W + 200)) - 200, 0, W / 14, H); }
  requestAnimationFrame(draw); })();
</script>`
    );
}
writeFileSync(path.join(dir, 'capture.html'), '<!doctype html><meta charset="utf-8"><title>capture</title><body></body>');
const assets = await serveAssets(dir);

// what the capturing browser does, for one size of window
async function measure(w, h, withFeatures) {
    // the window that is captured: its own Chrome, the size asked, one column on the monitor
    const source = await launchChrome({
        chrome: process.env.E2E_CHROME,
        headless: false,
        lowPriority,
        width: w,
        height: h,
        extraFlags: [`--window-position=${LEFT},0`, '--disable-features=CalculateNativeWinOcclusion'],
    });
    // the one that captures it: no dialog, the window with the title above is the source
    const capturer = await launchChrome({
        chrome: process.env.E2E_CHROME,
        headless: false,
        lowPriority,
        // no fake answer to the permission question: when the flag does not find the window the capture waits for a person, it does not take the screen
        fakeUi: false,
        extraFlags: [`--auto-select-desktop-capture-source=${title(w, h)}`, '--window-size=600,400', '--disable-features=CalculateNativeWinOcclusion', ...(withFeatures ? features : [])],
    });
    try {
        const sourcePage = await source.newPage(`${assets.url}/source-${w}x${h}.html`);
        await sleep(3000);
        const size = await sourcePage.ev('innerWidth + "x" + innerHeight');
        const page = await capturer.newPage(`${assets.url}/capture.html`);
        await sleep(1500);
        const start = await page.ev(`(async () => {
            // (when the flag does not find the window there is a question for a person: it must not wait for ever)
            const stream = await Promise.race([
                navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: ${REQ_W}, max: ${REQ_W} }, height: { ideal: ${REQ_H}, max: ${REQ_H} }, frameRate: { ideal: 60, max: 60 } }, audio: false }),
                new Promise((resolve, reject) => setTimeout(() => reject(new Error('the browser did not pick the window in 20 s')), 20000)),
            ]);
            const track = stream.getVideoTracks()[0];
            const surface = track.getSettings().displaySurface;
            if (surface !== 'window') { stream.getTracks().forEach((t) => t.stop()); return { refused: 'the capture is of ' + surface + ' (' + track.label + '), not of the test window: stopped' }; }
            window.__frames = 0; window.__w = 0; window.__h = 0;
            const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
            (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; window.__frames++; window.__w = value.displayWidth; window.__h = value.displayHeight; value.close(); } })();
            return { label: track.label, surface };
        })()`);
        if (start.refused) throw new Error(start.refused);
        await sleep(4000); // settles
        const f0 = await page.ev('window.__frames');
        const k0 = await sourcePage.ev('window.__ticks');
        const t0 = Date.now();
        await sleep(SECONDS * 1000);
        const f1 = await page.ev('window.__frames');
        const k1 = await sourcePage.ev('window.__ticks');
        const seconds = (Date.now() - t0) / 1000;
        const delivered = await page.ev('window.__w + "x" + window.__h');
        // (how often the window itself drew: a capture cannot give more frames than the window makes)
        return { window: size, delivered, fps: (f1 - f0) / seconds, drawn: (k1 - k0) / seconds };
    } finally {
        capturer.close();
        source.close();
    }
}

const rows = [];
try {
    for (const withFeatures of features.length ? [false, true] : [false]) {
        for (const [w, h] of SIZES) {
            const r = await measure(w, h, withFeatures);
            rows.push({ withFeatures, ...r });
            console.log(`${withFeatures ? 'with the options' : 'default       '}  window ${r.window.padEnd(10)} asked ${REQ_W}x${REQ_H} -> frames of ${r.delivered.padEnd(10)}  ${r.fps.toFixed(1)} fps  (about ${(500 / Math.max(r.fps, 0.1)).toFixed(1)} ms per frame by the half-of-the-time rule; the window drew ${r.drawn.toFixed(0)} a second)`);
            await sleep(1500);
        }
    }
} finally {
    assets.close();
}
process.exit(0);
