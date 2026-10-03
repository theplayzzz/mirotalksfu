// Selective reception, end to end: a sharer sends its screen (the dev instance sends it in 3 sizes), a viewer
// resizes its window, hides the tile and hides the page, and the test checks what the browser asked the server for
// (setConsumerPreferences) and how much video it really received after each change.
//
//   needs the dev instance with SCREEN_SIMULCAST_LAYERS=3 and SELECTIVE_RECEPTION=true
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 20) node tests/e2e/selective-reception.mjs
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');

const chrome = await launchChrome({ chrome: chromePath });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

// Installed before the app runs: records every preference the browser sends and every layer the server reports.
const instrument = `(() => {
    window.__prefs = []; window.__layers = [];
    const timer = setInterval(() => {
        try {
            if (typeof rc === 'undefined' || !rc || !rc.socket || !rc.socket.request || rc.socket.__instrumented) return;
            const socket = rc.socket;
            socket.__instrumented = true;
            const original = socket.request.bind(socket);
            socket.request = (type, data, ...rest) => {
                const promise = original(type, data, ...rest);
                if (type === 'setConsumerPreferences') promise.then((r) => window.__prefs.push({ t: performance.now(), data: { ...data }, answer: r })).catch(() => {});
                return promise;
            };
            socket.on('consumerLayers', (d) => window.__layers.push({ t: performance.now(), ...d }));
            clearInterval(timer);
        } catch (e) {}
    }, 30);
})();`;

const stats = `(async () => {
    for (const c of rc.consumers.values()) {
        if (c.kind !== 'video' || c.closed) continue;
        for (const s of (await c.getStats()).values()) {
            if (s.type === 'inbound-rtp' && s.kind === 'video') return { t: s.timestamp, bytes: s.bytesReceived, frames: s.framesDecoded, w: s.frameWidth };
        }
    }
    return null;
})()`;

async function window_(page, width, height) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

// Mbps and frames per second received over `seconds`
async function measure(page, seconds) {
    const a = await page.ev(stats);
    await sleep(seconds * 1000);
    const b = await page.ev(stats);
    if (!a || !b) return { mbps: 0, fps: 0, width: 0 };
    const dt = (b.t - a.t) / 1000;
    return { mbps: Math.round(((b.bytes - a.bytes) * 8) / 1e5 / dt) / 10, fps: Math.round((b.frames - a.frames) / dt), width: b.w };
}

// Waits for a preference request that satisfies `test`, sent after `since` (page time)
async function waitForPreference(page, since, test, seconds) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
        const prefs = await page.ev('window.__prefs');
        const found = prefs.find((p) => p.t > since && p.answer && p.answer.ok && test(p.data));
        if (found) return found;
        await sleep(150);
    }
    return null;
}
const now = (page) => page.ev('performance.now()');

// The room shows one tile per person plus the screen, so an unpinned screen is only a part of the window. A pinned
// screen takes the window, which is what a person watching a game does.
async function pinScreen(page) {
    return page.ev(`(() => {
        const video = [...document.querySelectorAll('video')].find((v) => v.id && !v.hasAttribute('name') && rc.consumers.has(v.id));
        const button = video && document.getElementById(video.id + '__pin');
        if (!button) return false;
        if (rc.pinnedVideoPlayerId !== video.id) button.click();
        return true;
    })()`);
}

