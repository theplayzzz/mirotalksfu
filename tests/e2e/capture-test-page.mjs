// The capture test page (public/views/CaptureTest.html) in a real Chrome: it runs the whole test against a screen that is
// an animated canvas (a stand-in for getDisplayMedia that also takes applyConstraints, like a screen track does), and checks
// that the page counts the frames, sends them through its two connections, reads the encoder and writes the verdict and the
// report. The numbers say nothing about a real screen (that is what the page is for, on the PC of the person); this is
// the test that the page works.
//
//   E2E_CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" node tests/e2e/capture-test-page.mjs
//   LOW=1  low priority          SHOTS=dir  a screenshot of the result
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, serveAssets, sleep } from './lib.mjs';

if (!process.env.E2E_CHROME) throw new Error('set E2E_CHROME');
const here = path.dirname(fileURLToPath(import.meta.url));
const assets = await serveAssets(path.join(here, '..', '..', 'public'));
const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME,
    headless: false,
    lowPriority: process.env.LOW === '1',
    extraFlags: ['--disable-features=CalculateNativeWinOcclusion', '--window-size=1200,900'],
});
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

// a "screen": a canvas that animates, whose size follows applyConstraints like the track of a screen capture does
const stub = `(() => {
    navigator.mediaDevices.getDisplayMedia = async (options) => {
        window.__asked = options;
        const canvas = document.createElement('canvas');
        canvas.width = 1920; canvas.height = 1080;
        const ctx = canvas.getContext('2d');
        const balls = Array.from({ length: 120 }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.01, vy: (Math.random() - 0.5) * 0.01, r: 0.01 + Math.random() * 0.03, h: Math.floor(Math.random() * 360) }));
        let tick = 0;
        (function draw() {
            tick++;
            const W = canvas.width, H = canvas.height;
            ctx.fillStyle = 'hsl(' + (tick * 2 % 360) + ' 40% 20%)'; ctx.fillRect(0, 0, W, H);
            for (const b of balls) { b.x += b.vx; b.y += b.vy; if (b.x < 0 || b.x > 1) b.vx *= -1; if (b.y < 0 || b.y > 1) b.vy *= -1; ctx.beginPath(); ctx.fillStyle = 'hsl(' + ((b.h + tick) % 360) + ' 80% 55%)'; ctx.arc(b.x * W, b.y * H, b.r * W, 0, 7); ctx.fill(); }
            requestAnimationFrame(draw);
        })();
        const stream = canvas.captureStream(60);
        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), displaySurface: 'monitor', width: canvas.width, height: canvas.height, frameRate: 60 });
        window.__applied = [];
        track.applyConstraints = async (c) => {
            window.__applied.push(JSON.parse(JSON.stringify(c)));
            canvas.width = c.width.max || c.width.ideal; canvas.height = c.height.max || c.height.ideal;
        };
        return stream;
    };
})();`;

try {
    const page = await chrome.newPage();
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
    await page.send('Page.navigate', { url: `${assets.url}/views/CaptureTest.html` });
    await sleep(1500);

    check('the page loads and offers the start button', await page.ev("!!document.getElementById('start') && document.getElementById('out').style.display === 'none'"));
    check('nothing is measured before the person asks', (await page.ev('window.__asked === undefined')) === true);

    await page.ev("document.getElementById('start').click()");
    const startedAt = Date.now();
    let done = false;
    while (Date.now() - startedAt < 150000 && !done) {
        await sleep(1500);
        done = await page.ev("document.getElementById('out').style.display !== 'none'");
    }
    check('the test ends by itself with a result', done, `${Math.round((Date.now() - startedAt) / 1000)} s`);
    if (!done) throw new Error('no result: ' + (await page.ev("document.getElementById('note').textContent + ' | ' + document.getElementById('phase').textContent")));

    const asked = await page.ev('window.__asked');
    check('it asked for the screen the way the room does (1080p, 60 fps, no audio)', asked.video.width.max === 1920 && asked.video.height.max === 1080 && asked.video.frameRate.max === 60 && asked.audio === false, JSON.stringify(asked));
    const applied = await page.ev('window.__applied');
    check('it re-asked the same capture for each size (applyConstraints), without a new picker', applied.length >= 3, JSON.stringify(applied.map((c) => `${c.width.max}x${c.height.max}`)));

    const text = await page.ev("document.getElementById('report').value");
    const jsonLine = text.split('\n').find((l) => l.startsWith('JSON: '));
    check('the report ends with the whole data in one JSON line', !!jsonLine);
    const data = JSON.parse(jsonLine.slice(6));
    console.log(text.split('\n').slice(0, 14).join('\n'));

    const byId = Object.fromEntries(data.steps.map((s) => [s.id, s]));
    check('the steps are the size the room asks for, 720p and the codec of the graphics card (and the original size on a big screen)', byId.room && byId.small && byId.h264, Object.keys(byId).join(','));
    check('the capture was counted (frames per second and the gaps between them)', byId.room.capFps > 20 && byId.room.gapP95 > 0, `${byId.room.capFps} fps, p95 ${byId.room.gapP95} ms`);
    check('the size of each frame is the one that was asked', byId.room.capW === 1920 && byId.small.capW === 1280, `${byId.room.capW}x${byId.room.capH}, ${byId.small.capW}x${byId.small.capH}`);
    check('the encoder ran: frames out, time per frame, a size and a bitrate', byId.room.encFps > 20 && byId.room.encMs > 0 && byId.room.sentW > 0 && byId.room.kbps > 0, `${byId.room.encFps} fps, ${byId.room.encMs} ms, ${byId.room.sentW}px, ${byId.room.kbps} kbps`);
    check('the H.264 step ran with a profile that the graphics card encodes (or says it cannot)', byId.h264.encFps > 20 || !!byId.h264.skipped, JSON.stringify({ fps: byId.h264.encFps, enc: byId.h264.enc, skipped: byId.h264.skipped }));
    check('the environment is in the report: browser, graphics card, screen, what it can encode', !!data.env.browser && !!data.env.gpu && !!data.env.screen && !!data.env.caps.vp8e, JSON.stringify({ gpu: data.env.gpu, caps: data.env.caps }));
    check('the verdict says something about the capture and the table has a row per step', (await page.ev("document.querySelectorAll('#verdict li').length")) >= 1 && (await page.ev("document.getElementById('table').rows.length")) === data.steps.length + 1);
    check('the page stopped the capture when it ended', (await page.ev("document.getElementById('start').disabled")) === false);

    if (process.env.SHOTS) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(path.join(process.env.SHOTS, 'capture-test-page.png'), Buffer.from(shot.result.data, 'base64'));
    }
} finally {
    chrome.close();
    assets.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
