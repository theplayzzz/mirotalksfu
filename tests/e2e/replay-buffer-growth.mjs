// The "time kept" counter of the replay button, for every kind of screen, and the silence of the replay feature.
//
// A person shares a screen (a game with constant motion, a desktop that changes little, or one that sits still between
// bursts of movement), a second person watches. Every `replayBuffers` the viewer receives is recorded, and the test
// checks that what the room says it keeps GROWS with the time the screen has been shared: a counter stuck at a few
// seconds, or going back to a few seconds, was the bug of 2026-10-03 (whole screen). It also records every sound the
// page tries to play (new Audio, play() of an audio file, an oscillator): replay must never make one.
//
//   MODE=game|desktop|idle   what is on the screen (default desktop)
//   SECONDS=75               how long to share (default 75; the "1 min" option needs 60+)
//   AUDIO=1                  share the sound too (a steady quiet tone)
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 30) node tests/e2e/replay-buffer-growth.mjs
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
const MODE = process.env.MODE || 'desktop';
const SECONDS = Number(process.env.SECONDS || 75);
const WITH_AUDIO = process.env.AUDIO === '1';

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

// Everything that could make a noise, recorded before the app runs
const soundSpy = `(() => {
    window.__sounds = [];
    const note = (what, src) => window.__sounds.push({ at: Math.round(performance.now()), what, src: String(src || '').slice(-80) });
    const NativeAudio = window.Audio;
    window.Audio = function (src) { note('new Audio', src); return new NativeAudio(src); };
    window.Audio.prototype = NativeAudio.prototype;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        const src = this.currentSrc || this.src || '';
        if (/\\.(wav|mp3|ogg|m4a|aac)(\\?|$)/i.test(src)) note('play() of a sound file', src);
        return play.apply(this, arguments);
    };
    for (const name of ['OscillatorNode', 'AudioBufferSourceNode']) {
        if (window[name]) {
            const start = window[name].prototype.start;
            window[name].prototype.start = function () { note(name + '.start', ''); return start.apply(this, arguments); };
        }
    }
    if (window.speechSynthesis) {
        const speak = window.speechSynthesis.speak.bind(window.speechSynthesis);
        window.speechSynthesis.speak = (utterance) => { note('speechSynthesis.speak', utterance && utterance.text); return speak(utterance); };
    }
})();`;

const watch = `(() => {
    window.__buffers = [];
    const timer = setInterval(() => {
        try {
            if (typeof socket === 'undefined' || !socket || typeof socket.on !== 'function' || socket.__growthWatched) return;
            socket.__growthWatched = true;
            socket.on('replayBuffers', (data) => window.__buffers.push({ at: Math.round(performance.now()), data }));
            clearInterval(timer);
        } catch (e) {}
    }, 10);
})();`;

