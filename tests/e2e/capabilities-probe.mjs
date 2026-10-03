// What does THIS browser say it can encode and decode for a game screen: VP8, VP9, H.264 and AV1, at 1080p60 and 1440p60, in
// hardware or software, smooth or not (navigator.mediaCapabilities, the same call the health meter makes), plus the codecs it
// offers to WebRTC and the graphics card it runs on. Nothing is captured and nothing is sent anywhere; it takes seconds.
//
//   E2E_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" node tests/e2e/capabilities-probe.mjs
//   HEADLESS=1    use a headless Chrome (it has no access to the graphics card: the answer is NOT what a person's Chrome says)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cdp, sleep } from './lib.mjs';

const chromePath = process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const headless = process.env.HEADLESS === '1';
const port = 9500 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(path.join(tmpdir(), 'e2e-chrome-probe-'));
const proc = spawn(
    chromePath,
    [
        ...(headless ? ['--headless=new'] : ['--window-position=-32000,-32000', '--window-size=400,300']),
        '--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        // a page the browser considers secure, with nothing in it
        'https://example.com/',
    ],
    { stdio: 'ignore' }
);
process.once('exit', () => proc.kill());

let version;
for (let i = 0; i < 80 && !version; i++) {
    try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
        await sleep(250);
    }
}
if (!version) throw new Error('Chrome did not start');
await sleep(2500);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = await cdp(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);

const probe = `(async () => {
    const out = { agent: navigator.userAgent, cores: navigator.hardwareConcurrency, memoryGB: navigator.deviceMemory, secure: isSecureContext };
    // the graphics card as the page can see it
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        out.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    } catch (e) { out.gpu = 'error ' + e.message; }
    try {
        const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
        out.webgpu = adapter ? (adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : 'adapter without info') : 'none';
    } catch (e) { out.webgpu = 'error ' + e.message; }
    // what the browser offers to WebRTC
    const caps = RTCRtpSender.getCapabilities('video');
    out.sends = [...new Set(caps.codecs.map((c) => c.mimeType.replace('video/', '')))];
    out.receives = [...new Set(RTCRtpReceiver.getCapabilities('video').codecs.map((c) => c.mimeType.replace('video/', '')))];
    out.h264Profiles = [...new Set(caps.codecs.filter((c) => /h264/i.test(c.mimeType)).map((c) => (c.sdpFmtpLine || '').match(/profile-level-id=([0-9a-f]+)/i)?.[1]).filter(Boolean))];
    const kinds = [
        ['VP8', 'video/VP8'],
        ['VP9', 'video/VP9'],
        ['H.264', 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e02a'],
        ['AV1', 'video/AV1'],
    ];
    const sizes = [['1080p60', 1920, 1080, 60, 12e6], ['1440p60', 2560, 1440, 60, 16e6], ['2160p60', 3840, 2160, 60, 25e6]];
    out.encode = {};
    out.decode = {};
    for (const [name, contentType] of kinds) {
        for (const [label, width, height, framerate, bitrate] of sizes) {
            const video = { contentType, width, height, bitrate, framerate };
            try {
                const e = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video });
                out.encode[name + ' ' + label] = (e.supported ? 'supported' : 'NOT supported') + (e.powerEfficient ? ' HW' : ' sw') + (e.smooth ? ' smooth' : ' NOT-smooth');
            } catch (err) { out.encode[name + ' ' + label] = 'error ' + err.message; }
            try {
                const d = await navigator.mediaCapabilities.decodingInfo({ type: 'webrtc', video });
                out.decode[name + ' ' + label] = (d.supported ? 'supported' : 'NOT supported') + (d.powerEfficient ? ' HW' : ' sw') + (d.smooth ? ' smooth' : ' NOT-smooth');
            } catch (err) { out.decode[name + ' ' + label] = 'error ' + err.message; }
        }
    }
    return out;
})()`;

const result = await page.ev(probe);
proc.kill();
console.log(`Chrome ${version.Browser} ${headless ? '(headless)' : '(headed)'}`);
console.log(JSON.stringify({ agent: result.agent, cores: result.cores, memoryGB: result.memoryGB, gpu: result.gpu, webgpu: result.webgpu }, null, 1));
console.log('sends :', result.sends.join(', '), '| H.264 profiles:', result.h264Profiles.join(', '));
console.log('receives:', result.receives.join(', '));
console.log('\nENCODE (what this browser can send)');
for (const [k, v] of Object.entries(result.encode)) console.log(`  ${k.padEnd(14)} ${v}`);
console.log('\nDECODE (what this browser can show)');
for (const [k, v] of Object.entries(result.decode)) console.log(`  ${k.padEnd(14)} ${v}`);
process.exit(0);
