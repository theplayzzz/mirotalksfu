// What a viewer gets of a screen, by the policy of the room (SELECTIVE_MODE) and by the frame rate of the SENDER: the
// two things that made "some saw it perfect and others stuttering" on 03/10/2026. A real Chrome sends an animated screen at
// 60 fps and then at 20 fps (a loaded PC), a viewer with a small window (a thumbnail) receives it, and the test measures
// the frame rate that really arrives and what the browser asked of the server.
//
//   adaptive (the default): the viewer asks for nothing and gets every frame, whatever the size of its tile
//   tile: the layer follows the tile but never takes a screen below 24 fps, and a 20 fps sender is left alone
//
// And that the diagnosis exists: the server's health file has the build, the pages' build, the capture figures of the
// sender and the server's own records of the streams (needs SSH_HOST and the health directory of the instance).
//
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 20) node tests/e2e/screen-policy.mjs
//   LOW=1                the browsers run at a low priority (somebody is using this PC)
//   SSH_HOST=ovh-mirotalk HEALTH_DIR=/home/debian/mirotalk-dev/data/health     also check the diagnosis records
import { execFileSync } from 'node:child_process';
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');

const chrome = await launchChrome({ chrome: chromePath, lowPriority: process.env.LOW === '1' });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

// Every request the browser makes about the layers of a screen, and every layer the server reports
const instrument = `(() => {
    window.__prefs = [];
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
            clearInterval(timer);
        } catch (e) {}
    }, 30);
})();`;

const stats = `(async () => {
    for (const c of rc.consumers.values()) {
        if (c.kind !== 'video' || c.closed) continue;
        for (const s of (await c.getStats()).values()) {
            if (s.type === 'inbound-rtp' && s.kind === 'video') return { t: s.timestamp, frames: s.framesDecoded, dropped: s.framesDropped || 0, bytes: s.bytesReceived };
        }
    }
    return null;
})()`;

async function measure(page, seconds) {
    const a = await page.ev(stats);
    await sleep(seconds * 1000);
    const b = await page.ev(stats);
    if (!a || !b) return { fps: 0, mbps: 0 };
    const dt = (b.t - a.t) / 1000;
    return { fps: Math.round(((b.frames - a.frames) / dt) * 10) / 10, mbps: Math.round(((b.bytes - a.bytes) * 8) / 1e5 / dt) / 10 };
}

async function shareAt(fps, name) {
    const sharer = await chrome.newPage();
    await stubScreenCapture(sharer, { fps });
    await joinTestRoom(sharer, { origin, token, name });
    await startScreenShare(sharer);
    return sharer;
}

