// The capture test page (public/views/CaptureTest.html) in a real Chrome, four ways:
//
//   stub    the "screen" is an animated canvas that also takes applyConstraints, like a screen track does. Checks the whole
//           flow: what is on the screen while it runs (the progress panel, the title of the tab, the live frame rate), the
//           numbers, the verdict, the report.
//   tab     a REAL capture (the browser's own capture of this tab, picked by the auto-select flag: no picker), so the parts that
//           a canvas cannot show are real too: MediaStreamTrackProcessor on a capture track, applyConstraints on it, the
//           encoders fed by it. "Medir agora" makes the page move on the whole viewport, so there is always something to capture.
//   game    "Medir com o jogo", with a REAL capture of ANOTHER tab that animates (the stand-in for a game) while the page itself
//           is hidden behind a third tab, as it is behind a game: the countdown, the measuring while hidden, the title that
//           turns into a check mark, the result when the person comes back.
//   still   a "screen" that never changes: the steps are marked as still and the verdict says so, instead of concluding anything
//
// The numbers say nothing about a real screen (that is what the page is for, on the PC of the person); this is the test that the
// page works. Nothing of the screen of whoever runs it is captured: the sources are canvases and tabs of the test.
//
//   E2E_CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" node tests/e2e/capture-test-page.mjs
//   ONLY=stub,tab,game,still   which ones      LOW=1  low priority      SHOTS=dir  a screenshot of each result
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, serveAssets, sleep } from './lib.mjs';

if (!process.env.E2E_CHROME) throw new Error('set E2E_CHROME');
const here = path.dirname(fileURLToPath(import.meta.url));
const only = (process.env.ONLY || 'stub,tab,game,still').split(',');
const assets = await serveAssets(path.join(here, '..', '..', 'public'));

// the page that stands for a game: it never stops moving
const gameDir = mkdtempSync(path.join(os.tmpdir(), 'capture-test-game-'));
const GAME_TITLE = 'E2EGAMETAB';
writeFileSync(
    path.join(gameDir, 'game.html'),
    `<!doctype html><meta charset="utf-8"><title>${GAME_TITLE}</title><body style="margin:0;background:#000;overflow:hidden"><canvas id="c" width="1280" height="720" style="width:100vw;height:100vh"></canvas><script>
const c = document.getElementById('c'); const ctx = c.getContext('2d'); let t = 0;
const balls = Array.from({ length: 160 }, () => ({ x: Math.random() * 1280, y: Math.random() * 720, vx: (Math.random() - .5) * 14, vy: (Math.random() - .5) * 14, r: 8 + Math.random() * 30, h: Math.random() * 360 }));
(function draw() { t++; ctx.fillStyle = '#10141c'; ctx.fillRect(0, 0, 1280, 720);
  for (let i = 0; i < 10; i++) { ctx.fillStyle = 'hsl(' + ((t * 2 + i * 36) % 360) + ' 55% 30%)'; ctx.fillRect(((i * 150 + t * 7) % 1500) - 200, 0, 140, 720); }
  for (const b of balls) { b.x += b.vx; b.y += b.vy; if (b.x < 0 || b.x > 1280) b.vx *= -1; if (b.y < 0 || b.y > 720) b.vy *= -1; ctx.beginPath(); ctx.fillStyle = 'hsl(' + ((b.h + t) % 360) + ' 80% 55%)'; ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill(); }
  requestAnimationFrame(draw); })();
</script>`
);
const gameAssets = await serveAssets(gameDir);

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

