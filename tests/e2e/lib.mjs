// Shared helpers for the end-to-end tests: a headless Chrome driven over CDP, a static server for the page
// that plays the "game" being shared, and a join that uses the development test room token in the URL
// (no password is ever typed). Needs Node 22+ and a local Chrome.
import { spawn } from 'node:child_process';
import { createReadStream, mkdtempSync, statSync } from 'node:fs';
import http from 'node:http';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the page that plays the shared content -------------------------------------------------------------------

export async function serveAssets(dir = path.join(here, 'assets')) {
    const types = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.js': 'text/javascript' };
    const server = http.createServer((req, res) => {
        const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (!file.startsWith(dir)) return res.writeHead(403).end();
        let size;
        try {
            const stat = statSync(file);
            if (stat.isDirectory()) return res.writeHead(404).end();
            size = stat.size;
        } catch {
            return res.writeHead(404).end();
        }
        const type = types[path.extname(file)] || 'application/octet-stream';
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2] ? Number(range[2]) : size - 1;
            res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
            return createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        createReadStream(file).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// ---- Chrome over CDP -------------------------------------------------------------------------------------------

export async function cdp(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => (ws.onopen = resolve));
    let id = 0;
    const pending = new Map();
    ws.onmessage = (message) => {
        const data = JSON.parse(message.data);
        if (data.id && pending.has(data.id)) {
            pending.get(data.id)(data);
            pending.delete(data.id);
        }
    };
    const send = (method, params = {}) =>
        new Promise((resolve) => {
            const i = ++id;
            pending.set(i, resolve);
            ws.send(JSON.stringify({ id: i, method, params }));
        });
    const ev = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
        if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
        return r.result?.result?.value;
    };
    const click = async (x, y) => {
        for (const type of ['mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        }
    };
    return { ws, send, ev, click };
}

// `headless: false` opens a real window (it has access to the graphics card, a headless Chrome has not: the hardware
// encoders and decoders are only there). `lowPriority`: the browser runs below the normal priority, so a test that has
// to run on the PC of a person who is playing does not take the game's CPU (what a test measures is then less exact:
// do not use it for a comparison of speeds).
export async function launchChrome({ chrome, tabCaptureTitle = 'E2ESRC', extraFlags = [], width = 1920, height = 1080, headless = true, lowPriority = false }) {
    const port = 9300 + Math.floor(Math.random() * 90);
    const profile = mkdtempSync(path.join(tmpdir(), 'e2e-chrome-'));
    const proc = spawn(
        chrome,
        [
            // --mute-audio: the pages of a test play the sound of the screens they receive (a steady tone, the beeps of the
            // clap board every 2 s) and a headless Chrome sends it to the speakers of whoever runs the test. Never again.
            ...(headless ? ['--headless=new'] : ['--window-position=-32000,-32000']),
            '--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
            '--no-default-browser-check', '--use-fake-ui-for-media-stream', `--auto-select-tab-capture-source-by-title=${tabCaptureTitle}`,
            '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows', `--window-size=${width},${height}`, ...extraFlags, 'about:blank',
        ],
        { stdio: 'ignore' }
    );
    if (lowPriority) {
        try {
            os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch (error) {
            // not allowed here: it runs at the normal priority
        }
    }
    let version;
    for (let i = 0; i < 80 && !version; i++) {
        try {
            version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        } catch {
            await sleep(250);
        }
    }
    if (!version) throw new Error('Chrome did not start');
    const browser = await cdp(version.webSocketDebuggerUrl);

    async function newPage(url = 'about:blank') {
        const { targetId } = (await browser.send('Target.createTarget', { url, newWindow: true })).result;
        for (let i = 0; i < 60; i++) {
            const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.id === targetId);
            if (target) {
                const page = await cdp(target.webSocketDebuggerUrl);
                await page.send('Page.enable');
                await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
                page.targetId = targetId;
                page.close = async () => {
                    page.ws.close();
                    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
                };
                return page;
            }
            await sleep(200);
        }
        throw new Error('page not created');
    }

    const close = () => {
        try {
            proc.kill();
        } catch (error) {
            // already gone
        }
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            close();
            process.exit(130);
        });
    }
    process.once('exit', close);

    return { port, version: version.Browser, browser, newPage, close };
}

// ---- joining the development test room ----------------------------------------------------------------------