try {
    const probe = await chrome.newPage();
    await probe.send('Page.navigate', { url: `${origin}/` });
    // DIAG_ONLY=1: do not share anything, only check the records of an earlier run (the diagnosis part)
    const DIAG_ONLY = process.env.DIAG_ONLY === '1';
    await sleep(1500);
    const config = await probe.ev("fetch('/config').then((r) => r.json())");
    const mode = config.screen.selectiveMode || (config.screen.selectiveReception ? 'tile' : 'off');
    console.log('server screen settings', JSON.stringify(config.screen), 'build', config.build);
    check('the server has selective reception on', config.screen.selectiveReception === true, mode);
    check('the server says which build it is', typeof config.build === 'string' && config.build.length >= 7 && config.build !== 'dev-local' || process.env.ALLOW_LOCAL_BUILD === '1', String(config.build));
    await probe.close();

    // the viewer, with a window the size of a thumbnail
    const viewer = await chrome.newPage();
    await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: instrument });
    await viewer.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await joinTestRoom(viewer, { origin, token, name: 'SP-Viewer' });
    // then the window shrinks to the size of a thumbnail: the tile of the screen is under 450 px wide
    await viewer.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 270, deviceScaleFactor: 1, mobile: false });

    for (const rate of DIAG_ONLY ? [] : [60, 20]) {
        const sharer = await shareAt(rate, `SP-Sharer-${rate}`);
        for (let i = 0; i < 80 && !(await viewer.ev("[...rc.consumers.values()].some((c) => c.kind === 'video' && !c.closed)")); i++) await sleep(500);
        await sleep(14000); // the sender ramps up, and the viewer's own estimate of the sender's rate settles
        await viewer.ev('window.__prefs.length = 0; true');
        const phase = await measure(viewer, 10);
        const asked = await viewer.ev('window.__prefs.filter((p) => p.data.temporalLayer !== undefined).map((p) => p.data.temporalLayer)');
        console.log(`a ${rate} fps sender, a thumbnail-size window (${mode} mode):`, JSON.stringify(phase), 'layers asked:', JSON.stringify(asked));

        if (rate === 60) {
            if (mode === 'adaptive') {
                check('a 60 fps screen in a thumbnail gets every frame: nothing is asked of the server', asked.length === 0 && phase.fps >= 50, JSON.stringify({ asked, fps: phase.fps }));
            } else {
                // never below 24 fps for a 60 fps sender (the lowest layer is 15)
                check('a 60 fps screen in a thumbnail keeps at least 24 fps (tile mode floor)', phase.fps >= 24, `${phase.fps} fps`);
                check('and never asks for the lowest layer', !asked.includes(0), JSON.stringify(asked));
            }
        } else {
            // the case that was bad: a loaded PC sends 20 fps; the old rule gave the thumbnail a quarter of it
            check('a 20 fps screen in a thumbnail still arrives at about 20 fps (it used to be 5)', phase.fps >= 15, `${phase.fps} fps`);
            check('and no layer below the best was asked for it', !asked.some((layer) => layer < 2), JSON.stringify(asked));
        }
        await sharer.close();
        await sleep(4000);
    }

    // ---- the diagnosis exists in the server's health file
    if (process.env.SSH_HOST && process.env.HEALTH_DIR) {
        if (!DIAG_ONLY) await sleep(15000);
        const day = new Date().toISOString().slice(0, 10);
        const text = execFileSync('ssh', ['-o', 'BatchMode=yes', process.env.SSH_HOST, `tail -n 400 ${process.env.HEALTH_DIR}/health-${day}.jsonl`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        const records = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const mine = records.filter((r) => /^SP-/.test(r.peer || ''));
        const tx = mine.flatMap((r) => r.tx || []);
        const rx = mine.flatMap((r) => r.rx || []);
        const srv = records.filter((r) => r.kind === 'srv');
        // (records of the run before this build have no stamp: only look at what came after the first line of this run)
        const fresh = records.filter((r) => mine.length && r.ts >= mine[0].ts);
        check('every record of this run carries the build of the server', fresh.length > 0 && fresh.every((r) => typeof r.bld === 'string'), fresh[0] && fresh[0].bld);
        check('the browsers report the build of their page and whether it is visible', mine.length > 0 && mine.every((r) => typeof r.cb === 'string' && typeof r.vis === 'boolean'), JSON.stringify(mine[0] && { cb: mine[0].cb, vis: mine[0].vis }));
        check('a sender reports its capture (frames per second and size of the source) and what its encoder was told', tx.length > 0 && tx.some((t) => t.srcFps > 0 && t.srcW > 0 && t.hint && t.codec), JSON.stringify(tx[tx.length - 1]));
        check('a viewer reports how long its decoder takes and the layer it asked for and why', rx.length > 0 && rx.some((r) => typeof r.decMs === 'number'), JSON.stringify(rx[rx.length - 1]));
        check('the server writes its own view of the streams: workers, producers with a score, consumers with a layer', srv.length > 0 && srv.some((r) => (r.workers || []).length && (r.producers || []).some((p) => p.score >= 0) && (r.consumers || []).some((c) => c.lay)), JSON.stringify(srv[srv.length - 1] || {}).slice(0, 300));
        const epochs = records.filter((r) => r.kind === 'epoch');
        console.log('epoch lines in the last 400 records:', epochs.length, epochs[0] ? JSON.stringify(epochs[0]) : '(start of the server not in this tail)');
    } else {
        console.log('(SSH_HOST and HEALTH_DIR not set: the diagnosis records were not checked)');
    }
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
