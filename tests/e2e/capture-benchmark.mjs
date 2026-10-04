// The REAL screen, not an animation: how many frames per second does this PC's Chrome capture when it shares the whole screen,
// at the sizes the room asks for, and how much does it cost to encode them? This is the measurement that tells whether a
// sender that sends only 16 fps from a 2K monitor is limited by the capture, by the encoder or by what it was told.
//
// What it does: a headed Chrome asks for the screen with getDisplayMedia (the source is chosen by the flag below, no
// dialog), sends it to ITSELF through two RTCPeerConnections (nothing leaves this PC) and for each configuration reads what
// the browser reports: frames per second of the source (media-source), of the encoder, milliseconds per frame, what limited
// it, and how much CPU the whole browser used. The frames are never saved, shown or looked at: only counted.
// It captures what is on the screen while it runs, so run it when that is nothing private (a desktop, a game menu).
//
//   E2E_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" node tests/e2e/capture-benchmark.mjs
//   SOURCE="Screen 1"    the screen or window to capture (as Chrome names it; `Screen 1` is the first monitor)
//   CONFIGS=...          list of name:width x height : codec : contentHint (default below)
//   SECONDS=15   LOW=1   (low priority: when somebody is playing; the speeds are then not exact)
import { launchChrome, sleep } from './lib.mjs';

if (!process.env.E2E_CHROME) throw new Error('set E2E_CHROME');
// This one captures the SCREEN of whoever runs it (frames are only counted, never saved, shown or sent). It does nothing unless the person
// has said so for this run.
if (process.env.ALLOW_SCREEN !== '1') throw new Error('this test captures the real screen: run it with ALLOW_SCREEN=1 only when its owner has agreed and nothing private is on it');
const SOURCE = process.env.SOURCE || 'Screen 1';
const SECONDS = Number(process.env.SECONDS || 15);

// what the room asks for today, what a native 1440p capture costs, a bigger ceiling, a smaller one, other codecs
const CONFIGS = (process.env.CONFIGS ? process.env.CONFIGS.split(',') : [
    'room today (1080p ideal, motion):1920x1080:VP8:motion',
    'room today, hint detail:1920x1080:VP8:detail',
    'room today, no hint:1920x1080:VP8:none',
    'native capture, no size limit:0x0:VP8:motion',
    'smaller capture 1280x720:1280x720:VP8:motion',
    'room today, H.264 Main (graphics card):1920x1080:H264@4d001f:motion',
    'native capture, H.264 Main:0x0:H264@4d001f:motion',
    'room today, VP9:1920x1080:VP9:motion',
]).map((entry) => {
    const [label, size, codec, hint] = entry.split(':');
    const [width, height] = size.split('x').map(Number);
    return { label, width, height, codec, hint };
});

const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME,
    headless: false,
    lowPriority: process.env.LOW === '1',
    extraFlags: [`--auto-select-desktop-capture-source=${SOURCE}`, '--window-size=500,300'],
});