// `origin` is the instance (https://mirotalk-dev...), `token` comes from ops/dev-test-token.sh.
// The page always shows the join dialog, even for a direct join: the name comes from the URL and the password
// field is pre-filled with the token, so all that is left is typing the name and pressing "Join" like a person.
export async function joinTestRoom(page, { origin, token, name, room = 'teste' }) {
    // The trailing slash matters: the proxy redirects the exact path /join to /join/link, /join/?... reaches the app.
    const url =
        `${origin}/join/?room=${encodeURIComponent(room)}&roomPassword=${encodeURIComponent(token)}` +
        `&name=${encodeURIComponent(name)}&audio=0&video=0&screen=0&hide=0&notify=0`;
    await page.send('Page.navigate', { url });
    const joined = () => page.ev("typeof rc !== 'undefined' && !!rc && !!rc.peer_id && !!rc.socket && rc.socket.connected").catch(() => false);
    const dialog = () => page.ev("!!document.querySelector('.swal2-popup.init-modal-size .swal2-confirm') && !!document.getElementById('usernameInput')").catch(() => false);

    for (let i = 0; i < 120 && !(await dialog()) && !(await joined()); i++) await sleep(250);
    if (!(await joined())) {
        await sleep(1500); // let the dialog finish animating in
        const position = await page.ev(
            `(() => { document.getElementById('usernameInput').value = ${JSON.stringify(name)}; const r = document.querySelector('.swal2-confirm').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`
        );
        await page.click(position[0], position[1]);
        for (let i = 0; i < 60 && !(await joined()); i++) await sleep(250);
    }
    if (!(await joined())) throw new Error(`${name} could not join the test room`);
    await sleep(1200);
    // close the "share the room" popup like a person would
    await page.ev("(() => { try { if (typeof Swal !== 'undefined' && Swal.isVisible()) Swal.close(); } catch (e) {} return true; })()");
    await sleep(400);
    return true;
}

