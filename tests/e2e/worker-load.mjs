// What does the room cost the server with many viewers, and how much does selective reception save?
// A real sharer sends a screen (in 3 layers); the development instance then makes virtual viewers (DevLoad.js)
// that consume it several times, with SRTP, and measures the CPU of the mediasoup worker (one core: when it
// saturates, everybody stutters) and the traffic. Scenarios, for 10 viewers each seeing 4 screens:
//   today          every screen of every viewer in full size (what production does now)
//   one big        one screen in full size and three small (a pinned screen and three tiles)
//   grid           four medium tiles (a 2x2 grid)
// The same screen is repeated for the four, which costs the server exactly what four different ones do.
//
//   needs APP_ENV=dev, DEV_LOAD_ENABLED=true and SCREEN_SIMULCAST_LAYERS=3 on the instance
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 20) node tests/e2e/worker-load.mjs [viewers] [seconds]
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
const viewers = Number(process.argv[2] || 10);
const seconds = Number(process.argv[3] || 25);

const chrome = await launchChrome({ chrome: chromePath });

async function load(body) {
    const response = await fetch(`${origin}/dev/load`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(`load failed: ${JSON.stringify(json)}`);
    return json;
}

try {
    const sharer = await chrome.newPage();
    await stubScreenCapture(sharer);
    await joinTestRoom(sharer, { origin, token, name: 'WL-Sharer' });
    await startScreenShare(sharer);
    await sleep(10000); // let the sender settle its layers and bitrate

    const sharerStats = await sharer.ev(`(async () => {
        const out = [];
        for (const p of rc.producers.values()) {
            if (p.kind !== 'video' || p.closed) continue;
            for (const s of (await p.getStats()).values()) if (s.type === 'outbound-rtp') out.push({ rid: s.rid, w: s.frameWidth, fps: s.framesPerSecond, kbps: Math.round((s.targetBitrate || 0) / 1000), enc: s.encoderImplementation });
        }
        return out;
    })()`);
    console.log('what the sharer sends (one entry per layer):', JSON.stringify(sharerStats));

    const scenarios = [
        { name: 'idle (no virtual viewers)', body: { viewers: 1, screens: 1, layers: [], seconds: 10 }, tiny: true },
        { name: 'today: 4 screens in full size', body: { viewers, screens: 4, layers: [2, 2, 2, 2], seconds } },
        { name: 'one big, three small', body: { viewers, screens: 4, layers: [2, 0, 0, 0], seconds } },
        { name: 'grid of four medium tiles', body: { viewers, screens: 4, layers: [1, 1, 1, 1], seconds } },
    ];
    const results = [];
    for (const scenario of scenarios) {
        const r = await load(scenario.body);
        results.push({ name: scenario.name, ...r });
        console.log(
            `${scenario.name.padEnd(34)} ${String(r.consumers).padStart(3)} consumers  worker CPU ${String(r.workerCpuPercent).padStart(5)}%  ` +
                `out ${String(r.sentMbps).padStart(6)} Mbps (${r.sentMbpsPerViewer} per viewer)  layers now ${JSON.stringify(r.currentLayers)}`
        );
        await sleep(3000);
    }
    const today = results[1];
    const selective = results[2];
    if (today && selective) {
        console.log(
            `\nselective reception (one big, three small) vs today: worker CPU ${selective.workerCpuPercent}% vs ${today.workerCpuPercent}% ` +
                `(${Math.round((selective.workerCpuPercent / Math.max(0.1, today.workerCpuPercent)) * 100)}%), traffic per viewer ${selective.sentMbpsPerViewer} vs ${today.sentMbpsPerViewer} Mbps`
        );
    }
} finally {
    chrome.close();
}
