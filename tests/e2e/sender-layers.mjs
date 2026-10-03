// What does sending the screen in several layers cost the sender? A sharer streams a 1080p60 animation for a
// while with one viewer pinning it, and every layer it sends is reported: size, frames per second, bitrate, what
// limits it (cpu or bandwidth), the encoder and the time it takes to encode a frame. Run it against an instance
// set to SCREEN_SIMULCAST_LAYERS=1, 2 and 3 (and SCREEN_CODEC=vp8 or h264) to compare.
//
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 20) node tests/e2e/sender-layers.mjs [seconds]
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
const seconds = Number(process.argv[2] || 25);

const chrome = await launchChrome({ chrome: chromePath });

// MUNGE_FMTP="x-google-max-bitrate=15000" adds parameters to the VP8 line of the answer the sender applies, which is
// what mediasoup-client's codecOptions (videoGoogleMaxBitrate...) do. Lets us try them without changing the app.
const munge = process.env.MUNGE_FMTP || '';
// MUNGE_ENCODINGS='[{"scalabilityMode":null},{},{"maxBitrate":5000000}]' changes the sendEncodings the page passes to
// addTransceiver, one patch per layer (null removes a field), to find out what Chrome does with each parameter.
const mungeEncodings = process.env.MUNGE_ENCODINGS || '';
const encodingsScript = `(() => {
    const patches = ${mungeEncodings ? mungeEncodings : '[]'};
    if (!patches.length) return;
    const original = RTCPeerConnection.prototype.addTransceiver;
    RTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
        if (init && init.sendEncodings && init.direction === 'sendonly' && trackOrKind && trackOrKind.kind === 'video' && init.sendEncodings.length === patches.length) {
            init.sendEncodings = init.sendEncodings.map((e, i) => {
                const copy = { ...e };
                for (const [k, v] of Object.entries(patches[i] || {})) { if (v === null) delete copy[k]; else copy[k] = v; }
                return copy;
            });
            console.log('ENCODINGS PATCHED', JSON.stringify(init.sendEncodings));
        }
        return original.call(this, trackOrKind, init);
    };
})();`;
// A real function, not a template string, so the regular expressions reach the page exactly as written
const mungeScript = `(${function (extra) {
    if (!extra) return;
    // 'drop-remb' is not a codec parameter: it removes goog-remb feedback from the answer, so the browser ignores the
    // receiver estimate of the server and only uses its own (transport-cc)
    const dropRemb = extra.split(';').includes('drop-remb');
    const params = extra.split(';').filter((pair) => pair && pair !== 'drop-remb');
    const original = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function (description, ...rest) {
        if (description && description.type === 'answer' && typeof description.sdp === 'string') {
            let sdp = description.sdp;
            const found = /a=rtpmap:(\d+) VP8\/90000/.exec(sdp);
            if (found && params.length) {
                const pt = found[1];
                const line = new RegExp('a=fmtp:' + pt + ' ([^\r\n]*)');
                // a parameter the answer already has is replaced, not repeated
                const keys = params.map((pair) => pair.split('=')[0]);
                if (line.test(sdp)) {
                    sdp = sdp.replace(line, (whole, existing) => 'a=fmtp:' + pt + ' ' + existing.split(';').filter((pair) => !keys.includes(pair.split('=')[0])).concat(params).join(';'));
                } else {
                    sdp = sdp.replace('a=rtpmap:' + pt + ' VP8/90000\r\n', 'a=rtpmap:' + pt + ' VP8/90000\r\na=fmtp:' + pt + ' ' + params.join(';') + '\r\n');
                }
            }
            if (dropRemb) sdp = sdp.replace(/a=rtcp-fb:\d+ goog-remb\r\n/g, '');
            console.log('ANSWER FMTP', (sdp.match(/a=fmtp:\d+ [^\r\n]*/g) || []).join(' | '), '| goog-remb lines:', (sdp.match(/goog-remb/g) || []).length);
            description = { type: description.type, sdp };
        }
        return original.call(this, description, ...rest);
    };
}.toString()})(${JSON.stringify(munge)});`;

const layerStats = `(async () => {
    const out = [];
    for (const p of rc.producers.values()) {
        if (p.kind !== 'video' || p.closed) continue;
        for (const s of (await p.getStats()).values()) {
            if (s.type === 'media-source' && s.kind === 'video') out.push({ source: true, t: s.timestamp, frames: s.frames, fps: s.framesPerSecond, w: s.width, h: s.height });
            if (s.type === 'remote-inbound-rtp' && s.kind === 'video') out.push({ remote: true, ssrc: s.ssrc, lost: s.packetsLost, fraction: s.fractionLost, rtt: s.roundTripTime });
            if (s.type === 'outbound-rtp') out.push({ ssrc: s.ssrc, nack: s.nackCount, plis: s.pliCount, packets: s.packetsSent, retransmitted: s.retransmittedBytesSent, rid: s.rid || '-', t: s.timestamp, frames: s.framesEncoded, bytes: s.bytesSent, key: s.keyFramesEncoded, w: s.frameWidth, h: s.frameHeight, lim: s.qualityLimitationReason, enc: s.encoderImplementation, encTime: s.totalEncodeTime, mode: s.scalabilityMode, target: s.targetBitrate, sentFps: s.framesPerSecond });
        }
    }
    return out;
})()`;