// vp8: send this screen in VP8 whatever the room's SCREEN_CODEC says (a room set to `auto` sends H.264 from any browser that has a
// graphics card, headless ones too). The default is VP8, the codec the tests were written for (a software encoder that a busy PC
// starves, temporal layers that a viewer can ask for); CODEC=h264 (the replay flow) or E2E_CODEC=auto leave it to the room.
export async function startScreenShare(page, { vp8 = process.env.CODEC !== 'h264' && process.env.E2E_CODEC !== 'auto' } = {}) {
    if (vp8) await page.ev('rc.forceVP8 = true');
    const position = await page.ev(`(() => { showButtons(); const r = document.getElementById('startScreenButton').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.click(position[0], position[1]);
    for (let i = 0; i < 60; i++) {
        if (await page.ev("[...rc.producers.values()].some((p) => p.kind === 'video' && !p.closed)")) return true;
        await sleep(250);
    }
    throw new Error('the screen share did not start');
}

// ---- screen capture without a screen ---------------------------------------------------------------------------

// Headless Chrome has no screen to capture, so the page gets a getDisplayMedia that returns a canvas stream:
// a cut-free animation (scrolling bands, 220 moving balls, a frame counter) at the given size and frame rate,
// so the encoder always has real motion to code. The app code that asks for the share is the real one; the
// options it passes are kept in window.__displayMediaCalls for the tests to inspect.
// Call it before the page navigates to the room.
// With `claquete` (and `withAudio`) the picture flashes white for 6 frames and a beep sounds, both at the same instant,
// every 2 seconds: a clap board to measure how far apart picture and sound end up after the trip through the room.
// `mode` is what is on the screen: 'game' (the default: constant motion), 'desktop' (a still desktop with a clock that
// changes once a second and a burst of movement every 15 s: a capture that produces few frames) or 'idle' (the same
// without the clock: nothing changes between the bursts, so no frames are produced for long stretches).
export async function stubScreenCapture(page, { width = 1920, height = 1080, fps = 60, withAudio = false, claquete = false, mode = 'game' } = {}) {
    const source = `(() => {
        window.__displayMediaCalls = [];
        const W = ${width}, H = ${height}, FPS = ${fps}, CLAQUETE = ${claquete ? 'true' : 'false'}, MODE = ${JSON.stringify(mode)};
        navigator.mediaDevices.getDisplayMedia = async (options) => {
            window.__displayMediaCalls.push(JSON.parse(JSON.stringify(options || {})));
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            const ctx = canvas.getContext('2d');
            const balls = Array.from({ length: 220 }, () => ({
                x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 14, vy: (Math.random() - 0.5) * 14,
                r: 8 + Math.random() * 38, h: Math.floor(Math.random() * 360),
            }));
            let tick = 0;
            let beep = null; // set when the audio exists (claquete)
            let flash = 0;
            let lastFlash = -1e9;
            const desktop = { drawn: false, lastSecond: -1, burst: false };
            const drawDesktop = () => {
                const now = performance.now();
                const lines = () => {
                    ctx.fillStyle = '#d6e2f0'; ctx.font = '22px monospace';
                    for (let l = 0; l < 22; l++) ctx.fillText('line ' + l + ' of text a desktop would show: lorem ipsum dolor sit amet', 100, 120 + l * 26);
                };
                if (!desktop.drawn) {
                    desktop.drawn = true;
                    ctx.fillStyle = '#1e2a3a'; ctx.fillRect(0, 0, W, H);
                    for (let i = 0; i < 9; i++) { ctx.fillStyle = i % 2 ? '#2b3b52' : '#26354b'; ctx.fillRect(80 + (i % 3) * 600, 80 + Math.floor(i / 3) * 330, 560, 300); }
                    lines();
                    ctx.fillStyle = '#111'; ctx.fillRect(0, H - 40, W, 40);
                }
                if (MODE === 'desktop') {
                    const second = Math.floor(now / 1000);
                    if (second !== desktop.lastSecond) {
                        desktop.lastSecond = second;
                        ctx.fillStyle = '#111'; ctx.fillRect(W - 220, H - 40, 220, 40);
                        ctx.fillStyle = '#fff'; ctx.font = '24px monospace'; ctx.fillText(new Date().toTimeString().slice(0, 8), W - 160, H - 12);
                    }
                }
                const phase = now % 15000;
                if (phase < 2000) {
                    const t = phase / 2000;
                    ctx.fillStyle = '#26354b'; ctx.fillRect(80, 80, 1200, 640);
                    lines();
                    ctx.fillStyle = '#ffee55'; ctx.fillRect(200 + t * 1000, 300 + Math.sin(t * 6) * 150, 14, 22);
                    desktop.burst = true;
                } else if (desktop.burst) {
                    desktop.burst = false;
                    ctx.fillStyle = '#26354b'; ctx.fillRect(80, 80, 1200, 640);
                    lines();
                }
            };
            const draw = () => {
                tick++;
                if (MODE !== 'game') { drawDesktop(); requestAnimationFrame(draw); return; }
                for (let i = 0; i < 12; i++) {
                    ctx.fillStyle = 'hsl(' + ((tick * 2 + i * 30) % 360) + ' 60% ' + (18 + (i % 3) * 8) + '%)';
                    ctx.fillRect(((i * 180 + tick * 6) % 2160) - 180, 0, 180, H);
                }
                for (const b of balls) {
                    b.x += b.vx; b.y += b.vy;
                    if (b.x < 0 || b.x > W) b.vx *= -1;
                    if (b.y < 0 || b.y > H) b.vy *= -1;
                    ctx.beginPath();
                    ctx.fillStyle = 'hsl(' + ((b.h + tick) % 360) + ' 80% 55%)';
                    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 64px sans-serif';
                ctx.fillText('frame ' + tick, 60 + (tick * 3) % 1400, H / 2 + Math.sin(tick / 20) * 300);
                if (CLAQUETE && beep) {
                    const now = performance.now();
                    if (now - lastFlash >= 2000) { lastFlash = now; flash = 6; beep(); }
                    if (flash > 0) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); flash--; }
                }
                requestAnimationFrame(draw);
            };
            requestAnimationFrame(draw);
            const stream = canvas.captureStream(FPS);
            if (${withAudio ? 'true' : 'false'} && options && options.audio) {
                const audio = new AudioContext();
                const destination = audio.createMediaStreamDestination();
                const oscillator = audio.createOscillator();
                if (CLAQUETE) {
                    // silent except for 100 ms beeps, started together with the flash
                    const gain = audio.createGain();
                    gain.gain.value = 0;
                    oscillator.frequency.value = 880;
                    oscillator.connect(gain);
                    gain.connect(destination);
                    beep = () => {
                        const t = audio.currentTime;
                        gain.gain.cancelScheduledValues(t);
                        gain.gain.setValueAtTime(0.8, t);
                        gain.gain.setValueAtTime(0, t + 0.1);
                    };
                } else {
                    oscillator.frequency.value = 440;
                    oscillator.connect(destination);
                }
                oscillator.start();
                destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
            }
            return stream;
        };
    })();`;
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
}
