// How much does it cost THIS PC to send a game screen at 60 fps in each codec and size? Chrome sends an animated canvas to
// itself (no server, nothing leaves the machine; nothing of the real screen is captured) and for each configuration the
// test reads what the encoder really did: frames per second, milliseconds per frame, what implementation Chrome used
// (software or a hardware encoder), what limited it, and how much CPU the whole browser used.
//
//   E2E_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" node tests/e2e/codec-benchmark.mjs
//   CODECS=VP8,VP9,H264,AV1   SIZES=1920x1080,2560x1440   FPS=60   SECONDS=8   HINT=motion   BITRATE=12000000
//   LOW=1      run the browser at a low priority (when somebody is playing on this PC): the speeds are then not exact
//   HEADLESS=1 a headless Chrome (no graphics card: it never uses a hardware encoder)
import { launchChrome, sleep } from './lib.mjs';

if (!process.env.E2E_CHROME) throw new Error('set E2E_CHROME');
const codecs = (process.env.CODECS || 'VP8,VP9,H264,AV1').split(',');
const sizes = (process.env.SIZES || '1920x1080,2560x1440').split(',').map((s) => s.split('x').map(Number));
const FPS = Number(process.env.FPS || 60);
const SECONDS = Number(process.env.SECONDS || 8);
const HINT = process.env.HINT === undefined ? 'motion' : process.env.HINT;
const BITRATE = Number(process.env.BITRATE || 12000000);
const DEGRADE = process.env.DEGRADE || ''; // maintain-resolution | maintain-framerate | balanced (default: leave Chrome's own)

