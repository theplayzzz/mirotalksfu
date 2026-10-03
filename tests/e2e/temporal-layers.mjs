// A screen sent in ONE size but in 3 frame-rate layers (VP8 L1T3): can the server cut a viewer down to half or a
// quarter of the frames without any change on the sender? A sharer sends a 1080p60 animation, a viewer asks the
// server for temporal layer 2, 1 and 0 and the test measures what it really receives after each request.
//
//   needs the dev instance with SCREEN_SIMULCAST_LAYERS=1
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 20) node tests/e2e/temporal-layers.mjs
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');

const chrome = await launchChrome({ chrome: chromePath });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

const stats = `(async () => {
    for (const c of rc.consumers.values()) {
        if (c.kind !== 'video' || c.closed) continue;
        for (const s of (await c.getStats()).values()) {
            if (s.type === 'inbound-rtp' && s.kind === 'video') return { t: s.timestamp, bytes: s.bytesReceived, frames: s.framesDecoded, w: s.frameWidth };
        }
    }
    return null;
})()`;

async function measure(page, seconds) {
    const a = await page.ev(stats);
    await sleep(seconds * 1000);
    const b = await page.ev(stats);
    if (!a || !b) return { mbps: 0, fps: 0, width: 0 };
    const dt = (b.t - a.t) / 1000;
    return { mbps: Math.round(((b.bytes - a.bytes) * 8) / 1e5 / dt) / 10, fps: Math.round((b.frames - a.frames) / dt), width: b.w };
}

try {
    const sharer = await chrome.newPage();
    await stubScreenCapture(sharer);
    await joinTestRoom(sharer, { origin, token, name: 'TL-Sharer' });
    await startScreenShare(sharer);
    const config = await sharer.ev("fetch('/config').then((r) => r.json())");
    console.log('server screen settings', JSON.stringify(config.screen));
    const mode = await sharer.ev("[...rc.producers.values()].filter((p) => p.kind === 'video').map((p) => p.rtpParameters.encodings.map((e) => e.scalabilityMode || '-').join(','))");
    console.log('what the sharer sends (scalability mode per encoding):', JSON.stringify(mode));

    const viewer = await chrome.newPage();
    await joinTestRoom(viewer, { origin, token, name: 'TL-Viewer' });
    for (let i = 0; i < 60 && !(await viewer.ev("[...rc.consumers.values()].some((c) => c.kind === 'video')")); i++) await sleep(500);
    await sleep(8000);

    const ask = (temporalLayer) =>
        viewer.ev(`(async () => {
            const consumer = [...rc.consumers.values()].find((c) => c.kind === 'video' && !c.closed);
            return rc.socket.request('setConsumerPreferences', { consumer_id: consumer.id, spatialLayer: 0, temporalLayer: ${temporalLayer} });
        })()`);

    const full = await measure(viewer, 8);
    console.log('everything (default):', JSON.stringify(full));
    check('the viewer receives the screen', full.fps > 20 && full.mbps > 1, JSON.stringify(full));

    const results = { 2: full };
    for (const layer of [1, 0]) {
        const answer = await ask(layer);
        console.log(`asked for temporal layer ${layer}:`, JSON.stringify(answer));
        check(`the server accepts temporal layer ${layer}`, answer && answer.ok === true && answer.temporalLayer === layer, JSON.stringify(answer));
        await sleep(3000);
        results[layer] = await measure(viewer, 8);
        console.log(`temporal layer ${layer}:`, JSON.stringify(results[layer]));
    }
    check('layer 1 has clearly fewer frames than the full stream', results[1].fps < full.fps * 0.8, `${results[1].fps} vs ${full.fps} fps`);
    check('layer 0 has fewer frames than layer 1', results[0].fps < results[1].fps * 0.8, `${results[0].fps} vs ${results[1].fps} fps`);
    check('layer 0 uses far less bandwidth than the full stream', results[0].mbps < full.mbps * 0.6, `${results[0].mbps} vs ${full.mbps} Mbps`);

    const back = await ask(2);
    await sleep(3000);
    const again = await measure(viewer, 6);
    console.log('back to the full stream:', JSON.stringify(back), JSON.stringify(again));
    check('asking for layer 2 brings the full stream back', again.fps > results[0].fps * 1.5, JSON.stringify(again));
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
