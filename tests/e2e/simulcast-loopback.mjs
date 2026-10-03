// Loopback (no server): Chrome sends a 1080p60 animation to itself with the sendEncodings given in ENC (JSON array,
// low layer first), the codec parameters given in FMTP (added to the VP8 line of the answer) and the content hint HINT.
// Prints every 5 s what each layer gets. ENC=[{"maxBitrate":12000000}] is the single layer case. Useful to see what
// Chrome does with the layers without a server in the way; the round trip is ~0 here, so the bandwidth estimate
// behaves differently from a real call (see docs/MEASUREMENTS.md).
//
//   E2E_CHROME=... ENC='[{"maxBitrate":600000,"scaleResolutionDownBy":4},{"maxBitrate":12000000}]' node tests/e2e/simulcast-loopback.mjs
import { launchChrome, sleep } from './lib.mjs';

if (!process.env.E2E_CHROME) throw new Error('set E2E_CHROME');
const encodings = JSON.parse(process.env.ENC || '[{"maxBitrate":12000000}]');
const fmtp = process.env.FMTP || 'x-google-start-bitrate=3000';
const hint = process.env.HINT === undefined ? 'motion' : process.env.HINT;
const codecName = process.env.CODEC || 'VP8';
const rounds = Number(process.env.ROUNDS || 6);
const label = process.env.LABEL || '';
const chrome = await launchChrome({ chrome: process.env.E2E_CHROME });
try {
    const page = await chrome.newPage('about:blank');
    await page.send('Page.navigate', { url: 'data:text/html,<title>sim</title><body></body>' });
    await sleep(500);
    const result = await page.ev(`(async () => {
        const W = 1920, H = 1080;
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const balls = Array.from({ length: 220 }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 14, r: 8 + Math.random() * 38, h: Math.floor(Math.random() * 360) }));
        let tick = 0;
        const draw = () => { tick++; for (let i = 0; i < 12; i++) { ctx.fillStyle = 'hsl(' + ((tick * 2 + i * 30) % 360) + ' 60% ' + (18 + (i % 3) * 8) + '%)'; ctx.fillRect(((i * 180 + tick * 6) % 2160) - 180, 0, 180, H); }
            for (const b of balls) { b.x += b.vx; b.y += b.vy; if (b.x < 0 || b.x > W) b.vx *= -1; if (b.y < 0 || b.y > H) b.vy *= -1; ctx.beginPath(); ctx.fillStyle = 'hsl(' + ((b.h + tick) % 360) + ' 80% 55%)'; ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill(); }
            requestAnimationFrame(draw); };
        requestAnimationFrame(draw);
        const track = canvas.captureStream(60).getVideoTracks()[0];
        const hint = ${JSON.stringify(hint)};
        if (hint) track.contentHint = hint;
        const pc1 = new RTCPeerConnection(); const pc2 = new RTCPeerConnection();
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
        const encodings = ${JSON.stringify(encodings)}.map((e, i, all) => (all.length > 1 ? { rid: 'r' + i, ...e } : e));
        const tx = pc1.addTransceiver(track, { direction: 'sendonly', sendEncodings: encodings });
        const codecs = RTCRtpSender.getCapabilities('video').codecs;
        const want = ${JSON.stringify(codecName)};
        tx.setCodecPreferences([...codecs.filter((c) => c.mimeType === 'video/' + want), ...codecs.filter((c) => c.mimeType !== 'video/' + want)]);
        await pc1.setLocalDescription(await pc1.createOffer());
        await pc2.setRemoteDescription(pc1.localDescription);
        const answer = await pc2.createAnswer();
        let sdp = answer.sdp;
        const match = new RegExp('a=rtpmap:(\\\\d+) ' + want + '/90000').exec(sdp);
        const extra = ${JSON.stringify(fmtp)};
        if (match && extra) {
            const pt = match[1];
            const line = new RegExp('a=fmtp:' + pt + ' ([^\\\\r\\\\n]*)');
            sdp = line.test(sdp) ? sdp.replace(line, 'a=fmtp:' + pt + ' $1;' + extra) : sdp.replace('a=rtpmap:' + pt + ' ' + want + '/90000\\r\\n', 'a=rtpmap:' + pt + ' ' + want + '/90000\\r\\na=fmtp:' + pt + ' ' + extra + '\\r\\n');
        }
        if (encodings.length > 1) {
            const rids = encodings.map((_, i) => 'r' + i);
            sdp = sdp.trimEnd() + '\\r\\n' + rids.map((r) => 'a=rid:' + r + ' recv').join('\\r\\n') + '\\r\\na=simulcast:recv ' + rids.join(';') + '\\r\\n';
        }
        await pc2.setLocalDescription({ type: 'answer', sdp });
        await pc1.setRemoteDescription(pc2.localDescription);
        window.__pc1 = pc1;
        const grab = (text) => (text.match(/a=(rid|simulcast)[^\\r\\n]*/g) || []).join(' | ');
        return 'offer: ' + grab(pc1.localDescription.sdp) + ' || answer: ' + grab(sdp) + ' || started with ' + encodings.length + ' encoding(s); answer fmtp: ' + (sdp.match(/a=fmtp:\\d+ [^\\r\\n]*/g) || []).filter((l) => l.includes('x-google')).join(' | ');
    })()`);
    console.log(label, result);
    let prev = null;
    for (let i = 1; i <= rounds; i++) {
        await sleep(5000);
        const now = await page.ev(`(async () => {
            const out = []; let estimate = null;
            for (const s of (await window.__pc1.getStats()).values()) {
                if (s.type === 'outbound-rtp' && s.kind === 'video') out.push({ ssrc: s.ssrc, rid: s.rid, w: s.frameWidth, t: s.timestamp, frames: s.framesEncoded, bytes: s.bytesSent, target: s.targetBitrate, lim: s.qualityLimitationReason, enc: s.encoderImplementation });
                if (s.type === 'candidate-pair' && s.nominated) estimate = Math.round((s.availableOutgoingBitrate || 0) / 1000);
            }
            return { out, estimate };
        })()`);
        if (prev) {
            const parts = now.out.map((a) => { const b = prev.out.find((x) => x.ssrc === a.ssrc); if (!b) return ''; const dt = (a.t - b.t) / 1000; return a.w + 'px ' + Math.round((a.frames - b.frames) / dt) + 'fps ' + Math.round(((a.bytes - b.bytes) * 8) / 1e3 / dt) + 'k(target ' + Math.round((a.target || 0) / 1000) + 'k ' + a.lim + ')'; });
            console.log(`${label} t+${i * 5}s estimate ${now.estimate}k | ${parts.join(' | ')}`);
        }
        prev = now;
    }
} finally {
    chrome.close();
}