// a "screen": a canvas that animates (or gives a frame a second and nothing else), whose size follows applyConstraints like the
// track of a screen capture does
const stub = (moving) => `(() => {
    navigator.mediaDevices.getDisplayMedia = async (options) => {
        window.__asked = options;
        const canvas = document.createElement('canvas');
        canvas.width = 1920; canvas.height = 1080;
        const ctx = canvas.getContext('2d');
        const balls = Array.from({ length: 120 }, () => ({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.01, vy: (Math.random() - 0.5) * 0.01, r: 0.01 + Math.random() * 0.03, h: Math.floor(Math.random() * 360) }));
        let tick = 0;
        const stream = canvas.captureStream(${moving ? 60 : 0});
        const track = stream.getVideoTracks()[0];
        const draw = () => {
            tick++;
            const W = canvas.width, H = canvas.height;
            ctx.fillStyle = 'hsl(' + (${moving ? 'tick * 2 % 360' : '200'}) + ' 40% 20%)'; ctx.fillRect(0, 0, W, H);
            if (${moving}) for (const b of balls) { b.x += b.vx; b.y += b.vy; if (b.x < 0 || b.x > 1) b.vx *= -1; if (b.y < 0 || b.y > 1) b.vy *= -1; ctx.beginPath(); ctx.fillStyle = 'hsl(' + ((b.h + tick) % 360) + ' 80% 55%)'; ctx.arc(b.x * W, b.y * H, b.r * W, 0, 7); ctx.fill(); }
        };
        if (${moving}) { (function loop() { draw(); requestAnimationFrame(loop); })(); }
        else { draw(); track.requestFrame(); setInterval(() => track.requestFrame(), 1000); } // a picture that never changes: a keep-alive a second
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), displaySurface: 'monitor', width: canvas.width, height: canvas.height, frameRate: 60 });
        window.__applied = [];
        track.applyConstraints = async (c) => {
            window.__applied.push(JSON.parse(JSON.stringify(c)));
            canvas.width = c.width.max || c.width.ideal; canvas.height = c.height.max || c.height.ideal;
            if (!${moving}) { draw(); track.requestFrame(); }
        };
        return stream;
    };
})();`;

// the real capture of a TAB of the test (the browser is told which one by its title). Anything that is not a tab is stopped the moment
// it is given: when the title does not match, the browser offers the screen of whoever runs the test, and that is never captured.
const realCapture = () => `(() => {
    const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (options = {}) => {
        window.__asked = options;
        const stream = await original({ ...options, selfBrowserSurface: 'include' });
        const surface = stream.getVideoTracks()[0].getSettings().displaySurface;
        if (surface !== 'browser') {
            stream.getTracks().forEach((t) => t.stop());
            window.__refusedSurface = surface;
            throw new DOMException('the test refuses to capture ' + surface + ': only a tab of the test is allowed', 'NotAllowedError');
        }
        return stream;
    };
})();`;