const rows = [];
try {
    const page = await chrome.newPage('about:blank');
    await page.send('Page.navigate', { url: 'https://example.com/' });
    await sleep(2500);
    const browserCpu = async () => {
        const info = (await chrome.browser.send('SystemInfo.getProcessInfo')).result?.processInfo || [];
        return info.reduce((sum, p) => sum + (p.cpuTime || 0), 0);
    };

    for (const config of CONFIGS) {
        const startedAt = Date.now();
        const cpu0 = await browserCpu();
        const result = await page.ev(`(async () => {
            const cfg = ${JSON.stringify(config)}, SECONDS = ${SECONDS};
            const video = cfg.width ? { width: { ideal: cfg.width, max: cfg.width }, height: { ideal: cfg.height, max: cfg.height }, frameRate: { ideal: 60, max: 60 } } : { frameRate: { ideal: 60, max: 60 } };
            let stream;
            try { stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false }); } catch (e) { return { error: 'getDisplayMedia: ' + e.message }; }
            const track = stream.getVideoTracks()[0];
            if (cfg.hint !== 'none') track.contentHint = cfg.hint;
            const settings = track.getSettings();
            const pc1 = new RTCPeerConnection(); const pc2 = new RTCPeerConnection();
            pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
            pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
            // the receiving end decodes into a hidden, muted video element: frames are counted, never looked at
            const sink = document.createElement('video'); sink.muted = true; sink.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
            document.body.appendChild(sink);
            pc2.ontrack = (e) => { sink.srcObject = e.streams[0] || new MediaStream([e.track]); sink.play().catch(() => {}); };
            const tx = pc1.addTransceiver(track, { direction: 'sendonly', sendEncodings: [{ maxBitrate: 12000000 }] });
            const codecs = RTCRtpSender.getCapabilities('video').codecs;
            const [codecName, profile] = cfg.codec.split('@');
            const preferred = codecs.filter((c) => c.mimeType === 'video/' + codecName && (!profile || (c.sdpFmtpLine || '').includes('profile-level-id=' + profile)));
            if (!preferred.length) { stream.getTracks().forEach((t) => t.stop()); return { error: 'the browser does not offer ' + cfg.codec }; }
            tx.setCodecPreferences([...preferred, ...codecs.filter((c) => !preferred.includes(c))]);
            await pc1.setLocalDescription(await pc1.createOffer());
            await pc2.setRemoteDescription(pc1.localDescription);
            const answer = await pc2.createAnswer();
            let sdp = answer.sdp;
            const match = new RegExp('a=rtpmap:(\\\\d+) ' + codecName + '/90000').exec(sdp);
            if (match) {
                const pt = match[1];
                const extra = 'x-google-start-bitrate=3000';
                const line = new RegExp('a=fmtp:' + pt + ' ([^\\\\r\\\\n]*)');
                sdp = line.test(sdp) ? sdp.replace(line, 'a=fmtp:' + pt + ' $1;' + extra) : sdp.replace('a=rtpmap:' + pt + ' ' + codecName + '/90000\\r\\n', 'a=rtpmap:' + pt + ' ' + codecName + '/90000\\r\\na=fmtp:' + pt + ' ' + extra + '\\r\\n');
            }
            await pc2.setLocalDescription({ type: 'answer', sdp });
            await pc1.setRemoteDescription(pc2.localDescription);
            const sample = async () => {
                let out = {};
                for (const s of (await pc1.getStats()).values()) {
                    if (s.type === 'outbound-rtp' && s.kind === 'video') out = { ...out, frames: s.framesEncoded, time: s.totalEncodeTime, ts: s.timestamp, limit: s.qualityLimitationReason, durations: s.qualityLimitationDurations, w: s.frameWidth, h: s.frameHeight, bytes: s.bytesSent, impl: s.encoderImplementation, he: s.powerEfficientEncoder };
                    if (s.type === 'media-source' && s.kind === 'video') out = { ...out, srcFrames: s.frames, srcW: s.width, srcH: s.height };
                }
                return out;
            };
            await new Promise((r) => setTimeout(r, 8000)); // the estimate and the picture size settle
            const a = await sample();
            await new Promise((r) => setTimeout(r, SECONDS * 1000));
            const b = await sample();
            pc1.close(); pc2.close(); stream.getTracks().forEach((t) => t.stop()); sink.remove();
            const dt = (b.ts - a.ts) / 1000;
            return {
                setW: settings.width, setH: settings.height, setFps: settings.frameRate,
                srcFps: (b.srcFrames - a.srcFrames) / dt, srcW: b.srcW, srcH: b.srcH,
                fps: (b.frames - a.frames) / dt, w: b.w, h: b.h,
                encMs: ((b.time - a.time) / Math.max(b.frames - a.frames, 1)) * 1000,
                mbps: ((b.bytes - a.bytes) * 8) / dt / 1e6, limit: b.limit, impl: b.impl, hw: b.he,
            };
        })()`);
        const wall = (Date.now() - startedAt) / 1000;
        const row = { ...config, ...result, cores: result.error ? 0 : ((await browserCpu()) - cpu0) / wall };
        rows.push(row);
        console.log(row.error
            ? `${row.label}: ${row.error}`
            : `${row.label.padEnd(34)} capture ${row.srcFps.toFixed(1)} fps at ${row.srcW}x${row.srcH} (settings ${row.setW}x${row.setH}@${row.setFps}) | sent ${row.fps.toFixed(1)} fps at ${row.w}x${row.h} | ${row.encMs.toFixed(1)} ms/frame | ${row.mbps.toFixed(1)} Mbps | limit ${row.limit} | encoder ${row.impl || '?'}${row.hw === undefined ? '' : row.hw ? ' (hardware)' : ' (software)'} | whole browser ${row.cores.toFixed(1)} cores`);
        await sleep(2000);
    }
} finally {
    chrome.close();
}
console.log('\n(capture = frames per second the screen capture gave; sent = what the encoder produced; the browser total includes the decoding of the same stream)');
process.exit(0);
