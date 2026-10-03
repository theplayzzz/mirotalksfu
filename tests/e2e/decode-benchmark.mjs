// What it costs a VIEWER to decode a 1080p60 screen in each codec: the same 14 s of game-like animation encoded in VP8, VP9,
// H.264 (constrained baseline, no B-frames, like WebRTC) and AV1 at about 8 Mbps, played muted in a real (headed) Chrome,
// once and three at a time (three screens on the page, a viewer in a room of three senders), measuring how much processor
// the whole browser uses above an idle page and whether it drops frames. Software decoding shows up in the renderer
// process; hardware decoding is a few percent of a core in the graphics process.
//
// It plays the files in a <video> element: the pipeline is the browser's own media pipeline, not the WebRTC receiver, but
// the decoders are the same ones (libvpx in software for VP8, the graphics card for H.264/VP9/AV1 where it has them).
// Nothing is captured, nothing leaves this PC.
//
//   E2E_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" node tests/e2e/decode-benchmark.mjs
//   SOURCE=file.mp4   a 1080p60 clip to make the test files from (needs ffmpeg with libvpx, libx264 and libsvtav1)
//   CLIPS=dir         where the test files are (default: the temp directory; they are made when they are not there)
//   SECONDS=10   STREAMS=1,3   LOW=1 (low priority: somebody is using this PC)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, serveAssets, sleep } from './lib.mjs';

if (!process.env.E2E_CHROME) throw new Error('set E2E_CHROME');
const SECONDS = Number(process.env.SECONDS || 10);
const STREAMS = (process.env.STREAMS || '1,3').split(',').map(Number);
const dir = process.env.CLIPS || path.join(os.tmpdir(), 'decode-clips');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'blank.html'), '<!doctype html><meta charset="utf-8"><title>decode benchmark</title><body></body>');

const CLIPS = [
    { codec: 'VP8', file: 'vp8.webm', type: 'video/webm; codecs="vp8"', encode: ['-c:v', 'libvpx', '-b:v', '8M', '-maxrate', '10M', '-bufsize', '8M', '-deadline', 'realtime', '-cpu-used', '6', '-g', '600', '-threads', '4'] },
    { codec: 'VP9', file: 'vp9.webm', type: 'video/webm; codecs="vp09.00.40.08"', encode: ['-c:v', 'libvpx-vp9', '-b:v', '8M', '-maxrate', '10M', '-bufsize', '8M', '-deadline', 'realtime', '-cpu-used', '7', '-row-mt', '1', '-g', '600', '-threads', '4'] },
    { codec: 'H264', file: 'h264.mp4', type: 'video/mp4; codecs="avc1.42E01F"', encode: ['-c:v', 'libx264', '-profile:v', 'baseline', '-preset', 'veryfast', '-b:v', '8M', '-maxrate', '10M', '-bufsize', '8M', '-bf', '0', '-g', '600', '-pix_fmt', 'yuv420p', '-threads', '4'] },
    { codec: 'AV1', file: 'av1.mp4', type: 'video/mp4; codecs="av01.0.08M.08"', encode: ['-c:v', 'libsvtav1', '-preset', '9', '-b:v', '8M', '-g', '600', '-pix_fmt', 'yuv420p', '-svtav1-params', 'lp=4'] },
];

// make the clips that are missing, at a low priority
for (const clip of CLIPS) {
    const target = path.join(dir, clip.file);
    if (existsSync(target)) continue;
    if (!process.env.SOURCE) throw new Error(`${target} is missing: set SOURCE to a 1080p60 clip to make it from`);
    console.log('making', clip.file);
    const child = spawn(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', process.env.SOURCE, '-an', '-r', '60', ...clip.encode, target], { stdio: 'ignore' });
    try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (error) {
        // normal priority
    }
    await new Promise((resolve, reject) => child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed for ${clip.file}`)))));
}

const assets = await serveAssets(dir);
const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME,
    headless: false,
    lowPriority: process.env.LOW === '1',
    // a window that is off the screen counts as covered, and a covered window does not decode what it cannot show
    extraFlags: ['--disable-features=CalculateNativeWinOcclusion', '--window-size=700,500'],
});

try {
    const page = await chrome.newPage();
    await page.send('Page.navigate', { url: `${assets.url}/blank.html` });
    await sleep(1500);
    await page.ev('document.body.innerHTML = ""; true');

    const processes = async () => {
        const info = (await chrome.browser.send('SystemInfo.getProcessInfo')).result?.processInfo || [];
        const by = {};
        for (const p of info) by[p.type] = (by[p.type] || 0) + (p.cpuTime || 0);
        return by;
    };
    const diff = (b, a, wall) => Object.fromEntries(Object.keys(a).map((type) => [type, ((a[type] - (b[type] || 0)) / wall)]));
    const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);

    // an idle page, to subtract
    const idle0 = await processes();
    const t0 = Date.now();
    await sleep(5000);
    const idle = diff(idle0, await processes(), (Date.now() - t0) / 1000);
    console.log(`idle page: ${sum(idle).toFixed(2)} cores`);

    for (const clip of CLIPS) {
        const info = await page.ev(`(async () => {
            const type = ${JSON.stringify(clip.type)};
            const r = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: { contentType: type, width: 1920, height: 1080, bitrate: 8000000, framerate: 60 } });
            return { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
        })()`);
        for (const count of STREAMS) {
            await page.ev(`(async () => {
                document.body.innerHTML = '';
                for (let i = 0; i < ${count}; i++) {
                    const v = document.createElement('video');
                    v.muted = true; v.loop = true; v.playsInline = true; v.width = 320; v.height = 180; v.src = '/${clip.file}?n=' + i;
                    document.body.appendChild(v);
                    await v.play().catch(() => {});
                }
                return true;
            })()`);
            await sleep(4000); // starts, the first key frame, the pipeline settles
            const q0 = await page.ev('[...document.querySelectorAll("video")].map((v) => { const q = v.getVideoPlaybackQuality(); return { total: q.totalVideoFrames, dropped: q.droppedVideoFrames }; })');
            const p0 = await processes();
            const t1 = Date.now();
            await sleep(SECONDS * 1000);
            const p1 = await processes();
            const wall = (Date.now() - t1) / 1000;
            const q1 = await page.ev('[...document.querySelectorAll("video")].map((v) => { const q = v.getVideoPlaybackQuality(); return { total: q.totalVideoFrames, dropped: q.droppedVideoFrames, w: v.videoWidth, h: v.videoHeight }; })');
            const used = diff(p0, p1, wall);
            const fps = q1.map((q, i) => (q.total - q0[i].total) / wall);
            const dropped = q1.reduce((s, q, i) => s + (q.dropped - q0[i].dropped), 0);
            const above = sum(used) - sum(idle);
            console.log(
                `${clip.codec.padEnd(5)} x${count}  ${fps.map((f) => f.toFixed(1)).join('/')} fps at ${q1[0].w}x${q1[0].h}  dropped ${dropped}  | browser above idle ${above.toFixed(2)} cores (${(above / count).toFixed(2)} per stream)` +
                `  [renderer ${(used.renderer || 0).toFixed(2)}, gpu ${(used.gpu || 0).toFixed(2)}, utility ${(used.utility || 0).toFixed(2)}, browser ${(used.browser || 0).toFixed(2)}]  | decoder ${info.powerEfficient ? 'hardware' : 'software'}${info.smooth ? '' : ' (not smooth by the capabilities history)'}`
            );
        }
    }
    await page.ev('document.body.innerHTML = ""; true');
} finally {
    assets.close();
    chrome.close();
}
process.exit(0);
