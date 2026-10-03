// Selective reception, end to end: a sharer sends its screen, a viewer resizes its window, hides the tile and hides
// the page, and the test checks what the browser asked the server for (setConsumerPreferences) and how much video it
// really received after each change. A screen sent in one size (SCREEN_SIMULCAST_LAYERS=1, the default) is reduced
// by its frame-rate layers (60, 30 and 15 fps); one sent in 3 sizes (SCREEN_SIMULCAST_LAYERS=3) by size. Hiding a
// tile or the page pauses nothing (people did not want screens stopped when they come back to a window), and the
// server ignores a request to pause too (SELECTIVE_PAUSE_HIDDEN is off), also from a tab with the old code.
//
//   needs the dev instance with SELECTIVE_RECEPTION=true
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
    check('the server has selective reception on', config.screen.selectiveReception === true);
    // This test is about the 'tile' mode (the layer follows the size of the tile). The default is 'adaptive': see screen-policy.mjs
    if (config.screen.selectiveMode === 'adaptive') {
        console.log('this instance runs SELECTIVE_MODE=adaptive: nothing follows the size of a tile. Run screen-policy.mjs, or set SELECTIVE_MODE=tile.');
        chrome.close();
        process.exit(failures ? 1 : 0);
    }
    // What the browser asks for as the tile shrinks: the spatial layer (sizes) or the temporal one (frame rates)
    const spatial = config.screen.layers > 1;
    const levelOf = (data) => (spatial ? data.spatialLayer : data.temporalLayer);
    const mediumWidth = spatial ? 960 : 700; // medium: half the screen with sizes, 450-720 px on the screen with frame rates
    console.log(spatial ? 'the screen is sent in 3 sizes' : 'the screen is sent in one size with 3 frame rates');

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
    check('a big tile gets the top layer', !prefsBig.length || prefsBig.some((p) => levelOf(p.data) === 2) || phase.fps > 40, JSON.stringify(prefsBig.map((p) => levelOf(p.data))));
    check('a big tile keeps receiving video', phase.fps > 15, JSON.stringify(phase));
    check('a big tile is not paused', !prefsBig.some((p) => p.data.paused === true));
    const bigMbps = phase.mbps;

    // b. a small window asks for the smallest layer
    let since = await now(viewer);
    await window_(viewer, 480, 270);
    // a 60 fps sender: the lowest layer would be 15 fps, below the floor of 24, so the smallest tile gets 30 fps (layer 1)
    const smallest = spatial ? 0 : 1;
    let asked = await waitForPreference(viewer, since, (d) => levelOf(d) === smallest, 8);
    check(`a small tile (480 px) asks for ${spatial ? 'the smallest size' : 'the lowest layer that keeps 24 fps'}`, !!asked, asked ? `after ${Math.round(((await now(viewer)) - since) / 100) / 10} s at most` : 'no request');
    await sleep(4000);
    phase = await measure(viewer, 6);
    console.log('small tile (480x270):', JSON.stringify(phase), '| big was', bigMbps, 'Mbps');
    // sizes: a quarter of the picture is about 5% of the bits; frame rates: 15 of 60 fps is about 40%
    const lightFactor = spatial ? 0.5 : 0.8; // frame rates: 30 of 60 fps is about 60% of the bits
    check('the smallest layer uses far less bandwidth than the big tile', phase.mbps < Math.max(2, bigMbps * lightFactor), `${phase.mbps} vs ${bigMbps} Mbps`);

    // c. a medium window asks for the middle layer
    since = await now(viewer);
    await window_(viewer, mediumWidth, Math.round((mediumWidth * 9) / 16));
    asked = await waitForPreference(viewer, since, (d) => levelOf(d) === 1, 6);
    check(`a medium tile (${mediumWidth} px) asks for the middle layer`, !!asked);

    // d. back to a big window asks for the top layer
    since = await now(viewer);
    await window_(viewer, 1920, 1080);
    asked = await waitForPreference(viewer, since, (d) => levelOf(d) === 2, 6);
    check('a big tile asks for the top layer again', !!asked);
    await sleep(4000);

    // e. a hidden tile and a hidden page do NOT pause anything: the people of the room did not want screens stopped when
    // they leave a window (a paused video needs a new full picture from the sender to start again, 1-10 s)
    const stillFlowing = (what) => async () => {
        const result = await measure(viewer, 4);
        console.log(`${what}:`, JSON.stringify(result));
        return result;
    };
    since = await now(viewer);
    await viewer.ev("(() => { const v = [...document.querySelectorAll('video')].find((v) => v.id && !v.hasAttribute('name') && rc.consumers.has(v.id)); v.style.display = 'none'; return true; })()");
    await sleep(6000); // well past the 1.5 s the first version waited before pausing
    check('a hidden tile asks for no pause', !(await viewer.ev('window.__prefs')).some((p) => p.t > since && p.data.paused === true));
    phase = await stillFlowing('hidden tile')();
    check('and the screen keeps arriving, at the same frame rate as before', phase.fps > 15 && phase.mbps > 0.5, JSON.stringify(phase));

    since = await now(viewer);
    await viewer.ev("(() => { const v = [...document.querySelectorAll('video')].find((v) => v.id && !v.hasAttribute('name') && rc.consumers.has(v.id)); v.style.display = ''; return true; })()");
    await sleep(1500);
    phase = await measure(viewer, 3);
    check('a tile that shows again is already playing: no wait for a new picture', phase.fps > 15 && phase.mbps > 0.5, JSON.stringify(phase));

    // f. a hidden page (another tab, a window behind a game, a minimized window) pauses nothing either
    since = await now(viewer);
    await viewer.ev("Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); true");
    await sleep(8000); // well past the 3 s the first version waited before pausing
    check('a hidden page asks for no pause', !(await viewer.ev('window.__prefs')).some((p) => p.t > since && p.data.paused === true));
    phase = await stillFlowing('hidden page')();
    check('and the screens keep arriving', phase.fps > 15 && phase.mbps > 0.5, JSON.stringify(phase));
    await viewer.ev("delete document.visibilityState; true");
    await sleep(1000);
    phase = await measure(viewer, 3);
    check('coming back to the page finds the screen moving', phase.fps > 15 && phase.mbps > 0.5, JSON.stringify(phase));

    // the server refuses to pause even when an old page asks (the tabs of people who have not reloaded yet)
    const oldPage = await viewer.ev(`(async () => {
        const consumer = [...rc.consumers.values()].find((c) => c.kind === 'video' && !c.closed);
        const answer = await rc.socket.request('setConsumerPreferences', { consumer_id: consumer.id, paused: true });
        return { answer, paused: consumer.paused };
    })()`);
    check('a request to pause, from a page that still has the old code, is answered but not applied', oldPage.answer && oldPage.answer.ok === true && oldPage.answer.paused === false, JSON.stringify(oldPage));
    await sleep(2000);
    phase = await measure(viewer, 3);
    check('and the video goes on', phase.fps > 15 && phase.mbps > 0.5, JSON.stringify(phase));

    const layers = await viewer.ev('window.__layers');
    console.log('layer changes reported by the server:', JSON.stringify(layers.map((l) => (spatial ? l.spatialLayer : l.temporalLayer))));
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
    check('a viewer with a small window receives a small layer', phase.mbps < Math.max(2, bigMbps * lightFactor) && phase.fps >= 12, `${phase.mbps} vs ${bigMbps} Mbps`);
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
