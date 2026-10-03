// Replay, end to end, on the development instance with the REAL parts: a sharer streams a 1080p60 animation with a
// clap board (white flash + beep every 2 s) and its audio, a viewer in the room asks for a clip, and the test follows
// the clip all the way: the room's sockets, the recorder, the gallery API, the file (ffprobe, decoding, sync of
// picture and sound), the MP4 conversion, the gallery page, and what must be refused.
//
//   needs REPLAY_ENABLED on the instance, ffmpeg + ffprobe on this PC
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 30) node tests/e2e/replay-flow.mjs
//   OUT_DIR=...   where the clip, the MP4 and the screenshot are kept (default: the temp folder)
//   SKIP_UI=1     skip the part that clicks the button in the room (it needs 65 s of buffer, so it takes longer)
//   RESIZE=1      the sender's picture changes size while it is being kept (what the sender guard does when it lowers a rung):
//                 the clip that covers the change has to decode, convert and play like any other
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';
import { beepOnsets, decodeErrors, download, flashOnsets, median, probe, probeJson, waitFor } from './media.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const OUT_DIR = process.env.OUT_DIR || path.join(tmpdir(), 'replay-flow');
mkdirSync(OUT_DIR, { recursive: true });

// CODEC=h264 for an instance set to SCREEN_CODEC=h264: the clip is then an MP4 from the start (nothing to convert)
const CODEC = process.env.CODEC || 'vp8';
const FAST_CLIP_SECONDS = 30;
const FAST_BUFFER_NEEDED = 40;
const UI_CLIP_SECONDS = 60;
const UI_BUFFER_NEEDED = 66;

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};
const note = (text) => console.log(`      ${text}`);

// ---- helpers ---------------------------------------------------------------------------------------------------

