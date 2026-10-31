// Low resolution synthetic screen/audio on the DEVELOPMENT test room. No real screen or microphone is captured.
// E2E_CHROME=... E2E_ORIGIN=... E2E_TOKEN=... node tests/e2e/stream-audio-defaults.mjs
import assert from 'node:assert/strict';
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
if (!origin.includes('mirotalk-dev.')) throw new Error('this test is for the development instance only');
const chrome = await launchChrome({ chrome: chromePath, extraFlags: ['--use-fake-device-for-media-stream'] });
async function waitFor(page, expression) {
    for (let i = 0; i < 100; i++) {
        if (await page.ev(expression).catch(() => false)) return;
        await sleep(150);
    }
    throw new Error(`timed out: ${expression}`);
}
async function state(page, peerId) {
    return page.ev(`(() => {
        const peer = ${JSON.stringify(peerId)};
        const audio = rc.getOutputAudioElements().filter(a => a.dataset.peerId === peer);
        return { muted: rc.locallyMutedPeerIds.has(peer), volumes: audio.map(a => a.volume),
            labels: rc.getPeerAudioButtons(peer).map(b => b.getAttribute('aria-label')) };
    })()`);
}
const clickAudio = (page, peerId) => page.ev(`rc.getPeerAudioButtons(${JSON.stringify(peerId)})[0].click()`);
try {
    const sender = await chrome.newPage();
    await stubScreenCapture(sender, { width: 640, height: 360, fps: 10, withAudio: true });
    await joinTestRoom(sender, { origin, token, name: 'Audio-Sender' });
    await waitFor(sender, "rc.producerLabel.has('audioType')");
    await sender.ev("if (rc.producerLabel.has('audioType')) rc.closeProducer('audioType')");
    const peerId = await sender.ev('rc.peer_id');
    const first = await chrome.newPage();
    await joinTestRoom(first, { origin, token, name: 'Audio-Viewer-1' });
    await waitFor(first, "rc.producerLabel.has('audioType')");
    await first.ev("if (rc.producerLabel.has('audioType')) rc.closeProducer('audioType')");
    // Watch the first instant an audio stream is attached, not only its eventual volume.
    await first.ev(`window.__audioAttached = []; const originalAttach = rc.attachMediaStream.bind(rc);
        rc.attachMediaStream = async function(elem, ...args) {
            if (elem.tagName === 'AUDIO') window.__audioAttached.push({ volume: elem.volume, muted: elem.muted });
            return originalAttach(elem, ...args);
        };`);
    await startScreenShare(sender);
    await waitFor(sender, "rc.producerLabel.has('audioTab')");
    const screenOpus = await sender.ev(`rc.producers.get(rc.producerLabel.get('audioTab')).rtpParameters.codecs
        .find(c => c.mimeType.toLowerCase() === 'audio/opus')`);
    assert.equal(screenOpus.parameters['sprop-stereo'], 1);
    assert.ok(screenOpus.rtcpFeedback.some((fb) => fb.type === 'nack'));
    console.log('PASS screen audio negotiates stereo and retains NACK');
    const audioProducerId = await sender.ev("rc.producerLabel.get('audioTab')");
    await first.ev(`window.__testAudioProducerId = ${JSON.stringify(audioProducerId)}`);
    await waitFor(first, 'rc.getOutputAudioElements().length > 0 && rc.consumers.size >= 2');
    assert.equal((await state(first, peerId)).muted, true);
    assert.ok((await first.ev('window.__audioAttached')).every((a) => a.muted || a.volume === 0));
    assert.ok((await state(first, peerId)).labels.every((l) => l === 'Voltar a ouvir somente para mim'));
    console.log('PASS existing viewer: muted before attaching autoplay, with the unmute button');

    const late = await chrome.newPage();
    await joinTestRoom(late, { origin, token, name: 'Audio-Viewer-2' });
    await waitFor(late, "rc.producerLabel.has('audioType')");
    await late.ev("if (rc.producerLabel.has('audioType')) rc.closeProducer('audioType')");
    await waitFor(late, 'rc.getOutputAudioElements().length > 0 && rc.consumers.size >= 2');
    assert.equal((await state(late, peerId)).muted, true);
    await clickAudio(first, peerId);
    assert.ok((await state(first, peerId)).volumes.every((v) => v > 0));
    assert.ok((await state(late, peerId)).volumes.every((v) => v === 0));
    await first.ev('rc.reconcileConsumers()');
    assert.equal((await state(first, peerId)).muted, false);
    console.log('PASS late join, independent unmute and reconciliation');

    console.log(
        'AUDIO_SENDER',
        JSON.stringify(
            await sender.ev(`(async () => {
        const p = rc.producers.get(rc.producerLabel.get('audioTab'));
        const before = [...(await p.getStats()).values()].find(s => s.type === 'outbound-rtp');
        await new Promise(r => setTimeout(r, 3000));
        const after = [...(await p.getStats()).values()].find(s => s.type === 'outbound-rtp');
        const sdp = rc.producerTransport._handler._pc.remoteDescription.sdp;
        return { codecs: p.rtpParameters.codecs, track: p.track.getSettings(),
            bitrate: Math.round((after.bytesSent-before.bytesSent)*8000/(after.timestamp-before.timestamp)),
            opusAnswer: sdp.split(String.fromCharCode(13, 10)).filter(l => /fmtp:.*(minptime|stereo|useinbandfec)/.test(l)) };
    })()`)
        )
    );
    console.log(
        'AUDIO_RECEIVER',
        JSON.stringify(
            await first.ev(`(async () => {
        const c = [...rc.consumers.values()].find(c => c.producerId === window.__testAudioProducerId);
        const stats = [...(await c.getStats()).values()].find(s => s.type === 'inbound-rtp');
        return Object.fromEntries(['packetsReceived','packetsLost','jitter','concealedSamples','totalSamplesReceived',
            'concealmentEvents','jitterBufferDelay','jitterBufferEmittedCount'].map(k => [k,stats[k]]));
    })()`)
        )
    );

    await sender.ev("rc.closeProducer('screenType')");
    await waitFor(first, '!rc.consumersProducer.has(window.__testAudioProducerId)');
    // Replace just the capture stub: the next share has no audio at all.
    await sender.ev(`const previousCapture = navigator.mediaDevices.getDisplayMedia;
        navigator.mediaDevices.getDisplayMedia = async options => {
            const stream = await previousCapture(options);
            for (const track of stream.getAudioTracks()) { stream.removeTrack(track); track.stop(); }
            return stream;
        };`);
    await startScreenShare(sender);
    const silentScreenId = await sender.ev("rc.producerLabel.get('screenType')");
    await waitFor(first, `rc.consumersProducer.has(${JSON.stringify(silentScreenId)})`);
    assert.equal((await state(first, peerId)).muted, true);
    console.log('PASS restarting a share without audio resets the local mute');
    const gallery = await first.ev("fetch('/replay/api/clips').then(r => r.json())");
    assert.equal(gallery.retentionDays, null);
    assert.equal(gallery.retention.cleanupAtPercent, 80);
    console.log('PASS gallery API: no time expiry, cleanup at 80%');
} finally {
    chrome.close();
}
