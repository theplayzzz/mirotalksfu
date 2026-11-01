// Actual Socket.IO service, admin HTTP routes and built game iframe in real Chrome.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib.mjs';
const require = createRequire(import.meta.url),
    express = require('express'),
    { Server } = require('socket.io');
const { CaptchaControl } = require('../../app/src/CaptchaControl'),
    { captchaRoutes } = require('../../app/src/CaptchaRoutes');
const catalog = require('../../app/src/captcha-games.json');
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'captcha-e2e-data-')),
    shots = path.join(tmpdir(), 'captcha-integration-shots');
mkdirSync(shots, { recursive: true });
const app = express(),
    server = createServer(app),
    io = new Server(server),
    rooms = new Map();
const control = new CaptchaControl({ enabled: true, rooms, sockets: io.sockets.sockets, catalog, dataDir });
const key = 'local-e2e-key-not-used-by-any-server';
app.use(express.json());
app.use(
    ['/captcha', '/dev/captcha'],
    captchaRoutes({
        control,
        adminDir: path.join(base, 'app/captcha-admin'),
        playerDir: path.join(base, 'app/captcha-player'),
        adminKey: key,
    })
);
app.use(express.static(path.join(base, 'public')));
app.get('/fixture', (req, res) =>
    res
        .type('html')
        .send(
            `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/RoomCaptcha.css"><style>body{margin:0;background:#111015;color:#eee;font:15px Segoe UI,sans-serif}main{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:20px}video{width:100%;height:240px;object-fit:cover;background:linear-gradient(135deg,#8062ad,#335a62)}.tile{position:relative;border:1px solid #ffffff20;border-radius:10px;overflow:hidden}.tile>span{position:absolute;bottom:8px;left:10px}.tile button{position:absolute;top:10px;right:10px}#bottom{position:fixed;bottom:18px;left:20px;display:flex;gap:10px}button{background:#31283d;color:white;border:1px solid #ac93b2;padding:12px;border-radius:7px}#videoPinMediaContainer{width:74vw;position:absolute;top:18px;left:18px}#videoPinMediaContainer video{height:73vh}#videoPinMediaContainer:empty{display:none}</style></head><body><main id="grid"><div class="tile" id="streamTile"><video id="stream" data-room-captcha-screen="true"></video><span>Tela compartilhada</span><button id="pin" onclick="document.getElementById('videoPinMediaContainer').append(this.parentElement)">Ampliar</button></div><div class="tile"><video id="camera"></video><span>Câmera · sem blur</span></div><div class="tile"><video id="screen2" data-room-captcha-screen="true"></video><span>Segunda stream</span></div></main><div id="videoPinMediaContainer"></div><div id="bottom"><button id="mic" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true')">Microfone</button><button id="layout" onclick="document.getElementById('grid').prepend(document.getElementById('streamTile'))">Grade</button></div><script src="/socket.io/socket.io.js"></script><script src="/js/RoomCaptcha.js"></script><script>const p=new URLSearchParams(location.search);const socket=io({query:{name:p.get('name')||'Alice',room:p.get('room')||'friends'}});socket.on('connect',()=>RoomCaptcha.connect(socket,{getClient:()=>({videoPinMediaContainer:document.getElementById('videoPinMediaContainer')})}));</script></body></html>`
        )
);
io.on('connection', (socket) => {
    const id = socket.handshake.query.room;
    if (!rooms.has(id)) {
        const peers = new Map();
        rooms.set(id, { peers, getPeer: (id) => peers.get(id) });
    }
    const room = rooms.get(id);
    room.peers.set(socket.id, {
        id: socket.id,
        peer_uuid: socket.handshake.query.name,
        peer_name: socket.handshake.query.name,
    });
    control.bind(socket, () => room);
    socket.on('disconnect', () => {
        room.peers.delete(socket.id);
        if (!room.peers.size) rooms.delete(id);
    });
});
const timer = setInterval(() => control.tick(), 200);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    width: 1440,
    height: 1000,
});
const errors = [];
async function open(url) {
    const p = await chrome.newPage(url);
    const prev = p.ws.onmessage;
    p.ws.onmessage = (event) => {
        const e = JSON.parse(event.data);
        if (e.method === 'Runtime.exceptionThrown') errors.push(e.params.exceptionDetails);
        prev(event);
    };
    await p.send('Runtime.enable');
    return p;
}
async function until(p, expression, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await p.ev(expression).catch(() => false)) return;
        await sleep(70);
    }
    throw new Error(`Timeout: ${expression}`);
}
const iframe = (expression) =>
    `document.querySelector('#roomCaptchaWindow iframe').contentWindow.eval(${JSON.stringify(expression)})`;