// the page, the way a person sees it: what is on the screen while it runs and when it ends
async function runPage(name, { script, search = '', clickId, hideBehind = false, gameTab = false, seconds = 150, pageTitle = null, tabTitle = null }) {
    console.log(`\n== ${name}`);
    // one browser per way: the flag that picks a tab by its title takes one title
    const chrome = await launchChrome({
        chrome: process.env.E2E_CHROME,
        headless: false,
        lowPriority: process.env.LOW === '1',
        tabCaptureTitle: tabTitle || 'E2E-NO-TAB',
        // no fake answer to the permission questions: a capture that the title flag does not answer waits for a person, it does not take the screen
        fakeUi: !tabTitle,
        extraFlags: ['--disable-features=CalculateNativeWinOcclusion', '--window-size=1280,900'],
    });
    try {
        let game = null;
        if (gameTab) {
            game = await chrome.newPage(`${gameAssets.url}/game.html`);
            await sleep(1500);
        }
        // (a page that is going to be hidden is a tab of the first window, so that another tab of that window can go in front of it)
        const page = hideBehind ? await chrome.newPage('about:blank', { newWindow: false }) : await chrome.newPage();
        if (script) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
        await page.send('Page.navigate', { url: `${assets.url}/views/CaptureTest.html${search}` });
        await sleep(1500);
        // (a real capture of this very tab is picked by its title: the page has the title the flag was given)
        if (pageTitle) await page.ev(`document.title = ${JSON.stringify(pageTitle)}; true`);
        check(`${name}: the page offers both ways to start and shows nothing of a test yet`, await page.ev("!!document.getElementById('startNow') && !!document.getElementById('startGame') && document.getElementById('stage').hidden && document.getElementById('out').hidden"));
        check(`${name}: the progress panel can be seen when it is shown (the stylesheet does not keep it hidden)`, await page.ev("(() => { const s = document.getElementById('stage'); s.hidden = false; const shown = getComputedStyle(s).display !== 'none'; s.hidden = true; return shown; })()"));

        await page.ev(`document.getElementById('${clickId}').click()`);
        const startedAt = Date.now();
        const seen = { titles: new Set(), phases: new Set(), live: new Set(), stageShown: false, steps: 0, motion: false };
        let done = false;
        let behind = null;
        while (Date.now() - startedAt < seconds * 1000 && !done) {
            await sleep(1000);
            const state = await page.ev("({ stage: !document.getElementById('stage').hidden && getComputedStyle(document.getElementById('stage')).display !== 'none', title: document.title, phase: document.getElementById('phase').textContent, live: document.getElementById('live').textContent, steps: document.querySelectorAll('#steps li').length, motion: !document.getElementById('motion').hidden, out: !document.getElementById('out').hidden, note: document.getElementById('note').textContent })");
            if (state.stage) seen.stageShown = true;
            seen.titles.add(state.title);
            seen.phases.add(state.phase.replace(/\d+/g, 'N'));
            if (state.live) seen.live.add(state.live.replace(/\d+/g, 'N'));
            seen.steps = Math.max(seen.steps, state.steps);
            if (state.motion) seen.motion = true;
            if (state.note) console.log('   note on the page:', state.note);
            // the page goes behind another tab of its window, as it does behind a game, once the countdown has begun
            if (hideBehind && !behind && Date.now() - startedAt > 4000) {
                await chrome.browser.send('Target.activateTarget', { targetId: page.targetId });
                // (the library makes every page believe it is in front: this one has to feel what really happens to it)
                await page.send('Emulation.setFocusEmulationEnabled', { enabled: false });
                behind = await chrome.newPage(`${gameAssets.url}/game.html`, { newWindow: false });
                await sleep(800);
                const visibility = await page.ev('document.visibilityState');
                console.log('   the page is now:', visibility);
                check(`${name}: the page really is hidden behind the other tab while it measures`, visibility === 'hidden');
            }
            done = state.out;
        }
        check(`${name}: the test ends by itself with a result`, done, `${Math.round((Date.now() - startedAt) / 1000)} s`);
        check(`${name}: while it ran the progress panel was on the screen, with the steps listed`, seen.stageShown && seen.steps >= 3, `${seen.steps} steps`);
        check(`${name}: the person could see what was going on: the phase changed and the live frame rate was shown`, seen.phases.size >= 3 && seen.live.size >= 1, `${seen.phases.size} phases, ${[...seen.live][0] || 'no live line'}`);
        const titles = [...seen.titles];
        const finalTitle = await page.ev('document.title');
        check(`${name}: the title of the tab says it is measuring, and then that it is done`, titles.some((t) => /^⏳/.test(t)) && finalTitle.startsWith('✅'), JSON.stringify(titles.slice(0, 3)) + ' ... ' + finalTitle);
        if (clickId === 'startNow') check(`${name}: "Medir agora" made the page move on the whole viewport`, seen.motion);
        if (!done) throw new Error('no result: ' + (await page.ev("document.getElementById('note').textContent + ' | ' + document.getElementById('phase').textContent")));
        if (behind) await chrome.browser.send('Target.activateTarget', { targetId: page.targetId });

        if (process.env.SHOTS) {
            const shot = await page.send('Page.captureScreenshot', { format: 'png' });
            writeFileSync(path.join(process.env.SHOTS, `capture-test-${name}.png`), Buffer.from(shot.result.data, 'base64'));
        }
        const text = await page.ev("document.getElementById('report').value");
        const jsonLine = text.split('\n').find((l) => l.startsWith('JSON: '));
        check(`${name}: the report ends with the whole data in one JSON line`, !!jsonLine);
        const data = JSON.parse(jsonLine.slice(6));
        const verdict = await page.ev("[...document.querySelectorAll('#verdict li')].map((li) => li.textContent)");
        console.log(text.split('\n').slice(0, 12).join('\n'));
        check(`${name}: the result can also be downloaded as a file`, await page.ev("document.getElementById('download').href.startsWith('blob:')"));
        check(`${name}: the page stopped the capture and can be used again`, (await page.ev("!document.getElementById('startNow').disabled && !document.getElementById('startGame').disabled")) === true);
        return { data, verdict, seen };
    } finally {
        chrome.close();
    }
}