const chrome = await launchChrome({ chrome: chromePath });
try {
    const sharer = await chrome.newPage();
    await sharer.send('Page.addScriptToEvaluateOnNewDocument', { source: soundSpy });
    await stubScreenCapture(sharer, { mode: MODE, withAudio: WITH_AUDIO, fps: MODE === 'game' ? 60 : 30 });
    await joinTestRoom(sharer, { origin, token, name: 'BG-Sharer' });

    const viewer = await chrome.newPage();
    await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: soundSpy });
    await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: watch });
    await joinTestRoom(viewer, { origin, token, name: 'BG-Viewer' });
    const clearSounds = () => Promise.all([sharer.ev('window.__sounds.length = 0; true'), viewer.ev('window.__sounds.length = 0; true')]);
    await clearSounds(); // joining makes the room's own sounds; what counts is what happens from the share on

    await startScreenShare(sharer);
    const startedAt = Date.now();
    // The room plays its own "joined" sound when a screen starts (that is old behaviour, for every screen). What must
    // stay silent is everything after that: the minute getting close, the option coming available, a clip saved.
    await sleep(8000);
    const atStart = { sharer: await sharer.ev('window.__sounds.map((s) => s.src.split("/").pop())'), viewer: await viewer.ev('window.__sounds.map((s) => s.src.split("/").pop())') };
    console.log('the room\'s own sounds when the screen started:', JSON.stringify(atStart));
    await clearSounds();
    console.log(`screen: ${MODE}${WITH_AUDIO ? ' + audio' : ''}, ${SECONDS} s`);

    const timeline = [];
    while (Date.now() - startedAt < SECONDS * 1000) {
        await sleep(5000);
        const last = await viewer.ev('(() => { const l = window.__buffers; return l.length ? l[l.length - 1].data : null; })()');
        const share = last && last.shares && last.shares[0];
        timeline.push({ since: Math.round((Date.now() - startedAt) / 1000), kept: share ? share.bufferSeconds : null, available: last ? last.available : null, hasAudio: share ? share.hasAudio : null });
    }
    console.log('seconds shared -> seconds kept (as the room says):');
    console.log('  ' + timeline.map((t) => `${t.since}->${t.kept === null ? 'none' : t.kept}`).join('  '));

    const kept = timeline.map((t) => t.kept).filter((k) => k !== null);
    check('the room lists the screen as kept', kept.length >= timeline.length - 2, `${kept.length} of ${timeline.length} reports`);
    const last = kept[kept.length - 1] ?? 0;
    check(`after ${SECONDS} s the room says about ${SECONDS} s are kept (not a few seconds)`, last >= SECONDS - 15, `${last} s`);
    let dropped = 0;
    for (let i = 1; i < kept.length; i++) if (kept[i] < kept[i - 1] - 1) dropped++;
    check('the counter never goes back', dropped === 0, `${dropped} times`);
    let stuck = 0;
    for (let i = 3; i < kept.length; i++) if (kept[i] === kept[i - 1] && kept[i - 1] === kept[i - 2] && kept[i - 2] === kept[i - 3]) stuck++;
    check('and does not stand still for 15 s while the screen is shared', stuck === 0, `${stuck} stretches`);
    if (SECONDS >= 65) {
        const popoverNote = last >= 60;
        check('the "1 minute" option comes available once a minute is kept', popoverNote, `${last} s kept`);
    }

    // What the recorder costs the live stream: every full picture the sender is asked for is a burst of bandwidth and
    // a spike of encoder work for the person sharing, and a hiccup for everybody watching. A recorder whose feed is
    // throttled by the server asks for them over and over (found 2026-10-03: a key frame every second).
    const sent = await sharer.ev(`(async () => { for (const p of rc.producers.values()) { if (p.kind !== 'video' || p.closed) continue; for (const s of (await p.getStats()).values()) if (s.type === 'outbound-rtp') return { keyFrames: s.keyFramesEncoded, plis: s.pliCount, firs: s.firCount, nacks: s.nackCount, frames: s.framesEncoded, width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond, limit: s.qualityLimitationReason }; } return null; })()`);
    const seen = await viewer.ev(`(async () => { for (const c of rc.consumers.values()) { if (c.kind !== 'video' || c.closed) continue; for (const s of (await c.getStats()).values()) if (s.type === 'inbound-rtp') return { keyFrames: s.keyFramesDecoded, frames: s.framesDecoded, freezes: s.freezeCount, plis: s.pliCount }; } return null; })()`);
    console.log('what the sender had to do:', JSON.stringify(sent));
    console.log('what the viewer saw:', JSON.stringify(seen));
    if (sent && MODE === 'game') {
        const minutes = SECONDS / 60;
        check('the sender is not asked for full pictures over and over (at most 8 per minute)', sent.keyFrames / minutes <= 8, `${sent.keyFrames} key frames in ${SECONDS} s, ${sent.plis} PLIs`);
    }

    const sounds = { sharer: await sharer.ev('window.__sounds'), viewer: await viewer.ev('window.__sounds') };
    console.log('sounds the pages tried to play after the first 8 s of the share:', JSON.stringify(sounds));
    check('nothing in the room makes a sound after the share has started (no beep near the minute, none when an option comes available)', sounds.sharer.length === 0 && sounds.viewer.length === 0, JSON.stringify(sounds).slice(0, 300));
} catch (error) {
    check('the test ran to the end', false, error.message);
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