async function shot(p, name) {
    const r = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}
async function openPrompt(page, target = 'stream') {
    const selector = `.room-captcha-prompt[data-captcha-target="${target}"]:not([hidden])`;
    await until(page, `!!document.querySelector(${JSON.stringify(selector)})`);
    const position = await page.ev(
        `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`
    );
    await page.click(position.x, position.y);
}
let token;
async function api(route, body) {
    const r = await fetch(origin + '/captcha' + route, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json();
    assert.equal(r.ok, true, JSON.stringify(data));
    return data;
}
try {
    const alice = await open(origin + '/fixture?name=Alice'),
        bob = await open(origin + '/fixture?name=Bob'),
        other = await open(origin + '/fixture?name=Other&room=other');
    await until(alice, 'socket.connected');
    await until(bob, 'socket.connected');
    await sleep(250);
    const admin = await open(origin + '/captcha/');
    await until(admin, '!!document.getElementById("loginForm")');
    await admin.ev(
        `document.getElementById('key').value=${JSON.stringify(key)};document.getElementById('loginForm').requestSubmit()`
    );
    await until(admin, '!document.getElementById("dashboard").hidden');
    token = await admin.ev('sessionStorage.getItem("captcha-admin-token")');
    await until(admin, 'document.querySelectorAll("#users .user").length===2');
    assert.equal(await admin.ev('document.getElementById("voteRequired").value'), '35');
    await shot(admin, 'admin-live');
    const state = await api('/api/state'),
        aliceId = state.rooms.find((r) => r.id === 'friends').users.find((u) => u.name === 'Alice').id;
    const settings = state.settings;
    for (const g of Object.values(settings.games)) g.duration = 8;
    await api('/api/settings', settings);
    await api('/api/trigger', { roomId: 'friends', peerId: aliceId, gameId: 'juggle' });
    await until(alice, 'document.querySelectorAll(".room-captcha-prompt:not([hidden])").length===2');
    assert.equal(
        await alice.ev('!!document.getElementById("roomCaptchaWindow")'),
        false,
        'no game window until the participant clicks'
    );
    assert.equal(
        await alice.ev('performance.getEntriesByType("resource").filter(r=>r.name.includes("/captcha/play/")).length'),
        0,
        'no iframe or game assets fetched before the click'
    );
    assert.equal(control.attempts.size, 0, 'assignment is pending; no attempt has started');
    assert.equal(await bob.ev('!!document.getElementById("roomCaptchaWindow")'), false);
    assert.equal(await other.ev('!!document.getElementById("roomCaptchaWindow")'), false);
    assert.equal(await alice.ev('getComputedStyle(document.getElementById("stream")).filter'), 'blur(14px)');
    assert.equal(await alice.ev('getComputedStyle(document.getElementById("screen2")).filter'), 'blur(14px)');
    assert.equal(await alice.ev('getComputedStyle(document.getElementById("camera")).filter'), 'none');
    await alice.ev(
        '(()=>{const tile=document.createElement("div"),v=document.createElement("video");v.id="lateScreen";v.dataset.roomCaptchaScreen="true";tile.className="tile";tile.append(v);document.getElementById("grid").append(tile)})()'
    );
    await until(alice, 'document.querySelectorAll(".room-captcha-prompt:not([hidden])").length===3');
    assert.equal(await alice.ev('getComputedStyle(document.getElementById("lateScreen")).filter'), 'blur(14px)');
    await alice.ev('document.getElementById("lateScreen").parentElement.remove()');
    await until(alice, 'document.querySelectorAll(".room-captcha-prompt:not([hidden])").length===2');
    await shot(alice, 'grid-ready');
    const mic = await alice.ev(
        '(() => {const r=document.getElementById("mic").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()'
    );
    await alice.click(mic.x, mic.y);
    assert.equal(await alice.ev('document.getElementById("mic").getAttribute("aria-pressed")'), 'true');
    await alice.ev('document.getElementById("pin").click()');
    await sleep(400);
    await shot(alice, 'pinned-prompt');
    await openPrompt(alice);
    await until(alice, iframe('!document.getElementById("pause").disabled'));
    assert.equal(control.attempts.size, 1, 'one click opens the window and starts the verification');
    assert.equal(await alice.ev(iframe('document.body.innerText.toLowerCase().includes("resenha")')), false);
    await alice.ev('document.querySelector("[data-minimize]").click()');
    await until(alice, 'document.querySelectorAll(".room-captcha-prompt:not([hidden])").length===2');
    await openPrompt(alice);
    assert.equal(control.attempts.size, 1, 'opening a minimized verification reuses its attempt');
    await sleep(100);
    const dims = await alice.ev(
        '(() => {const game=document.getElementById("roomCaptchaWindow").getBoundingClientRect(),video=document.getElementById("stream").getBoundingClientRect();return {left:game.left,expected:video.left,width:game.width,expectedWidth:video.width}})()'
    );
    assert.ok(Math.abs(dims.left - dims.expected) < 3);
    assert.ok(Math.abs(dims.width - dims.expectedWidth) < 3);
    await shot(alice, 'pinned-countdown');
    await until(alice, iframe('!document.getElementById("result").hidden'), 16000);
    assert.equal(await alice.ev('document.body.classList.contains("room-captcha-blur")'), false);
    await alice.ev(iframe('document.querySelectorAll("#stars button")[3].click()'));
    await until(alice, iframe('document.getElementById("ratingStatus").textContent.includes("registrada")'));
    assert.equal((await api('/api/state')).stats.find((s) => s.gameId === 'juggle').averageRating, 4);
    await shot(alice, 'result-stars');
    await alice.ev(iframe('document.getElementById("retry").click()'));
    await until(alice, 'document.body.classList.contains("room-captcha-blur")');
    assert.equal((await api('/api/state')).stats.find((s) => s.gameId === 'juggle').retries, 1);
    await api('/api/release', { peerId: aliceId });
    await until(alice, '!document.getElementById("roomCaptchaWindow")');
    const vote = await api('/api/votes', {
        roomId: 'friends',
        peerId: aliceId,
        gameId: 'rain',
        mode: 'count',
        required: 2,
        seconds: 20,
    });
    await until(alice, '!!document.getElementById("roomCaptchaVote")');
    await until(bob, '!!document.getElementById("roomCaptchaVote")');
    assert.equal(
        await bob.ev('document.querySelector("#roomCaptchaVote strong").textContent'),
        'Alice deve passar pelo Boiolômetro?'
    );
    assert.equal(await other.ev('!!document.getElementById("roomCaptchaVote")'), false);
    await alice.ev('document.querySelector("#roomCaptchaVote button").click()');
    await bob.ev('document.querySelector("#roomCaptchaVote button").click()');
    await until(alice, 'document.querySelectorAll(".room-captcha-prompt:not([hidden])").length===2');
    assert.equal(await alice.ev('!!document.getElementById("roomCaptchaWindow")'), false);
    await until(bob, '!document.getElementById("roomCaptchaVote")');
    assert.equal(control.votes.get(vote.id).status, 'approved');
    await api('/api/release', { peerId: aliceId });
    // Each real game bundle mounts and starts, with no missing assets/runtime errors.
    for (const g of catalog) {
        await api('/api/trigger', { roomId: 'friends', peerId: aliceId, gameId: g.id });
        await openPrompt(alice);
        await until(alice, iframe('document.getElementById("pause").disabled===false'));
        await sleep(80);
        await api('/api/release', { peerId: aliceId });
        await until(alice, '!document.getElementById("roomCaptchaWindow")');
    }
    await api('/api/trigger', { roomId: 'friends', peerId: aliceId, gameId: 'rain' });
    await until(alice, '!!document.getElementById("roomCaptchaPrompts")');
    await alice.ev('socket.disconnect()');
    await until(
        alice,
        '!document.body.classList.contains("room-captcha-blur") && !document.getElementById("roomCaptchaWindow")'
    );
    const bobId = (await api('/api/state')).rooms.find((r) => r.id === 'friends').users[0].id;
    await bob.ev(
        'document.querySelectorAll("video[data-room-captcha-screen]").forEach(v=>delete v.dataset.roomCaptchaScreen)'
    );
    await api('/api/trigger', { roomId: 'friends', peerId: bobId, gameId: 'rain' });
    await sleep(350);
    assert.equal(
        await bob.ev('document.querySelectorAll(".room-captcha-prompt").length'),
        0,
        'no prompt is placed on avatars or cameras when no stream exists'
    );
    assert.equal(await bob.ev('!!document.getElementById("roomCaptchaWindow")'), false);
    await bob.ev('document.getElementById("stream").dataset.roomCaptchaScreen="true"');
    await until(bob, 'document.querySelectorAll(".room-captcha-prompt:not([hidden])").length===1');
    await api('/api/release', { peerId: bobId });
    await bob.send('Network.enable');
    await bob.send('Network.setBlockedURLs', { urls: ['*player-escape-transparent*.png'] });
    await api('/api/trigger', { roomId: 'friends', peerId: bobId, gameId: 'rain' });
    await openPrompt(bob);
    await until(
        bob,
        '!document.getElementById("roomCaptchaWindow") && !document.body.classList.contains("room-captcha-blur")'
    );
    await bob.send('Network.setBlockedURLs', { urls: [] });
    await bob.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
    });
    await api('/api/trigger', { roomId: 'friends', peerId: bobId, gameId: 'rain' });
    await until(bob, '!!document.querySelector(".room-captcha-prompt:not([hidden])")');
    assert.equal(
        await bob.ev(
            '(()=>{const b=document.querySelector(".room-captcha-prompt").getBoundingClientRect(),v=document.getElementById("stream").getBoundingClientRect();return b.left>=v.left&&b.right<=v.right&&b.top>=v.top&&b.bottom<=v.bottom})()'
        ),
        true
    );
    await shot(bob, 'mobile-prompt');
    await api('/api/release', { peerId: bobId });
    await admin.ev('document.querySelector("[data-tab=games]").click()');
    await sleep(3200);
    await shot(admin, 'admin-games');
    await admin.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
    });
    await admin.ev('document.querySelector("[data-tab=live]").click()');
    await shot(admin, 'admin-mobile');
    assert.equal(await admin.ev('document.documentElement.scrollWidth<=innerWidth'), true);
    assert.deepEqual(errors, []);
    console.log(
        `PASS: private admin, real presence, targeted delivery, stream-only blur, grid/pin, controls, actual game result/rating/retry, voting, all 14 players, disconnect cleanup and responsive admin. Screenshots: ${shots}`
    );
} finally {
    chrome.close();
    clearInterval(timer);
    io.close();
    server.close();
    await control.writes;
    rmSync(dataDir, { recursive: true, force: true });
}