try {
    if (only.includes('stub')) {
        const { data } = await runPage('stub', { script: stub(true), clickId: 'startNow' });
        const byId = Object.fromEntries(data.steps.map((s) => [s.id, s]));
        check('stub: the steps are the size the room asks for, 720p and the codec of the graphics card (and the original size on a big screen)', byId.room && byId.small && byId.h264, Object.keys(byId).join(','));
        check('stub: the capture was counted (frames per second and the gaps between them)', byId.room.capFps > 20 && byId.room.gapP95 > 0, `${byId.room.capFps} fps, p95 ${byId.room.gapP95} ms`);
        check('stub: the encoder ran: frames out, time per frame, a size and a bitrate', byId.room.encFps > 20 && byId.room.encMs > 0 && byId.room.sentW > 0 && byId.room.kbps > 0, `${byId.room.encFps} fps, ${byId.room.encMs} ms, ${byId.room.sentW}px, ${byId.room.kbps} kbps`);
        check('stub: the environment is in the report: browser, graphics card, screen, what it can encode', !!data.env.browser && !!data.env.gpu && !!data.env.screen && !!data.env.caps.vp8e, JSON.stringify({ gpu: data.env.gpu }));
        check('stub: the report says how it was made', data.env.mode === 'now' && data.env.surface === 'monitor' && data.v === 2);
    }

    if (only.includes('tab')) {
        const TAB = 'E2ECAPTURETAB';
        const { data, verdict } = await runPage('tab', { script: realCapture(), search: '?allow=browser', clickId: 'startNow', pageTitle: TAB, tabTitle: TAB });
        const byId = Object.fromEntries(data.steps.map((s) => [s.id, s]));
        check('tab: a real capture track was measured: frames counted at the size asked, the encoder fed by it', byId.room && byId.room.capFps > 10 && byId.room.encFps > 5 && byId.room.capW > 0, JSON.stringify({ cap: byId.room && byId.room.capFps, enc: byId.room && byId.room.encFps, w: byId.room && byId.room.capW }));
        check('tab: nothing is called still: the page moved on the whole viewport', data.steps.filter((s) => s.still).length === 0, data.steps.map((s) => `${s.id}:${s.capFps}`).join(' '));
        check('tab: the browser named its encoder (a real capture opens that)', !!(byId.room && byId.room.enc), byId.room && byId.room.enc);
        check('tab: it knows it was a tab', data.env.surface === 'browser' && verdict.some((l) => /aba do Chrome/.test(l)), data.env.surface);
        const errors = data.steps.filter((s) => s.error).map((s) => `${s.id}: ${s.error}`);
        console.log('   steps with an error (a capture of a tab may refuse a size):', errors.join(' | ') || 'none');
    }

    if (only.includes('game')) {
        const { data, verdict, seen } = await runPage('game', { script: realCapture(), search: '?allow=browser', clickId: 'startGame', hideBehind: true, gameTab: true, seconds: 190, tabTitle: GAME_TITLE });
        const byId = Object.fromEntries(data.steps.map((s) => [s.id, s]));
        check('game: there was a countdown to open the game', [...seen.phases].some((p) => /Abra o jogo agora/.test(p)), [...seen.phases][0]);
        check('game: the animated tab was measured while the page was hidden behind another tab', byId.room && byId.room.capFps > 10 && !byId.room.still, JSON.stringify({ cap: byId.room && byId.room.capFps, kbps: byId.room && byId.room.kbps }));
        check('game: the report says it was the way with the game', data.env.mode === 'game');
        check('game: the verdict does not call the picture still', !verdict.some((l) => /praticamente não mudou/.test(l)), verdict.slice(0, 2).join(' / ').slice(0, 160));
    }

    if (only.includes('still')) {
        const { data, verdict } = await runPage('still', { script: stub(false), clickId: 'startNow' });
        check('still: every step is marked as a picture that stood still', data.steps.length >= 3 && data.steps.every((s) => s.still), data.steps.map((s) => `${s.id}:${s.capFps}fps`).join(' '));
        check('still: the verdict says so instead of concluding anything about the capture', verdict.some((l) => /praticamente não mudou/.test(l)) && !verdict.some((l) => /É o limite|quase o mesmo número/.test(l)), verdict.join(' / ').slice(0, 220));
    }
} finally {
    assets.close();
    gameAssets.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
