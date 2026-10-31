// Diagnostic on the DEVELOPMENT test room: a synthetic stereo tone has opposite phases in its two channels.
// Compare the application's current profile with an in-memory override of opusStereo only. Nothing is saved to
// app configuration. All camera/microphone devices are fake; the shared video is a small canvas.
// E2E_CHROME=... E2E_ORIGIN=... E2E_TOKEN=... node tests/e2e/audio-stereo-probe.mjs
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';
const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
if (!origin?.includes('mirotalk-dev.')) throw new Error('development only');
const chrome = await launchChrome({ chrome: chromePath, extraFlags: ['--use-fake-device-for-media-stream'] });
async function waitFor(page, code) {
    for (let i = 0; i < 100; i++) {
        if (await page.ev(code).catch(() => false)) return;
        await sleep(200);
    }
    throw new Error('timeout ' + code);
}
try {
    const sender = await chrome.newPage();
    await stubScreenCapture(sender, { width: 640, height: 360, fps: 10, withAudio: false });
    await joinTestRoom(sender, { origin, token, name: 'Audio-AB-Source' });
    await waitFor(sender, `rc.producerLabel.has('audioType')`);
    await sender.ev(
        `for(const type of ['audioType','videoType']) if(rc.producerLabel.has(type))rc.closeProducer(type);`
    );
    await sender.ev(`const rawCapture=navigator.mediaDevices.getDisplayMedia;
 navigator.mediaDevices.getDisplayMedia=async options=>{
  const stream=await rawCapture(options);const context=new AudioContext();await context.resume();
  const oscillator=context.createOscillator();oscillator.frequency.value=440;
  const left=context.createGain(),right=context.createGain();left.gain.value=0.15;right.gain.value=-0.15;
  const merger=context.createChannelMerger(2),destination=context.createMediaStreamDestination();
  oscillator.connect(left);oscillator.connect(right);left.connect(merger,0,0);right.connect(merger,0,1);
  merger.connect(destination);oscillator.start();
  stream.addTrack(destination.stream.getAudioTracks()[0]);window.__abContext=context;return stream;
 };`);
    const viewer = await chrome.newPage();
    await joinTestRoom(viewer, { origin, token, name: 'Audio-AB-Receiver' });
    await waitFor(viewer, `rc.producerLabel.has('audioType')`);
    await viewer.ev(
        `for(const type of ['audioType','videoType']) if(rc.producerLabel.has(type))rc.closeProducer(type);`
    );
    for (const profile of ['current', 'stereo-only']) {
        if (profile === 'stereo-only')
            await sender.ev(`const rawProduce=rc.producerTransport.produce.bind(rc.producerTransport);
   rc.producerTransport.produce=params=>rawProduce(params.appData?.source==='screen'?{...params,codecOptions:{opusStereo:true}}:params);`);
        await startScreenShare(sender);
        await waitFor(sender, `rc.producerLabel.has('audioTab')`);
        const audioProducerId = await sender.ev(`rc.producerLabel.get('audioTab')`);
        await viewer.ev(`window.__abAudioProducerId=${JSON.stringify(audioProducerId)}`);
        await waitFor(viewer, `[...rc.consumers.values()].some(c=>c.producerId===window.__abAudioProducerId)`);
        await sleep(3000);
        const sent = await sender.ev(`(async()=>{const p=rc.producers.get(rc.producerLabel.get('audioTab'));
   const sdp=rc.producerTransport._handler._pc.remoteDescription.sdp;
   const before=[...(await p.getStats()).values()].find(s=>s.type==='outbound-rtp');
   await new Promise(r=>setTimeout(r,2000));const after=[...(await p.getStats()).values()].find(s=>s.type==='outbound-rtp');
   return {appData:p.appData,track:p.track.getSettings(),codecs:p.rtpParameters.codecs,
    bitrate:Math.round((after.bytesSent-before.bytesSent)*8000/(after.timestamp-before.timestamp)),
    opusAnswer:sdp.split('\\r\\n').filter(l=>/fmtp:.*(minptime|stereo|useinbandfec)/.test(l))};})()`);
        console.log('SENT', JSON.stringify({ profile, sent }));
        const received =
            await viewer.ev(`(async()=>{const c=[...rc.consumers.values()].find(c=>c.producerId===window.__abAudioProducerId);
   const context=new AudioContext();await context.resume();const source=context.createMediaStreamSource(new MediaStream([c.track]));
   const splitter=context.createChannelSplitter(2),left=context.createAnalyser(),right=context.createAnalyser(),silent=context.createGain();
   silent.gain.value=0;source.connect(splitter);splitter.connect(left,0);splitter.connect(right,1);left.connect(silent);right.connect(silent);silent.connect(context.destination);
   await new Promise(r=>setTimeout(r,500));const l=new Float32Array(2048),r=new Float32Array(2048);left.getFloatTimeDomainData(l);right.getFloatTimeDomainData(r);
   const rms=v=>Math.sqrt(v.reduce((s,x)=>s+x*x,0)/v.length);
   const allStats=[...(await c.getStats()).values()];const stats=allStats.find(s=>s.type==='inbound-rtp')||{};
   const result={rmsLeft:rms(l),rmsRight:rms(r),packetsLost:stats.packetsLost,packetsReceived:stats.packetsReceived,
    concealedSamples:stats.concealedSamples,totalSamplesReceived:stats.totalSamplesReceived,concealmentEvents:stats.concealmentEvents,statTypes:allStats.map(s=>s.type)};
   await context.close();return result;})()`);
        console.log(JSON.stringify({ profile, sent, received }));
        await sender.ev(`rc.closeProducer('screenType');window.__abContext.close()`);
        await waitFor(viewer, '!rc.consumersProducer.has(window.__abAudioProducerId)');
    }
} finally {
    chrome.close();
}
