// End-to-end: the camera next to the screen, on the development instance (needs SHOW_VIDEO_BUTTON=true there).
//
//   E2E_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" E2E_ORIGIN=https://mirotalk-dev... \
//   E2E_TOKEN=<ops/dev-test-token.sh> node tests/e2e/camera-flow.mjs
//
// Two headless people, A and B. Chrome's fake camera stands in for a webcam and a canvas for the screen. Checks:
//   - A joins with the camera off even without video=0 in the link, and the join dialog never opens the camera;
//   - camera and screen at the same time are two tiles for B;
//   - turning the camera off while the screen is shared leaves no "camera off" card next to the screen;
//   - changing the camera quality in the settings with the camera off keeps it off; with it on, it restarts it;
//   - with nothing on, B sees A's "camera off" card again.
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const chrome = process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const origin = process.env.E2E_ORIGIN || 'https://mirotalk-dev.40-160-143-32.sslip.io';
const token = process.env.E2E_TOKEN;
if (!token) throw new Error('E2E_TOKEN is missing (ops/dev-test-token.sh on the server)');

let failures = 0;
const check = (label, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
};
const waitUntil = async (page, expression, seconds = 15) => {
    for (let i = 0; i < seconds * 4; i++) {
        if (await page.ev(expression).catch(() => false)) return true;
        await sleep(250);
    }
    return false;
};

// Every video track the page opens with getUserMedia, to know whether the camera is open right now
function trackCameraTracks() {
    window.__cameraTracks = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await original(constraints);
        window.__cameraTracks.push(...stream.getVideoTracks());
        return stream;
    };
}
const liveCameraTracks = "window.__cameraTracks.filter((t) => t.readyState === 'live').length";