// Every sound a page tries to play (the room's own sounds are files played with new Audio): replay must make none
const soundSpy = `(() => {
    window.__sounds = [];
    const note = (what, src) => window.__sounds.push({ at: Math.round(performance.now()), what, src: String(src || '').slice(-80) });
    const NativeAudio = window.Audio;
    window.Audio = function (src) { note('new Audio', src); return new NativeAudio(src); };
    window.Audio.prototype = NativeAudio.prototype;
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

// Installed in the viewer before the app runs: every replay event of the socket and every event of the gallery stream
const instrument = `(() => {
    window.__replay = { ticket: [], buffers: [], status: [], created: [] };
    const timer = setInterval(() => {
        try {
            if (typeof socket === 'undefined' || !socket || typeof socket.on !== 'function' || socket.__replayWatched) return;
            socket.__replayWatched = true;
            const keep = (list) => (data) => window.__replay[list].push({ t: performance.now(), data });
            socket.on('replayTicket', keep('ticket'));
            socket.on('replayBuffers', keep('buffers'));
            socket.on('replayStatus', keep('status'));
            socket.on('replayCreated', keep('created'));
            clearInterval(timer);
        } catch (e) {}
    }, 20);
})();`;

const latest = (page, list) => page.ev(`(() => { const l = window.__replay.${list}; return l.length ? l[l.length - 1].data : null; })()`);

const statsScript = `(async () => {
    for (const c of rc.consumers.values()) {
        if (c.kind !== 'video' || c.closed) continue;
        for (const s of (await c.getStats()).values()) {
            if (s.type === 'inbound-rtp' && s.kind === 'video') return { t: s.timestamp, bytes: s.bytesReceived, frames: s.framesDecoded, freezes: s.freezeCount || 0 };
        }
    }
    return null;
})()`;

async function measure(page, seconds) {
    const a = await page.ev(statsScript);
    await sleep(seconds * 1000);
    const b = await page.ev(statsScript);
    if (!a || !b) return { mbps: 0, fps: 0, freezes: 0 };
    const dt = (b.t - a.t) / 1000;
    return { mbps: Math.round(((b.bytes - a.bytes) * 8) / 1e5 / dt) / 10, fps: Math.round((b.frames - a.frames) / dt), freezes: b.freezes - a.freezes };
}

// ---- the test --------------------------------------------------------------------------------------------------

// HEADED=1: a real window, with the graphics card (needed for its hardware encoder, which is what SCREEN_CODEC=auto picks)
const chrome = await launchChrome({ chrome: chromePath, headless: process.env.HEADED !== '1', lowPriority: process.env.LOW === '1' });
try {
    // 1. the sharer: a screen with sound and a clap board
    const sharer = await chrome.newPage();
    await stubScreenCapture(sharer, { withAudio: true, claquete: true });
    await joinTestRoom(sharer, { origin, token, name: 'RF-Sharer' });
    const config = await sharer.ev("fetch('/config').then((r) => r.json())");
    check('the server announces replay to the browsers', config.replay && config.replay.enabled === true && Array.isArray(config.replay.options), JSON.stringify(config.replay));
    await startScreenShare(sharer);
    // (the room also starts the microphone on its own, so wait for the audio that says it belongs to the screen)
    const producers = await waitFor('the screen audio producer', () => sharer.ev("[...rc.producers.values()].filter((p) => !p.closed).map((p) => ({ id: p.id, kind: p.kind, appData: p.appData }))").then((list) => (list.some((p) => p.kind === 'audio' && p.appData && p.appData.source === 'screen') ? list : null)), 20);
    const screen = producers.find((p) => p.kind === 'video');
    // the room also starts the microphone on its own, so the screen's audio is the one that says it is
    const screenAudio = producers.find((p) => p.kind === 'audio' && p.appData && p.appData.source === 'screen');
    check('the screen\'s audio says which screen it belongs to', !!screenAudio && screenAudio.appData.shareOf === screen.id, JSON.stringify(producers.filter((p) => p.kind === 'audio').map((p) => p.appData)));
    check('the microphone is not taken for part of the screen', producers.filter((p) => p.kind === 'audio' && !(p.appData && p.appData.source === 'screen')).every((p) => !p.appData.shareOf));

    // 2. the viewer
    const viewer = await chrome.newPage();
    await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: soundSpy });
    await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: instrument });
    await joinTestRoom(viewer, { origin, token, name: 'RF-Viewer' });
    const ticket = await waitFor('the replay ticket', () => latest(viewer, 'ticket'), 10).catch(async (error) => {
        note(`no ticket seen; page state: ${JSON.stringify(await viewer.ev("({ replay: window.__replay && Object.fromEntries(Object.entries(window.__replay).map(([k, v]) => [k, v.length])), socket: typeof socket, same: typeof socket !== 'undefined' && socket === rc.socket, connected: rc.socket.connected })"))}`);
        throw error;
    });
    check('the person gets a ticket for the gallery', typeof ticket.ticket === 'string' && ticket.ticket.length >= 20 && ticket.expiresAt > Date.now(), `expires in ${Math.round((ticket.expiresAt - Date.now()) / 1000)} s`);
    const sessionOk = await waitFor('the gallery session', () => viewer.ev("fetch('/replay/api/me').then((r) => r.status === 200)"), 10, 300).catch(() => false);
    check('the room opens the person\'s gallery session by itself (the ticket is exchanged)', sessionOk === true);
    check('the gallery refuses a browser that has no session', (await fetch(`${origin}/replay/api/clips`)).status === 401);

    // 3. the room is told which screens are being kept
    const share = await waitFor('the screen in replayBuffers', async () => {
        const buffers = await latest(viewer, 'buffers');
        return buffers && buffers.shares.find((s) => s.producerId === screen.id && s.hasAudio) ? buffers : null;
    }, 45).then((b) => b.shares.find((s) => s.producerId === screen.id)).catch(() => null);
    check('the room is told the screen is being kept, with its audio', !!share, share ? JSON.stringify(share) : 'not listed');
    if (!share) throw new Error('the screen never showed up in replayBuffers: nothing else can be tested');
    check(`it is a ${CODEC.toUpperCase()} screen shared by the right person`, share.codec === CODEC && share.peerName === 'RF-Sharer', `${share.codec} ${share.peerName}`);

    // 4. what recording costs the people watching: nothing. (A person who joins a screen that is already being shared
    // waits for the next full picture: usually 1-2 s, now and then ~10 s while the sender is still ramping up.)
    await waitFor('the first picture at the viewer', () => viewer.ev("(async () => { for (const c of rc.consumers.values()) { if (c.kind !== 'video' || c.closed) continue; for (const s of (await c.getStats()).values()) if (s.type === 'inbound-rtp' && s.framesDecoded > 0) return true; } return false; })()"), 40, 500);
    await sleep(8000);
    await viewer.ev('window.__sounds.length = 0; true'); // the room's own sounds of joining are behind us
    const live = await measure(viewer, 10);
    note(`the viewer, with the recorder running: ${JSON.stringify(live)}`);
    check('the viewer still gets a full frame rate while the recorder runs', live.fps >= 50, JSON.stringify(live));
    check('and no freezes', live.freezes === 0, `${live.freezes}`);
    if (process.env.RESIZE === '1') {
        // the encoder starts a new size at a key frame: the picture goes from 1920x1080 to 1280x720 in the middle of the buffer
        const scale = await sharer.ev("(async () => { const p = [...rc.producers.values()].find((x) => x.kind === 'video' && !x.closed); await p.setRtpEncodingParameters({ scaleResolutionDownBy: 1.5 }); return p.rtpSender.getParameters().encodings[0].scaleResolutionDownBy; })()");
        note(`the sender's picture is now 1/${scale} of its size`);
    }

    // 5. the buffer grows
    const grown = await waitFor(`${FAST_BUFFER_NEEDED} s of buffer`, async () => {
        const buffers = await latest(viewer, 'buffers');
        const s = buffers && buffers.shares.find((x) => x.producerId === screen.id);
        return s && s.bufferSeconds >= FAST_BUFFER_NEEDED ? s : null;
    }, 90, 1000);
    check('the buffer reports how much of the screen is kept', grown.bufferSeconds >= FAST_BUFFER_NEEDED, `${grown.bufferSeconds} s`);

    // 6. what must be refused
    const ask = (data) => viewer.ev(`new Promise((resolve) => socket.emit('replayRequest', ${JSON.stringify(data)}, resolve))`);
    const tooShort = await ask({ producerId: screen.id, seconds: 5 });
    check('a clip shorter than 10 s is refused', tooShort.code === 'BAD_SECONDS', JSON.stringify(tooShort));
    const nothing = await ask({ producerId: 'not-a-screen', seconds: 30 });
    check('a screen that is not being kept is refused', nothing.code === 'NO_SUCH_SHARE', JSON.stringify(nothing));
    const injection = await ask({ producerId: { $ne: 1 }, seconds: '30; rm -rf' });
    check('nonsense in the request is refused, not crashed on', !!injection.error, JSON.stringify(injection));
    const bareEmit = await viewer.ev("new Promise((resolve) => { socket.emit('replayRequest'); setTimeout(() => resolve('no crash'), 300); })");
    check('a request with no data and no callback is ignored', bareEmit === 'no crash');

    // 7. a clip, asked through the socket
    const startedAt = Date.now();
    const answer = await ask({ producerId: screen.id, seconds: FAST_CLIP_SECONDS });
    check('the request is accepted', answer.ok === true && typeof answer.requestId === 'string', JSON.stringify(answer));
    const again = await ask({ producerId: screen.id, seconds: FAST_CLIP_SECONDS });
    check('asking again at once is refused (one request per 3 s)', again.code === 'RATE_LIMIT', JSON.stringify(again));
    const done = await waitFor('the clip', async () => {
        const status = await viewer.ev(`window.__replay.status.map((s) => s.data).filter((s) => s.requestId === ${JSON.stringify(answer.requestId)})`);
        return status.find((s) => s.state === 'done' || s.state === 'error') || null;
    }, 30, 200);
    const took = Date.now() - startedAt;
    check('the clip is ready', done.state === 'done', JSON.stringify(done).slice(0, 300));
    if (done.state !== 'done') throw new Error('no clip');
    note(`the clip took ${took} ms from the click to "done"`);
    // (an H.264 screen's clip is an MP4: its sound is converted to AAC and the index moved to the front, a little longer)
    const targetMs = CODEC === 'h264' ? 6000 : 3000;
    check(`it is ready in under ${targetMs / 1000} s`, took < targetMs, `${took} ms`);
    const clip = done.clip;
    note(`clip ${clip.id}: ${JSON.stringify({ seconds: clip.seconds, durationS: clip.durationS, startOffsetS: clip.startOffsetS, codec: clip.codec, hasAudio: clip.hasAudio, files: clip.files })}`);
    check('the clip says whose screen it is and who saved it', clip.sharer === 'RF-Sharer' && clip.requestedBy === 'RF-Viewer', `${clip.sharer} / ${clip.requestedBy}`);
    check('the clip is mine for who saved it, and shows no hashes', clip.mine === true && !JSON.stringify(clip).includes('Hash'));
    check('the file is as long as asked plus a lead-in before the first key frame', clip.durationS - clip.startOffsetS >= FAST_CLIP_SECONDS - 3 && clip.durationS - clip.startOffsetS <= FAST_CLIP_SECONDS + 3, `${clip.durationS - clip.startOffsetS} s of ${FAST_CLIP_SECONDS}`);
    const createdForRoom = await waitFor('replayCreated', () => latest(viewer, 'created'), 5).catch(() => null);
    check('the room is told a clip was saved', !!createdForRoom && createdForRoom.clip.id === clip.id && createdForRoom.requestedBy === 'RF-Viewer');

    // 8. the file
    const cookies = (await viewer.send('Network.getCookies', { urls: [`${origin}/replay/`] })).result.cookies;
    const access = cookies.find((c) => c.name === 'replay_access');
    check('the gallery cookie is HttpOnly, Secure, SameSite and only for /replay/', !!access && access.httpOnly && access.secure && access.sameSite === 'Lax' && access.path === '/replay/', access ? JSON.stringify({ httpOnly: access.httpOnly, secure: access.secure, sameSite: access.sameSite, path: access.path }) : 'no cookie');
    const peerUuid = await viewer.ev("localStorage.getItem('peer_uuid')");
    const auth = { cookie: `replay_access=${access.value}`, 'x-replay-peer': peerUuid || '' };
    const original = clip.files.original;
    const file = path.join(OUT_DIR, original.name);
    const got = await download(`${origin}/replay/media/${clip.id}/${original.name}`, file, auth);
    check('the original downloads', got.size === original.bytes, `${got.size} of ${original.bytes} bytes`);

    const info = probeJson(file);
    check('ffprobe reads it', !!info);
    if (info) {
        const video = info.streams.find((s) => s.codec_type === 'video');
        const audio = info.streams.find((s) => s.codec_type === 'audio');
        check(`it has ${CODEC.toUpperCase()} video`, video && video.codec_name === CODEC, video && `${video.codec_name} ${video.width}x${video.height}`);
        // an MP4 carries AAC (Opus in MP4 is not something every player opens), so an H.264 screen's clip has it
        const audioCodec = CODEC === 'h264' ? 'aac' : 'opus';
        check(`it has ${audioCodec === 'aac' ? 'AAC' : 'Opus'} audio`, audio && audio.codec_name === audioCodec, audio && `${audio.codec_name} ${audio.channels} ch`);
        const duration = Number(info.format.duration);
        check('its duration is what the metadata says', Math.abs(duration - clip.durationS) < 1.5, `${duration} s vs ${clip.durationS} s`);
        note(`container: ${info.format.format_name}, ${duration.toFixed(1)} s, ${(Number(info.format.bit_rate) / 1e6).toFixed(1)} Mbps`);
    }
    const firstPacket = probe(file, '-select_streams', 'v:0', '-show_entries', 'packet=flags', '-read_intervals', '%+#1', '-of', 'csv=p=0');
    check('it starts with a key frame', !!firstPacket && firstPacket.trim().startsWith('K'), firstPacket && firstPacket.trim());
    const errors = decodeErrors(file);
    check('it decodes from start to end without a single error', errors === '', errors.slice(0, 300));
    if (process.env.RESIZE === '1') {
        const sizes = new Set((probe(file, '-select_streams', 'v:0', '-show_entries', 'frame=width,height', '-of', 'csv=p=0') || '').split(/\r?\n/).filter(Boolean));
        check('the clip holds both sizes of the picture (the resize happened inside it)', sizes.size >= 2, [...sizes].join(' | '));
    }
    const counted = probe(file, '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0');
    const frames = counted ? Number(counted.trim()) : 0;
    note(`${frames} frames over ${clip.durationS} s = ${(frames / clip.durationS).toFixed(1)} fps`);
    check('it has a real frame rate (no gaps)', frames / clip.durationS >= 20, `${(frames / clip.durationS).toFixed(1)} fps`);

    // 9. picture and sound together (the clap board)
    const flashes = flashOnsets(file);
    const beeps = beepOnsets(file);
    const offsets = [];
    for (const flash of flashes) {
        const nearest = beeps.reduce((best, beep) => (Math.abs(beep - flash) < Math.abs(best - flash) ? beep : best), Infinity);
        if (Math.abs(nearest - flash) < 0.6) offsets.push(Math.round((nearest - flash) * 1000));
    }
    note(`clap board: ${flashes.length} flashes, ${beeps.length} beeps, offsets (sound minus picture, ms): ${JSON.stringify(offsets)}`);
    check('the clap board shows up in the clip: about one flash and one beep every 2 s', flashes.length >= FAST_CLIP_SECONDS / 2 - 3 && beeps.length >= FAST_CLIP_SECONDS / 2 - 3, `${flashes.length} flashes, ${beeps.length} beeps`);
    // The recorder places every frame by the time mediasoup forwarded it. For the first ~25 s of a share the sender's
    // video waits in its own queue while its bandwidth estimate grows, so the picture arrives up to ~300 ms after the
    // sound that belongs to it (live viewers get the same); after that the two are within ~15 ms. A clip of a share
    // that has been running for a while is all in the second state, so that is what is judged; the start is reported.
    const settled = offsets.slice(Math.ceil(offsets.length / 2));
    note(`the first half of the clip (the sender still ramping up): median ${median(offsets.slice(0, Math.ceil(offsets.length / 2)))} ms; the second half: median ${median(settled)} ms`);
    const typical = median(settled);
    check('once the sender has settled, picture and sound are less than 80 ms apart (median)', typical !== null && Math.abs(typical) < 80, `${typical} ms`);
    check('and never more than 150 ms apart', settled.length > 0 && settled.every((o) => Math.abs(o) < 150), `worst ${Math.max(...settled.map(Math.abs))} ms`);

    // 10. the gallery API
    const list = await (await fetch(`${origin}/replay/api/clips`, { headers: auth })).json();
    const listed = list.clips.find((c) => c.id === clip.id);
    check('the gallery lists the clip, marked as mine, with no hashes', !!listed && listed.mine === true && !JSON.stringify(list).includes('Hash'));
    const stranger = await (await fetch(`${origin}/replay/api/clips`, { headers: { ...auth, 'x-replay-peer': 'somebody-else' } })).json();
    check('somebody else sees it as not theirs', stranger.clips.find((c) => c.id === clip.id)?.mine === false);
    const range = await fetch(`${origin}/replay/media/${clip.id}/${original.name}`, { headers: { ...auth, range: 'bytes=0-99' } });
    check('the player can seek: a Range request gets 206 with the right header', range.status === 206 && /^bytes 0-99\//.test(range.headers.get('content-range') || '') && (await range.arrayBuffer()).byteLength === 100, `${range.status} ${range.headers.get('content-range')}`);
    const download1 = await fetch(`${origin}/replay/media/${clip.id}/${original.name}?download=1`, { headers: { ...auth, range: 'bytes=0-9' } });
    check('the download link asks the browser to save the file, with a readable name', /^attachment; filename="replay-RF-Sharer-\d{8}-\d{6}\.(webm|mp4)"$/.test(download1.headers.get('content-disposition') || ''), download1.headers.get('content-disposition'));
    const thumb = await fetch(`${origin}/replay/media/${clip.id}/thumb.jpg`, { headers: auth });
    check('the thumbnail is a JPEG', thumb.status === 200 && thumb.headers.get('content-type') === 'image/jpeg' && (await thumb.arrayBuffer()).byteLength > 500, `${thumb.status} ${thumb.headers.get('content-type')}`);

    // 11. what must be refused
    check('the media needs the session', (await fetch(`${origin}/replay/media/${clip.id}/${original.name}`)).status === 401);
    check('only the known file names are served', (await fetch(`${origin}/replay/media/${clip.id}/meta.json`, { headers: auth })).status === 404);
    check('a clip id cannot walk out of the folder', [(await fetch(`${origin}/replay/media/..%2f..%2fbuffers/clip.webm`, { headers: auth })).status, (await fetch(`${origin}/replay/media/${clip.id}/..%2fmeta.json`, { headers: auth })).status].every((s) => s === 404 || s === 400));
    check('the recorder\'s event door is closed to the outside', (await fetch(`${origin}/internal/replay/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"buffers","shares":[]}' })).status === 401);
    check('a wrong password does not open the gallery', (await fetch(`${origin}/replay/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'not-the-password' }) })).status === 401);
    check('the ticket works once only', (await fetch(`${origin}/replay/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: ticket.ticket }) })).status === 401);

    // 12. MP4, with progress, seen on the live stream the gallery uses
    await viewer.ev(`(() => { window.__sse = []; const source = new EventSource('/replay/api/stream'); window.__source = source; for (const type of ['clip.created', 'clip.deleted', 'mp4.progress', 'mp4.ready', 'mp4.error']) source.addEventListener(type, (e) => window.__sse.push({ type, data: JSON.parse(e.data) })); })()`);
    await sleep(500);
    const mp4Started = Date.now();
    const mp4Start = await (await fetch(`${origin}/replay/api/clips/${clip.id}/mp4`, { method: 'POST', headers: auth })).json();
    note(`MP4 start: ${JSON.stringify(mp4Start)}`);
    check('starting the MP4 answers with its state and an estimate', ['ready', 'queued', 'running'].includes(mp4Start.state), JSON.stringify(mp4Start));
    // an H.264 screen makes an MP4 from the start: the answer is "ready" at once and there is nothing to wait for
    const already = mp4Start.state === 'ready';
    const mp4Done = already
        ? { type: 'mp4.ready', data: { id: clip.id } }
        : await waitFor('the MP4', async () => {
              const events = await viewer.ev('window.__sse');
              return events.find((e) => (e.type === 'mp4.ready' || e.type === 'mp4.error') && e.data.id === clip.id) || null;
          }, 240, 500);
    const events = await viewer.ev('window.__sse');
    const progress = events.filter((e) => e.type === 'mp4.progress' && e.data.id === clip.id).map((e) => e.data.progress);
    note(`MP4 ${already ? 'was ready from the start' : `took ${Math.round((Date.now() - mp4Started) / 1000)} s; ${progress.length} progress events: ${JSON.stringify(progress.slice(0, 12))}`}`);
    check('the MP4 is ready', mp4Done.type === 'mp4.ready', JSON.stringify(mp4Done.data));
    if (!already) check('progress was reported, between 0 and 1, never going back', progress.length >= 1 && progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1])), JSON.stringify(progress));
    const mp4File = path.join(OUT_DIR, 'clip.mp4');
    const mp4Got = await download(`${origin}/replay/media/${clip.id}/clip.mp4?download=1`, mp4File, auth);
    const mp4Info = probeJson(mp4File);
    check('the MP4 downloads and ffprobe reads it', !!mp4Info, `${mp4Got.size} bytes`);
    if (mp4Info) {
        const video = mp4Info.streams.find((s) => s.codec_type === 'video');
        const audio = mp4Info.streams.find((s) => s.codec_type === 'audio');
        check('it is H.264 + AAC, which every player opens', video && video.codec_name === 'h264' && audio && audio.codec_name === 'aac', `${video && video.codec_name}/${audio && audio.codec_name}`);
        check('at the size asked for (720p by default)', video && video.height <= 720, video && `${video.width}x${video.height}`);
        // converted: cut to what was asked; an MP4 that came from an H.264 screen keeps the lead-in (the player hides it)
        const expected = already ? clip.durationS : clip.seconds;
        check(already ? 'with the length of the file of the clip' : 'with the length that was asked for (the lead-in is cut off, not kept)', Math.abs(Number(mp4Info.format.duration) - expected) < 3, `${Number(mp4Info.format.duration).toFixed(1)} s vs ${expected} s`);
        const head = spawnSync(FFPROBE, ['-v', 'trace', mp4File], { encoding: 'utf8', maxBuffer: 1 << 28 }).stderr;
        const moov = head.indexOf("type:'moov'");
        const mdat = head.indexOf("type:'mdat'");
        check('it starts playing before it is fully downloaded (faststart: the index is at the front)', moov > 0 && mdat > 0 && moov < mdat, `moov@${moov} mdat@${mdat}`);
        check('it decodes without errors', decodeErrors(mp4File) === '');
    }
    const mp4Again = await (await fetch(`${origin}/replay/api/clips/${clip.id}/mp4`, { method: 'POST', headers: auth })).json();
    check('asking for the MP4 again just says it is ready (nothing is converted twice)', mp4Again.state === 'ready', JSON.stringify(mp4Again));

    // 13. the gallery page, as a person sees it
    const gallery = await chrome.newPage();
    await gallery.send('Page.navigate', { url: `${origin}/replay/?clip=${clip.id}&from=room` });
    const played = await waitFor('the player', () => gallery.ev("(() => { const v = document.getElementById('rpVideo'); return v && v.readyState >= 2 ? { ready: v.readyState, duration: v.duration, width: v.videoWidth } : null; })()"), 30, 500).catch(() => null);
    check('the gallery page opens the clip in its player', !!played, JSON.stringify(played));
    if (played) {
        await gallery.ev("document.getElementById('rpVideo').play().catch(() => {})");
        await sleep(2500);
        const progressed = await gallery.ev("(() => { const v = document.getElementById('rpVideo'); return { time: v.currentTime, paused: v.paused, started: v.currentTime > 0 }; })()");
        check('it plays', progressed.started && !progressed.paused, JSON.stringify(progressed));
        check('the timeline starts where the clip was asked to start (the lead-in is hidden)', progressed.time >= clip.startOffsetS - 0.5, `at ${progressed.time.toFixed(1)} s, start offset ${clip.startOffsetS} s`);
        const shot = (await gallery.send('Page.captureScreenshot', { format: 'png' })).result.data;
        const { writeFileSync } = await import('node:fs');
        writeFileSync(path.join(OUT_DIR, 'gallery-player.png'), Buffer.from(shot, 'base64'));
    }
    await gallery.close();

    // 14. through the button in the room, like a person
    if (!process.env.SKIP_UI) {
        const ready = await waitFor(`${UI_BUFFER_NEEDED} s of buffer`, async () => {
            const buffers = await latest(viewer, 'buffers');
            const s = buffers && buffers.shares.find((x) => x.producerId === screen.id);
            return s && s.bufferSeconds >= UI_BUFFER_NEEDED ? s : null;
        }, 120, 1000).catch(() => null);
        check('the buffer grows past a minute', !!ready, ready ? `${ready.bufferSeconds} s` : 'it did not');
        const quiet = await viewer.ev('window.__sounds');
        check('and no sound is made while the time kept grows past a minute (no beep when the 1 minute option comes available)', quiet.length === 0, JSON.stringify(quiet));
        await sleep(3500); // the rate limit of one request per 3 s
        const button = await viewer.ev(`(() => { const b = document.getElementById(${JSON.stringify(screen.id + '__replay')}); return b ? { hidden: b.hidden, disabled: b.getAttribute('aria-disabled'), label: b.getAttribute('aria-label') } : null; })()`);
        check('the replay button is on the screen\'s tile', !!button && button.hidden === false && button.disabled === 'false', JSON.stringify(button));
        await viewer.ev(`document.getElementById(${JSON.stringify(screen.id + '__replay')}).click()`);
        await sleep(400);
        const popover = await viewer.ev("(() => { const p = document.getElementById('replayPopover'); return p ? [...p.querySelectorAll('.replay-opt')].map((o) => ({ s: o.dataset.seconds, disabled: o.getAttribute('aria-disabled') })) : null; })()");
        check('the popover offers 1, 2, 3 and 5 minutes', !!popover && popover.map((o) => o.s).join() === '60,120,180,300', JSON.stringify(popover));
        check('1 minute is available, longer ones are disabled for now', popover && popover[0].disabled === 'false' && popover[3].disabled === 'true', JSON.stringify(popover));
        const before = (await (await fetch(`${origin}/replay/api/clips`, { headers: auth })).json()).clips.length;
        await viewer.ev('window.__sounds.length = 0; true'); // from here on, nothing may make a noise
        await viewer.ev("document.querySelector('#replayPopover .replay-opt[data-seconds=\"60\"]').click()");
        const toast = await waitFor('the "saved" notice', () => viewer.ev("(() => { const t = [...document.querySelectorAll('.replay-toast')].map((n) => n.textContent.trim()); return t.some((x) => /salvo/i.test(x)) ? t : null; })()"), 20, 300).catch(() => null);
        check('the room says the replay was saved, with a link to see it', !!toast, JSON.stringify(toast));
        await sleep(1500);
        const noises = await viewer.ev('window.__sounds');
        check('saving a replay makes no sound at all (not the click, not the "generating", not the "saved")', noises.length === 0, JSON.stringify(noises));
        const after = (await (await fetch(`${origin}/replay/api/clips`, { headers: auth })).json()).clips;
        check('and the gallery has one more clip', after.length === before + 1, `${before} -> ${after.length}`);
        const uiClip = after[0];
        check('of a minute, from the right screen', uiClip && uiClip.seconds === UI_CLIP_SECONDS && uiClip.sharer === 'RF-Sharer', uiClip && `${uiClip.seconds} s ${uiClip.sharer}`);
        const link = await viewer.ev("(() => { const a = document.querySelector('.replay-toast a'); return a ? a.getAttribute('href') : null; })()");
        check('the notice links to this clip in the gallery', !!link && link.includes(uiClip.id), link);
        if (uiClip) await fetch(`${origin}/replay/api/clips/${uiClip.id}`, { method: 'DELETE', headers: auth });
    }

    // 15. deleting
    const forbidden = await fetch(`${origin}/replay/api/clips/${clip.id}`, { method: 'DELETE', headers: { ...auth, 'x-replay-peer': 'a-third-party' } });
    check('somebody who neither saved the clip nor shared the screen cannot delete it', forbidden.status === 403, `${forbidden.status}`);
    const gone = await fetch(`${origin}/replay/api/clips/${clip.id}`, { method: 'DELETE', headers: auth });
    check('who saved it can', gone.status === 200, `${gone.status}`);
    const deletedEvent = await waitFor('clip.deleted', async () => (await viewer.ev('window.__sse')).find((e) => e.type === 'clip.deleted' && e.data.id === clip.id), 10, 300).catch(() => null);
    check('the gallery\'s live stream announces it', !!deletedEvent);
    check('it is gone from the list and from the media route', (await (await fetch(`${origin}/replay/api/clips`, { headers: auth })).json()).clips.every((c) => c.id !== clip.id) && (await fetch(`${origin}/replay/media/${clip.id}/${original.name}`, { headers: auth })).status === 404);

    // 16. the sharer stops: the screen is no longer offered
    // like the stop button does: it tells the server, which closes the producers (closing the browser's objects would not)
    await sharer.ev("(() => { rc.closeProducer('screenType'); rc.closeProducer('audioTab'); return true; })()");
    const stopped = await waitFor('the screen to leave replayBuffers', async () => {
        const buffers = await latest(viewer, 'buffers');
        return buffers && !buffers.shares.some((s) => s.producerId === screen.id) ? buffers : null;
    }, 20, 500).catch(() => null);
    check('when the sharer stops, the screen is no longer offered', !!stopped);
} catch (error) {
    check('the test ran to the end', false, error.message);
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
console.log(`files kept in ${OUT_DIR}`);
process.exit(failures ? 1 : 0);
