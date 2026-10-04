// What does an encoder send for a picture that hardly changes? A screen that stands still gives the encoder a frame or two a second (the
// capture only delivers what changed), and a rate control that spends a fixed bitrate on whatever frames it gets would send megabits
// of nothing. This sends a desktop-like picture (still, with a tiny clock in a corner) to itself at several frame rates in VP8 and in
// the H.264 profile that the graphics card encodes, and reports what each one sent.
//
//   E2E_CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" node tests/e2e/static-bitrate.mjs
//   RATES=1,5,15,30   frames per second given to the encoder      CODECS=VP8,H264@4d001f      SECONDS=10      SIZE=1920x1080      LOW=1
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, serveAssets, sleep } from './lib.mjs';

if (!process.env.E2E_CHROME) throw new Error('set E2E_CHROME');
const RATES = (process.env.RATES || '1,5,15,30').split(',').map(Number);
const CODECS = (process.env.CODECS || 'VP8,H264@4d001f').split(',');
const SECONDS = Number(process.env.SECONDS || 10);
const [W, H] = (process.env.SIZE || '1920x1080').split('x').map(Number);

const dir = mkdtempSync(path.join(os.tmpdir(), 'static-bitrate-'));
writeFileSync(path.join(dir, 'blank.html'), '<!doctype html><meta charset="utf-8"><title>static</title><body></body>');
const assets = await serveAssets(dir);
// (a fake camera that stays open: the browser then names the encoder it used)
const chrome = await launchChrome({ chrome: process.env.E2E_CHROME, headless: false, lowPriority: process.env.LOW === '1', extraFlags: ['--use-fake-device-for-media-stream'] });

try {
    const page = await chrome.newPage(`${assets.url}/blank.html`);
    await sleep(800);
    await page.ev("navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { window.__gate = s; return true; }, (e) => String(e))");
    console.log(`desktop-like picture ${W}x${H}, ${SECONDS} s each (after 6 s of settling): kilobits per second sent, and what the encoder was`);
    for (const rate of RATES) {
        for (const codec of CODECS) {
            const r = await page.ev(`(async () => {
                const W = ${W}, H = ${H}, RATE = ${rate}, [name, profile] = ${JSON.stringify(codec)}.split('@');
                const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; document.body.appendChild(canvas);
                const ctx = canvas.getContext('2d');
                // windows, text-like lines and a taskbar: drawn once; only a clock in a corner changes
                ctx.fillStyle = '#1e2a3a'; ctx.fillRect(0, 0, W, H);
                for (let i = 0; i < 9; i++) { ctx.fillStyle = i % 2 ? '#2b3b52' : '#26354b'; ctx.fillRect(80 + (i % 3) * 600, 80 + Math.floor(i / 3) * 330, 560, 300); }
                ctx.fillStyle = '#d6e2f0'; ctx.font = '22px monospace';
                for (let l = 0; l < 30; l++) ctx.fillText('line ' + l + ' of text a desktop would show: lorem ipsum dolor sit amet ' + l * 7919, 100, 120 + l * 26);
                ctx.fillStyle = '#111'; ctx.fillRect(0, H - 40, W, 40);
                const stream = canvas.captureStream(0);
                const track = stream.getVideoTracks()[0];
                track.contentHint = 'motion';
                let n = 0;
                const frame = () => { n++; ctx.fillStyle = '#111'; ctx.fillRect(W - 220, H - 40, 220, 40); ctx.fillStyle = '#fff'; ctx.font = '24px monospace'; ctx.fillText('12:' + String(n % 60).padStart(2, '0') + ':' + String(n % 97).padStart(2, '0'), W - 160, H - 12); track.requestFrame(); };
                frame();
                const timer = setInterval(frame, 1000 / RATE);
                const pc1 = new RTCPeerConnection(); const pc2 = new RTCPeerConnection();
                pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
                pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
                const tx = pc1.addTransceiver(track, { direction: 'sendonly', sendEncodings: [{ maxBitrate: 12000000 }] });
                const all = RTCRtpSender.getCapabilities('video').codecs;
                const preferred = all.filter((c) => c.mimeType === 'video/' + name && (!profile || (c.sdpFmtpLine || '').includes('profile-level-id=' + profile)));
                if (!preferred.length) { clearInterval(timer); track.stop(); return { error: 'the browser does not offer ' + ${JSON.stringify(codec)} }; }
                tx.setCodecPreferences([...preferred, ...all.filter((c) => !preferred.includes(c))]);
                await pc1.setLocalDescription(await pc1.createOffer());
                await pc2.setRemoteDescription(pc1.localDescription);
                const answer = await pc2.createAnswer();
                let sdp = answer.sdp;
                const match = new RegExp('a=rtpmap:(\\\\d+) ' + name + '/90000').exec(sdp);
                if (match) {
                    const pt = match[1], extra = 'x-google-start-bitrate=12000;x-google-min-bitrate=6000';
                    const line = new RegExp('a=fmtp:' + pt + ' ([^\\\\r\\\\n]*)');
                    sdp = line.test(sdp) ? sdp.replace(line, 'a=fmtp:' + pt + ' $1;' + extra) : sdp.replace('a=rtpmap:' + pt + ' ' + name + '/90000\\r\\n', 'a=rtpmap:' + pt + ' ' + name + '/90000\\r\\na=fmtp:' + pt + ' ' + extra + '\\r\\n');
                }
                await pc2.setLocalDescription({ type: 'answer', sdp });
                await pc1.setRemoteDescription(pc2.localDescription);
                const sample = async () => { let o = {}; for (const s of (await pc1.getStats()).values()) if (s.type === 'outbound-rtp' && s.kind === 'video') o = { ts: s.timestamp, bytes: s.bytesSent, frames: s.framesEncoded, key: s.keyFramesEncoded, impl: s.encoderImplementation, w: s.frameWidth, target: s.targetBitrate }; return o; };
                await new Promise((r) => setTimeout(r, 6000));
                const a = await sample();
                await new Promise((r) => setTimeout(r, ${SECONDS} * 1000));
                const b = await sample();
                clearInterval(timer); pc1.close(); pc2.close(); track.stop(); canvas.remove();
                const dt = (b.ts - a.ts) / 1000;
                return { kbps: ((b.bytes - a.bytes) * 8) / 1000 / dt, fps: (b.frames - a.frames) / dt, keys: b.key - a.key, impl: b.impl, w: b.w, target: b.target / 1000 };
            })()`);
            console.log(r.error ? `${String(rate).padStart(2)} fps  ${codec}: ${r.error}` : `${String(rate).padStart(2)} fps given  ${codec.padEnd(11)} sent ${r.kbps.toFixed(0).padStart(6)} kbps  (${r.fps.toFixed(1)} fps out, ${r.keys} key frames, the picture ${r.w}px wide, the browser aimed at ${r.target.toFixed(0)} kbps, ${r.impl || 'encoder not named'})`);
            await sleep(1000);
        }
    }
} finally {
    chrome.close();
    assets.close();
}
process.exit(0);