const browser = await launchChrome({ chrome, extraFlags: ['--use-fake-device-for-media-stream'], width: 1600, height: 900 });
try {
    const a = await browser.newPage();
    const b = await browser.newPage();
    await stubScreenCapture(a, { width: 1280, height: 720, fps: 30 });
    await a.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${trackCameraTracks.toString()})()` });

    // ---- A: the join dialog, from a link that does not say video=0 ----
    await a.send('Page.navigate', {
        url: `${origin}/join/?room=teste&roomPassword=${encodeURIComponent(token)}&name=A&audio=0&notify=0`,
    });
    await waitUntil(a, "!!document.querySelector('.swal2-popup.init-modal-size .swal2-confirm')", 30);
    await sleep(2500); // the device listing and the selects run while the dialog opens
    const dialog = await a.ev(`({
        allowed: isVideoAllowed,
        button: document.getElementById('initVideoButton').className,
        buttonShown: getComputedStyle(document.getElementById('initVideoButton')).display !== 'none',
        live: ${liveCameraTracks},
        devices: document.getElementById('videoSelect').options.length,
    })`);
    check('dialog: camera starts off', dialog.allowed === false && dialog.button.includes('fa-video-slash'), JSON.stringify(dialog));
    check('dialog: the camera button is there to turn it on', dialog.buttonShown && dialog.devices > 0);
    check('dialog: the camera is not open', dialog.live === 0);

    await joinTestRoom(a, { origin, token, name: 'A' }); // the dialog is open: it types the name and joins
    await joinTestRoom(b, { origin, token, name: 'B' });
    const peerA = await a.ev('rc.peer_id');
    const tilesOfA = `(() => {
        const tiles = [...document.querySelectorAll('.Camera[data-peer-id="${peerA}"]')];
        return {
            camera: tiles.filter((t) => t.querySelector('video[name]')).length,
            screen: tiles.filter((t) => t.querySelector('video') && !t.querySelector('video[name]')).length,
            off: tiles.filter((t) => t.dataset.cameraOff === 'true').length,
        };
    })()`;
    const hasCamera = "rc.producerLabel.has('videoType')";

    check('room: A has no camera producer', !(await a.ev(hasCamera)));
    check('room: A camera is closed', (await a.ev(liveCameraTracks)) === 0);
    check('room: the start camera button is shown', await a.ev("!document.getElementById('startVideoButton').classList.contains('hidden')"));
    check('B sees the camera off card of A', await waitUntil(b, `${tilesOfA}.off === 1`), JSON.stringify(await b.ev(tilesOfA)));

    // ---- screen, then camera ----
    await startScreenShare(a);
    check('B sees the screen of A and no card', await waitUntil(b, `(() => { const t = ${tilesOfA}; return t.screen === 1 && t.off === 0; })()`), JSON.stringify(await b.ev(tilesOfA)));

    await a.ev("document.getElementById('startVideoButton').click()");
    check('A: camera producer while sharing', await waitUntil(a, hasCamera));
    const settings = await a.ev("(() => { const p = rc.producers.get(rc.producerLabel.get('videoType')); const s = p.track.getSettings(); return { w: s.width, h: s.height, fps: s.frameRate, layers: p.rtpSender.getParameters().encodings.length }; })()");
    console.log('     camera sent:', JSON.stringify(settings));
    check('B sees two tiles of A: camera and screen', await waitUntil(b, `(() => { const t = ${tilesOfA}; return t.camera === 1 && t.screen === 1 && t.off === 0; })()`), JSON.stringify(await b.ev(tilesOfA)));

    // ---- camera quality in the settings while the camera is on: it restarts with the new choice ----
    const before = await a.ev("rc.producerLabel.get('videoType')");
    await a.ev("(() => { const s = document.getElementById('videoQuality'); s.value = 'hd'; s.onchange(); })()");
    const restarted = await waitUntil(a, `rc.producerLabel.has('videoType') && rc.producerLabel.get('videoType') !== ${JSON.stringify(before)}`, 10);
    check('settings: quality change restarts the camera', restarted, JSON.stringify(await a.ev("(() => { const id = rc.producerLabel.get('videoType'); const p = id && rc.producers.get(id); return p ? p.track.getSettings().height : null; })()")));
    await waitUntil(b, `${tilesOfA}.camera === 1`, 10);

    // ---- camera off while the screen is shared ----
    await a.ev("document.getElementById('stopVideoButton').click()");
    check('A: camera producer closed', await waitUntil(a, `!${hasCamera}`));
    await sleep(2500);
    check('A: the camera is really closed', (await a.ev(liveCameraTracks)) === 0);
    check('A: no camera off card next to the own screen', (await a.ev(`!document.getElementById('${peerA}__videoOff')`)) === true);
    const afterOff = await b.ev(tilesOfA);
    check('B: only the screen of A is left, no camera off card', afterOff.camera === 0 && afterOff.screen === 1 && afterOff.off === 0, JSON.stringify(afterOff));

    // ---- quality and frame rate changed with the camera off: it stays off ----
    await a.ev("(() => { const s = document.getElementById('videoQuality'); s.value = 'fhd'; s.onchange(); const f = document.getElementById('videoFps'); f.value = '30'; f.onchange(); })()");
    await sleep(3000);
    check('settings: with the camera off a quality change keeps it off', !(await a.ev(hasCamera)) && (await a.ev(liveCameraTracks)) === 0);

    // ---- screen off with the camera off: the card comes back ----
    await a.ev("rc.closeProducer('screenType')");
    check('B sees the camera off card of A again', await waitUntil(b, `(() => { const t = ${tilesOfA}; return t.off === 1 && t.screen === 0 && t.camera === 0; })()`), JSON.stringify(await b.ev(tilesOfA)));

    // ---- camera alone, then off ----
    await a.ev("document.getElementById('startVideoButton').click()");
    check('B sees the camera of A alone', await waitUntil(b, `(() => { const t = ${tilesOfA}; return t.camera === 1 && t.off === 0; })()`), JSON.stringify(await b.ev(tilesOfA)));
    await a.ev("document.getElementById('stopVideoButton').click()");
    check('B sees the card after the camera alone is turned off', await waitUntil(b, `(() => { const t = ${tilesOfA}; return t.off === 1 && t.camera === 0; })()`), JSON.stringify(await b.ev(tilesOfA)));

    const errors = await a.ev("(window.__errors || []).length").catch(() => 0);
    if (errors) console.log('     page errors:', errors);
} finally {
    browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