try {
    const sharer = await chrome.newPage();
    await sharer.send('Page.addScriptToEvaluateOnNewDocument', { source: mungeScript });
    await sharer.send('Page.addScriptToEvaluateOnNewDocument', { source: encodingsScript });
    await stubScreenCapture(sharer);
    await joinTestRoom(sharer, { origin, token, name: 'SL-Sharer' });
    await startScreenShare(sharer);
    const config = await sharer.ev("fetch('/config').then((r) => r.json())");
    console.log('server screen settings', JSON.stringify(config.screen));

    const viewer = await chrome.newPage();
    await joinTestRoom(viewer, { origin, token, name: 'SL-Viewer' });
    await sleep(6000);
    await viewer.ev(`(() => { const v = [...document.querySelectorAll('video')].find((v) => v.id && !v.hasAttribute('name') && rc.consumers.has(v.id)); const b = v && document.getElementById(v.id + '__pin'); if (b) b.click(); return !!b; })()`);
    await sleep(10000);

    // One line per layer every 10 s, with the browser's own estimate of the upload bandwidth
    const estimate = `(async () => { const report = await rc.producerTransport.getStats(); for (const s of report.values()) if (s.type === 'candidate-pair' && s.nominated) return Math.round((s.availableOutgoingBitrate || 0) / 1000); return null; })()`;
    const codec = await sharer.ev("[...rc.producers.values()].filter((p) => p.kind === 'video').map((p) => p.rtpParameters.codecs.map((c) => c.mimeType + ' ' + (c.parameters && c.parameters['profile-level-id'] || '')).join(','))");
    console.log('video producers use:', JSON.stringify(codec));
    const negotiated = await sharer.ev(`(async () => { const lines = []; for (const p of rc.producers.values()) { if (p.kind !== 'video' || p.closed) continue; for (const s of (await p.getStats()).values()) if (s.type === 'codec') lines.push(s.mimeType + ' | ' + s.sdpFmtpLine); } return lines; })()`);
    console.log('negotiated send codec lines:', JSON.stringify(negotiated));
    const feedback = await sharer.ev("[...rc.producers.values()].filter((p) => p.kind === 'video').map((p) => ({ extensions: p.rtpParameters.headerExtensions.map((e) => e.uri.split(':').pop()), feedback: p.rtpParameters.codecs[0].rtcpFeedback.map((f) => f.type + (f.parameter ? ' ' + f.parameter : '')) }))");
    console.log('what the server asks the sender to use for bandwidth estimation:', JSON.stringify(feedback));

    let previous = await sharer.ev(layerStats);
    const steps = Math.max(1, Math.round(seconds / 10));
    for (let step = 1; step <= steps; step++) {
        await sleep(10000);
        const now = await sharer.ev(layerStats);
        const bandwidth = await sharer.ev(estimate);
        const parts = [];
        let busy = 0;
        for (const after of now) {
            if (after.source) {
                const was = previous.find((x) => x.source);
                if (was) parts.unshift('source ' + after.w + 'x' + after.h + ' ' + Math.round((after.frames - was.frames) / ((after.t - was.t) / 1000)) + 'fps delivered to the encoder');
                continue;
            }
            const before = previous.find((x) => x.ssrc === after.ssrc);
            if (!before) continue;
            if (after.remote) { parts.push('remote ssrc ' + String(after.ssrc).slice(-3) + ': lost ' + (after.lost - before.lost) + ' pkts, fraction ' + after.fraction + ', rtt ' + Math.round((after.rtt || 0) * 1000) + ' ms'); continue; }
            const dt = (after.t - before.t) / 1000;
            const frames = after.frames - before.frames;
            busy += (after.encTime - before.encTime) / dt;
            parts.push(`nacks +${after.nack - before.nack}, retransmitted ${Math.round(((after.retransmitted - before.retransmitted) * 8) / 1e3 / dt)}k, plis +${after.plis - before.plis}, packets +${after.packets - before.packets}`);
            parts.push(`${after.w}px ${Math.round(frames / dt)}fps ${Math.round(((after.bytes - before.bytes) * 8) / 1e3 / dt)}k(target ${Math.round((after.target || 0) / 1000)}k, ${after.lim})`);
        }
        console.log(`t+${step * 10}s  estimate ${bandwidth}k | ${parts.join(' | ')} | encoder ${(busy * 100).toFixed(0)}% of a core`);
        previous = now;
    }
} finally {
    chrome.close();
}