const chrome = await launchChrome({ chrome: process.env.E2E_CHROME, headless: process.env.HEADLESS === '1', lowPriority: process.env.LOW === '1' });
const rows = [];
try {
    const page = await chrome.newPage('about:blank');
    await page.send('Page.navigate', { url: 'data:text/html,<title>bench</title><body></body>' });
    await sleep(800);

    const browserCpu = async () => {
        const info = (await chrome.browser.send('SystemInfo.getProcessInfo')).result?.processInfo || [];
        return info.reduce((sum, p) => sum + (p.cpuTime || 0), 0);
    };

    for (const [W, H] of sizes) {
        for (const codec of codecs) {
            const startedAt = Date.now();
            const cpu0 = await browserCpu();
            const result = await page.ev(`(async () => {
                const W = ${W}, H = ${H}, FPS = ${FPS}, SECONDS = ${SECONDS}, want = ${JSON.stringify(codec)};
                document.body.innerHTML = '';
                const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; document.body.appendChild(canvas);
                const ctx = canvas.getContext('2d');
                // constant motion over the whole picture, like a game: scrolling bars, 220 bouncing balls, moving text
                const balls = Array.from({ length: 220 }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 14, r: 8 + Math.random() * 38, h: Math.floor(Math.random() * 360) }));
                let tick = 0, alive = true;
                const draw = () => {
                    if (!alive) return;
                    tick++;
                    for (let i = 0; i < 12; i++) { ctx.fillStyle = 'hsl(' + ((tick * 2 + i * 30) % 360) + ' 60% ' + (18 + (i % 3) * 8) + '%)'; ctx.fillRect(((i * 180 + tick * 6) % (W + 240)) - 180, 0, 180, H); }
                    for (const b of balls) { b.x += b.vx; b.y += b.vy; if (b.x < 0 || b.x > W) b.vx *= -1; if (b.y < 0 || b.y > H) b.vy *= -1; ctx.beginPath(); ctx.fillStyle = 'hsl(' + ((b.h + tick) % 360) + ' 80% 55%)'; ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); }
                    ctx.fillStyle = '#fff'; ctx.font = 'bold 64px sans-serif'; ctx.fillText('frame ' + tick, 60 + (tick * 3) % 1400, H / 2 + Math.sin(tick / 20) * 300);
                    requestAnimationFrame(draw);
                };
                requestAnimationFrame(draw);
                const track = canvas.captureStream(FPS).getVideoTracks()[0];
                if (${JSON.stringify(HINT)}) track.contentHint = ${JSON.stringify(HINT)};
                const pc1 = new RTCPeerConnection(); const pc2 = new RTCPeerConnection();
                pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
                pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
                const tx = pc1.addTransceiver(track, { direction: 'sendonly', sendEncodings: [{ maxBitrate: ${BITRATE} }] });
                const codecs = RTCRtpSender.getCapabilities('video').codecs;
                const preferred = codecs.filter((c) => c.mimeType === 'video/' + want);
                if (!preferred.length) { alive = false; return { error: 'the browser does not offer ' + want }; }
                // H.264: prefer the entry with the highest level so that 1080p60 and 1440p60 fit
                tx.setCodecPreferences([...preferred, ...codecs.filter((c) => c.mimeType !== 'video/' + want)]);
                await pc1.setLocalDescription(await pc1.createOffer());
                await pc2.setRemoteDescription(pc1.localDescription);
                // Chrome starts a call at a few hundred kbps and chooses a small picture until its estimate has grown, which takes
                // many seconds on a loopback without any round trip: start high, like the room does (videoGoogleStartBitrate)
                const answer = await pc2.createAnswer();
                let sdp = answer.sdp;
                const match = new RegExp('a=rtpmap:(\\\\d+) ' + want + '/90000').exec(sdp);
                if (match) {
                    const pt = match[1];
                    const extra = 'x-google-start-bitrate=${Math.round(BITRATE / 1000)};x-google-min-bitrate=${Math.round(BITRATE / 2000)}';
                    const line = new RegExp('a=fmtp:' + pt + ' ([^\\\\r\\\\n]*)');
                    sdp = line.test(sdp) ? sdp.replace(line, 'a=fmtp:' + pt + ' $1;' + extra) : sdp.replace('a=rtpmap:' + pt + ' ' + want + '/90000\\r\\n', 'a=rtpmap:' + pt + ' ' + want + '/90000\\r\\na=fmtp:' + pt + ' ' + extra + '\\r\\n');
                }
                await pc2.setLocalDescription({ type: 'answer', sdp });
                await pc1.setRemoteDescription(pc2.localDescription);
                // What Chrome does when the encoder or the estimate cannot keep up: keep the picture size and drop frames
                // ('maintain-resolution') or keep the frame rate and shrink the picture ('maintain-framerate')
                let degradation = 'default';
                if (${JSON.stringify(DEGRADE)}) {
                    try {
                        const p = tx.sender.getParameters();
                        p.degradationPreference = ${JSON.stringify(DEGRADE)};
                        await tx.sender.setParameters(p);
                        degradation = (tx.sender.getParameters().degradationPreference) || 'set but not reported';
                    } catch (e) { degradation = 'not accepted: ' + e.message; }
                }
                const sample = async () => {
                    let out = {};
                    for (const s of (await pc1.getStats()).values()) {
                        if (s.type === 'outbound-rtp' && s.kind === 'video') out = { ...out, frames: s.framesEncoded, sent: s.framesSent, time: s.totalEncodeTime, ts: s.timestamp, impl: s.encoderImplementation, he: s.powerEfficientEncoder, limit: s.qualityLimitationReason, durations: s.qualityLimitationDurations, w: s.frameWidth, h: s.frameHeight, bytes: s.bytesSent, key: s.keyFramesEncoded, target: s.targetBitrate };
                        if (s.type === 'media-source' && s.kind === 'video') out = { ...out, srcFps: s.framesPerSecond, srcFrames: s.frames, srcW: s.width, srcH: s.height };
                    }
                    return out;
                };
                await new Promise((r) => setTimeout(r, 6000)); // let the encoder and the estimate settle
                const a = await sample();
                await new Promise((r) => setTimeout(r, SECONDS * 1000));
                const b = await sample();
                alive = false; pc1.close(); pc2.close(); track.stop();
                const dt = (b.ts - a.ts) / 1000;
                return {
                    degradation,
                    fps: (b.frames - a.frames) / dt,
                    srcFps: (b.srcFrames - a.srcFrames) / dt,
                    encMs: ((b.time - a.time) / Math.max(b.frames - a.frames, 1)) * 1000,
                    mbps: ((b.bytes - a.bytes) * 8) / dt / 1e6,
                    impl: b.impl, hw: b.he, limit: b.limit, w: b.w, h: b.h, srcW: b.srcW, srcH: b.srcH,
                    limitCpuS: (b.durations?.cpu || 0) - (a.durations?.cpu || 0), limitBwS: (b.durations?.bandwidth || 0) - (a.durations?.bandwidth || 0),
                    keyFrames: b.key - a.key,
                };
            })()`);
            const cpu1 = await browserCpu();
            const wall = (Date.now() - startedAt) / 1000;
            const row = { size: `${W}x${H}`, codec, ...result, cores: result.error ? 0 : (cpu1 - cpu0) / wall };
            rows.push(row);
            console.log(row.error ? `${row.size} ${codec}: ${row.error}` : `${row.size}  ${codec.padEnd(5)} sent ${row.fps.toFixed(1)} fps (source ${row.srcFps.toFixed(1)}) at ${row.w}x${row.h} | ${row.encMs.toFixed(1)} ms/frame | ${row.mbps.toFixed(1)} Mbps | limit ${row.limit} (cpu ${row.limitCpuS.toFixed(1)} s, bandwidth ${row.limitBwS.toFixed(1)} s) | degradation ${row.degradation} | whole browser ${row.cores.toFixed(1)} cores`);
            await sleep(1500);
        }
    }
} finally {
    chrome.close();
}
console.log('\n(browser total includes drawing the animation, encoding and the DECODING of the same stream by the receiving end)');
process.exit(0);
