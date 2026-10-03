// Smoke test of the development instance with a real room: a sharer and a viewer join the test room (token
// in the URL, no password typed), the sharer shares a canvas animation (headless Chrome has no screen), the viewer watches.
// Prints what each side measures and whether the health meter was running in the browsers.
//
//   E2E_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" \
//   E2E_ORIGIN=https://mirotalk-dev.40-160-143-32.sslip.io \
//   E2E_TOKEN=$(ssh ovh-mirotalk /home/debian/mirotalk-dev/ops/dev-test-token.sh 30) \
//   node tests/e2e/dev-room-smoke.mjs [seconds]
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
const seconds = Number(process.argv[2] || 40);
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');

const chrome = await launchChrome({ chrome: chromePath });

const pubStats = `(async () => {
    const out = [];
    for (const p of rc.producers.values()) {
        if (p.kind !== 'video' || p.closed) continue;
        (await p.getStats()).forEach((s) => { if (s.type === 'outbound-rtp') out.push({ frames: s.framesEncoded, key: s.keyFramesEncoded, pli: s.pliCount, w: s.frameWidth, h: s.frameHeight, lim: s.qualityLimitationReason, enc: s.encoderImplementation, bytes: s.bytesSent, t: s.timestamp }); });
    }
    return out;
})()`;
const viewStats = `(async () => {
    const out = [];
    for (const c of rc.consumers.values()) {
        if (c.kind !== 'video' || c.closed) continue;
        (await c.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') out.push({ frames: s.framesDecoded, key: s.keyFramesDecoded, freeze: s.freezeCount, drop: s.framesDropped, w: s.frameWidth, h: s.frameHeight, dec: s.decoderImplementation, bytes: s.bytesReceived, t: s.timestamp }); });
    }
    return out;
})()`;

try {
    console.log('browser', chrome.version);
    const pub = await chrome.newPage();
    await stubScreenCapture(pub);
    await joinTestRoom(pub, { origin, token, name: 'E2E-Pub' });
    console.log('sharer joined', await pub.ev('({ peer: rc.peer_name, room: rc.room_id, presenter: isPresenter })'));
    await startScreenShare(pub);
    console.log('sharing', await pub.ev("[...rc.producers.values()].map((p) => p.kind + ':' + (p.track && p.track.label))"));

    const view = await chrome.newPage();
    await joinTestRoom(view, { origin, token, name: 'E2E-View' });
    for (let i = 0; i < 60 && !(await view.ev("[...rc.consumers.values()].some((c) => c.kind === 'video')")); i++) await sleep(500);
    console.log('viewer consuming', await view.ev("[...rc.consumers.values()].map((c) => c.kind)"));

    // Stats appear a moment after the stream starts; wait until both sides report something.
    const read = async () => ({ pub: (await pub.ev(pubStats))[0], view: (await view.ev(viewStats))[0] });
    let first = await read();
    for (let i = 0; i < 30 && !(first.pub && first.view); i++) {
        await sleep(1000);
        first = await read();
    }
    if (!first.pub || !first.view) {
        console.log('no stats yet', JSON.stringify({ pubRaw: await pub.ev(pubStats), viewRaw: await view.ev(viewStats) }));
        console.log('producers', await pub.ev("[...rc.producers.values()].map((p) => ({ kind: p.kind, closed: p.closed, paused: p.paused }))"));
        console.log('consumers', await view.ev("[...rc.consumers.values()].map((c) => ({ kind: c.kind, closed: c.closed, paused: c.paused }))"));
        throw new Error('no video statistics');
    }
    await sleep(seconds * 1000);
    const last = await read();

    const secs = (a, b) => (b.t - a.t) / 1000;
    const sp = secs(first.pub, last.pub);
    const sv = secs(first.view, last.view);
    console.log(
        JSON.stringify(
            {
                seconds: Math.round(sp),
                sharer: {
                    fps: Math.round(((last.pub.frames - first.pub.frames) / sp) * 10) / 10,
                    mbps: Math.round(((last.pub.bytes - first.pub.bytes) * 8) / 1e5 / sp) / 10,
                    size: `${last.pub.w}x${last.pub.h}`,
                    limitedBy: last.pub.lim,
                    encoder: last.pub.enc,
                    keyFrames: last.pub.key - first.pub.key,
                    pli: last.pub.pli - first.pub.pli,
                },
                viewer: {
                    fps: Math.round(((last.view.frames - first.view.frames) / sv) * 10) / 10,
                    mbps: Math.round(((last.view.bytes - first.view.bytes) * 8) / 1e5 / sv) / 10,
                    size: `${last.view.w}x${last.view.h}`,
                    decoder: last.view.dec,
                    freezes: last.view.freeze - first.view.freeze,
                    dropped: last.view.drop - first.view.drop,
                },
            },
            null,
            1
        )
    );
    console.log('health meter in the sharer browser:', await pub.ev('JSON.stringify({ enabled: HealthMeter.state.enabled, intervalMs: HealthMeter.state.intervalMs, envSent: HealthMeter.state.envSent })'));
    await sleep(12000); // let one more report reach the server
} finally {
    chrome.close();
}