try {
    const sharer = await chrome.newPage();
    await stubScreenCapture(sharer);
    await joinTestRoom(sharer, { origin, token, name: 'SR-Sharer' });
    await startScreenShare(sharer);
    const config = await sharer.ev("fetch('/config').then((r) => r.json())");
    console.log('server screen settings', JSON.stringify(config.screen));
    check('the server sends the screen in 3 layers and has selective reception on', config.screen.layers === 3 && config.screen.selectiveReception === true);

    const viewer = await chrome.newPage();
    await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: instrument });
    await window_(viewer, 1920, 1080);
    await joinTestRoom(viewer, { origin, token, name: 'SR-Viewer' });
    for (let i = 0; i < 60 && !(await viewer.ev("[...rc.consumers.values()].some((c) => c.kind === 'video')")); i++) await sleep(500);
    await sleep(5000);
    check('the viewer can pin the screen', await pinScreen(viewer));
    await sleep(5000);

    // a. a big (pinned) tile gets the top layer
    let phase = await measure(viewer, 6);
    const prefsBig = await viewer.ev('window.__prefs');
    console.log('big tile (1920x1080):', JSON.stringify(phase), 'requests so far:', JSON.stringify(prefsBig.map((p) => p.data)));
    check('a big tile asks for the top layer', prefsBig.some((p) => p.data.spatialLayer === 2), JSON.stringify(prefsBig.map((p) => p.data.spatialLayer)));
    check('a big tile keeps receiving video', phase.fps > 15, JSON.stringify(phase));
    check('a big tile is not paused', !prefsBig.some((p) => p.data.paused === true));
    const bigMbps = phase.mbps;

    // b. a small window asks for the smallest layer
    let since = await now(viewer);
    await window_(viewer, 480, 270);
    let asked = await waitForPreference(viewer, since, (d) => d.spatialLayer === 0, 6);
    check('a small tile (480 px) asks for the smallest layer', !!asked, asked ? `after ${Math.round(((await now(viewer)) - since) / 100) / 10} s at most` : 'no request');
    await sleep(4000);
    phase = await measure(viewer, 6);
    console.log('small tile (480x270):', JSON.stringify(phase), '| big was', bigMbps, 'Mbps');
    check('the smallest layer uses far less bandwidth than the big tile', phase.mbps < Math.max(2, bigMbps * 0.5), `${phase.mbps} vs ${bigMbps} Mbps`);

    // c. a medium window asks for the middle layer
    since = await now(viewer);
    await window_(viewer, 960, 540);
    asked = await waitForPreference(viewer, since, (d) => d.spatialLayer === 1, 6);
    check('a medium tile (960 px) asks for the middle layer', !!asked);

    // d. back to a big window asks for the top layer
    since = await now(viewer);
    await window_(viewer, 1920, 1080);
    asked = await waitForPreference(viewer, since, (d) => d.spatialLayer === 2, 6);
    check('a big tile asks for the top layer again', !!asked);
    await sleep(4000);

    // e. a hidden tile pauses the video
    since = await now(viewer);
    await viewer.ev("(() => { const v = [...document.querySelectorAll('video')].find((v) => v.id && !v.hasAttribute('name') && rc.consumers.has(v.id)); v.closest('.Camera').style.display = 'none'; return true; })()");
    asked = await waitForPreference(viewer, since, (d) => d.paused === true, 6);
    check('a hidden tile is paused', !!asked);
    await sleep(2500);
    phase = await measure(viewer, 4);
    console.log('hidden tile:', JSON.stringify(phase));
    check('a paused screen receives (almost) nothing', phase.mbps < 0.3, `${phase.mbps} Mbps`);

    since = await now(viewer);
    await viewer.ev("(() => { const v = [...document.querySelectorAll('video')].find((v) => v.id && !v.hasAttribute('name') && rc.consumers.has(v.id)); v.closest('.Camera').style.display = ''; return true; })()");
    asked = await waitForPreference(viewer, since, (d) => d.paused === false, 3);
    check('a tile that shows again is resumed at once', !!asked);
    await sleep(3000);
    phase = await measure(viewer, 4);
    check('the video flows again after resuming', phase.fps > 15 && phase.mbps > 0.5, JSON.stringify(phase));

    // f. a hidden page pauses everything
    since = await now(viewer);
    await viewer.ev("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); true");
    asked = await waitForPreference(viewer, since, (d) => d.paused === true, 8);
    check('a hidden page pauses the video (after about 3 s)', !!asked);
    since = await now(viewer);
    await viewer.ev("delete document.visibilityState; true");
    asked = await waitForPreference(viewer, since, (d) => d.paused === false, 3);
    check('a page that shows again resumes the video', !!asked);

    const layers = await viewer.ev('window.__layers');
    console.log('layer changes reported by the server:', JSON.stringify(layers.map((l) => l.spatialLayer)));
    check('the server reports the layer changes', layers.length > 0);

    // g. a viewer with a small window (a phone) gets a small layer
    const small = await chrome.newPage();
    await small.send('Page.addScriptToEvaluateOnNewDocument', { source: instrument });
    await window_(small, 480, 900);
    await joinTestRoom(small, { origin, token, name: 'SR-Small' });
    await sleep(3000);
    await pinScreen(small);
    for (let i = 0; i < 60 && !(await small.ev("[...rc.consumers.values()].some((c) => c.kind === 'video')")); i++) await sleep(500);
    await sleep(8000);
    phase = await measure(small, 6);
    const smallPrefs = await small.ev('window.__prefs');
    console.log('joined with a small window:', JSON.stringify(phase), 'requests:', JSON.stringify(smallPrefs.map((p) => p.data)));
    check('a viewer with a small window receives a small layer', phase.mbps < Math.max(2, bigMbps * 0.5) && phase.fps > 15, `${phase.mbps} vs ${bigMbps} Mbps`);
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
