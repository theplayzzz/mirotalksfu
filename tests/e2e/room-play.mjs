// Real Socket.IO, private admin routes, game iframe and WebGL, exercised in Chrome.
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
const { RoomPlayControl } = require('../../app/src/RoomPlayControl'),
    { RoomUtilities } = require('../../app/src/RoomUtilities'),
    { captchaRoutes } = require('../../app/src/CaptchaRoutes');
const catalog = require('../../app/src/captcha-games.json');
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    dir = mkdtempSync(path.join(tmpdir(), 'room-play-e2e-')),
    shots = path.join(dir, 'shots');
mkdirSync(shots);
const app = express(),
    server = createServer(app),
    io = new Server(server),
    rooms = new Map();
const control = new RoomPlayControl({
        enabled: true,
        rooms,
        sockets: io.sockets.sockets,
        catalog,
        dataDir: dir,
        policy: { targetCooldownMs: 1000, proposalCooldownMs: 1500, voteGapMs: 200 },
    }),
    utilities = new RoomUtilities();
const key = 'local-hub-e2e-key-not-used-by-any-server';
let token;
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
            `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/RoomCaptcha.css"><style>body{margin:0;background:#111015;color:#eee;font:15px Segoe UI,sans-serif}#grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:20px}.Camera{position:relative;height:300px;overflow:hidden;border-radius:12px;background:#24202d}.Camera video{width:100%;height:100%;background:linear-gradient(135deg,#8062ad,#335a62)}.Camera>span{position:absolute;bottom:10px;left:10px}.Camera>img{width:100px;height:100px;position:absolute;left:40%;top:30%}#bottomButtons{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);display:flex;gap:10px;height:46px}button{background:#31283d;color:white;border:1px solid #ac93b2;padding:12px;border-radius:7px}</style></head><body><main id="grid"><div class="Camera"><video id="stream"></video><span>Tela compartilhada</span></div><div class="Camera"><video id="camera"></video><span>Câmera</span></div><div class="Camera"><img class="videoAvatarImage" id="avatar" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Ccircle cx='50' cy='50' r='50' fill='teal'/%3E%3C/svg%3E"><span>Sem câmera</span></div></main><div id="bottomButtons"><button id="mic" onclick="this.dataset.clicked='true'">Microfone</button><button id="share">Compartilhar</button><button id="roomUtilitiesButton">Jogos</button></div><script src="/socket.io/socket.io.js"></script><script src="/js/RoomUtilities.js"></script><script src="/js/RoomCaptcha.js"></script><script>const p=new URLSearchParams(location.search);window.socket=io({query:{name:p.get('name')||'Alice',room:p.get('room')||'friends'}});socket.on('connect',()=>{RoomUtilities.connect(socket);RoomCaptcha.connect(socket)});</script></body></html>`
        )
);
io.on('connection', (socket) => {
    const id = socket.handshake.query.room;
    if (!rooms.has(id)) {
        const peers = new Map();
        rooms.set(id, {
            peers,
            getPeers: () => peers,
            getPeer: (id) => peers.get(id),
            sendToAll: (event, data) => {
                for (const id of peers.keys()) io.sockets.sockets.get(id)?.emit(event, data);
            },
        });
    }
    const room = rooms.get(id);
    room.peers.set(socket.id, {
        id: socket.id,
        peer_uuid: socket.handshake.query.name,
        peer_name: socket.handshake.query.name,
    });
    utilities.bind(socket, () => room);
    control.bind(socket, () => room);
    socket.on('disconnect', () => {
        room.peers.delete(socket.id);
        if (!room.peers.size) rooms.delete(id);
    });
});
const tick = setInterval(() => control.tick(), 100);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    width: 1440,
    height: 1000,
    extraFlags: ['--enable-unsafe-swiftshader'],
});
const errors = [],
    pages = [];
async function open(name, room = 'friends') {
    const p = await chrome.newPage(origin + `/fixture?name=${name}&room=${room}`);
    const prev = p.ws.onmessage;
    p.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
        prev(e);
    };
    await p.send('Runtime.enable');
    pages.push(p);
    await until(p, 'socket.connected && !!document.getElementById("roomPlayHub")');
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
const $ = (id) => `document.getElementById(${JSON.stringify(id)})`;
const frame = (expression) =>
    `document.querySelector('#rpFrameHost iframe').contentWindow.eval(${JSON.stringify(expression)})`;
async function click(p, selector) {
    const r = await p.ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing button');e.scrollIntoView({block:'nearest'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`
    );
    await p.click(r.x, r.y);
}
async function api(route, body) {
    const res = await fetch(origin + '/captcha' + route, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const r = await res.json();
    assert.ok(res.ok, JSON.stringify(r));
    return r;
}
async function shot(p, name) {
    const r = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.result.data, 'base64'));
}
async function hub(p, tab = 'games') {
    await p.ev(`${$('roomUtilitiesButton')}.click()`);
    await p.ev(`document.querySelector('[data-view="${tab}"]').click()`);
}
async function close(p) {
    await p.ev(`${$('rpClose')}.click()`);
    await sleep(180);
}
try {
    const alice = await open('Alice'),
        bob = await open('Bob'),
        carol = await open('Carol'),
        other = await open('Other', 'other');
    const friends = rooms.get('friends');
    friends.peers.set('presence-1', { id: 'presence-1', peer_uuid: 'presence-1', peer_name: 'Presença 1' });
    friends.peers.set('presence-2', { id: 'presence-2', peer_uuid: 'presence-2', peer_name: 'Presença 2' });
    const aliceId = await alice.ev('socket.id'),
        bobId = await bob.ev('socket.id'),
        carolId = await carol.ev('socket.id');
    token = (await api('/login', { key })).token;
    const settings = (await api('/api/state')).settings;
    for (const g of Object.values(settings.games)) g.duration = 8;
    await api('/api/settings', settings);
    const admin = await chrome.newPage(origin + '/captcha/');
    await until(admin, `${$('loginForm')}!==null`);
    await admin.ev(`${$('key')}.value=${JSON.stringify(key)};${$('loginForm')}.requestSubmit()`);
    await until(admin, `!${$('dashboard')}.hidden`);
    assert.equal(await admin.ev(`${$('voteRequired')}.value`), '30');
    await hub(alice);
    assert.equal(await alice.ev('document.querySelectorAll("[data-game]").length'), 14);
    await shot(alice, 'hub-games');
    await close(alice);
    console.log('OK private panel and 14-game catalog');
    await api('/api/trigger', { roomId: 'friends', peerId: aliceId, gameId: 'rain' });
    await until(alice, 'document.querySelectorAll(".rp-captcha-prompt:not([hidden])").length===3');
    assert.equal(await alice.ev('document.querySelectorAll("#rpFrameHost iframe").length'), 0);
    for (const id of ['stream', 'camera', 'avatar'])
        assert.equal(await alice.ev(`getComputedStyle(${$(id)}).filter`), 'blur(14px)');
    assert.equal(await bob.ev('document.body.classList.contains("room-captcha-blur")'), false);
    assert.equal(await other.ev('document.body.classList.contains("room-captcha-blur")'), false);
    await click(alice, '#mic');
    assert.equal(await alice.ev(`${$('mic')}.dataset.clicked`), 'true');
    await click(alice, '.rp-captcha-prompt');
    await until(alice, frame(`!${$('ready')}.hidden===false && ${$('time')}.textContent!=='—'`));
    await until(alice, frame(`!${$('countdown')}.hidden || ${$('time')}.textContent!=='8s'`));
    await alice.ev(`${$('rpMinimize')}.click()`);
    await until(alice, `!${$('roomPlayDock')}.hidden`);
    await sleep(150);
    assert.equal(control.active.get(aliceId).phase, 'paused');
    const before = await alice.ev(frame(`${$('time')}.textContent`));
    await sleep(1050);
    assert.equal(await alice.ev(frame(`${$('time')}.textContent`)), before);
    await alice.ev(`${$('rpRestore')}.click();${$('rpMaximize')}.click()`);
    const bounds = await alice.ev(
        `(()=>{const w=${$('roomPlayHub')}.getBoundingClientRect(),b=${$('bottomButtons')}.getBoundingClientRect();return {bottom:w.bottom,bar:b.top,width:w.width}})()`
    );
    assert.ok(bounds.bottom < bounds.bar);
    assert.ok(bounds.width > 1300);
    await shot(alice, 'verification-window');
    await until(alice, frame(`!${$('result')}.hidden`), 18000);
    await until(alice, frame(`${$('resultScore')}.textContent.includes('registrada')`));
    assert.equal(await alice.ev('document.body.classList.contains("room-captcha-blur")'), false);
    await alice.ev(
        frame(
            `document.querySelectorAll('#stars button')[3].click();${$('initials')}.value='ACE';${$('initialsForm')}.requestSubmit()`
        )
    );
    await until(alice, frame(`${$('ratingStatus')}.textContent.includes('registrada')`));
    await until(alice, frame(`${$('resultScore')}.textContent.includes('Sigla salva')`));
    await alice.ev(frame(`${$('ranking')}.click()`));
    await until(alice, `${$('rpRankRows')}.textContent.includes('ACE')`);
    await shot(alice, 'hub-ranking');
    await close(alice);
    console.log('OK tile-only blur, explicit start, pause, safe maximize, natural result, rating and ranking');
    await hub(bob);
    await bob.ev('document.querySelector("[data-game=juggle]").click()');
    await until(bob, '!!document.querySelector("#rpFrameHost iframe")');
    await until(bob, frame(`${$('ready')}.hidden`));
    const manualId = control.active.get(bobId).id;
    await api('/api/trigger', { roomId: 'friends', peerId: bobId, gameId: 'rain' });
    await until(bob, `${$('rpPendingText')}.textContent.includes('aguarda')`);
    assert.equal(control.pending.get(bobId).phase, 'waiting');
    assert.equal(control.active.get(bobId).id, manualId);
    assert.equal(await bob.ev('document.body.classList.contains("room-captcha-blur")'), false);
    await until(bob, frame(`!${$('result')}.hidden`), 18000);
    await until(bob, frame(`!${$('nextVerification')}.hidden`));
    assert.ok(control.attempts.get(control.active.get(bobId).currentAttempt).score);
    await close(bob);
    assert.equal(control.pending.has(bobId), false);
    await sleep(700);
    assert.equal(await bob.ev(`${$('roomPlayHub')}.hidden`), true);
    await hub(carol);
    await carol.ev('document.querySelector("[data-game=arena]").click()');
    await until(carol, frame(`${$('ready')}.hidden`));
    await carol.ev(`${$('rpMinimize')}.click()`);
    await sleep(120);
    await api('/api/trigger', { roomId: 'friends', peerId: carolId });
    await until(carol, `${$('rpPendingText')}.textContent.includes('aguarda')`);
    await carol.ev(`${$('rpDockClose')}.click()`);
    await sleep(350);
    assert.equal(control.pending.has(carolId), false);
    assert.equal(control.active.has(carolId), false);
    console.log('OK CAPTCHA waits behind manual play; both result-close and dock-X cancel pending');
    await sleep(1100);
    await hub(alice, 'vote');
    await until(alice, 'document.querySelectorAll(".rp-user").length===5');
    await alice.ev(
        `(()=>{const rows=[...document.querySelectorAll('.rp-user')];rows.find(r=>r.textContent.includes('Bob')).querySelector('button').click()})()`
    );
    await until(alice, `!${$('roomPlayBallot')}.hidden`);
    await until(bob, `!${$('roomPlayBallot')}.hidden`);
    const ballot = [...control.votes.values()].find((v) => v.status === 'open');
    assert.equal(ballot.threshold, 2);
    assert.equal(Object.values(ballot.choices).length, 1);
    const queued = control.openVote({ roomId: 'friends', peerId: carolId, gameId: 'rain', authorPeerId: carolId });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.yes, 0);
    await bob.ev(`${$('roomPlayBallot')}.querySelector('button').click()`);
    await until(bob, 'document.body.classList.contains("room-captcha-blur")');
    await sleep(400);
    assert.equal(control.votes.get(queued.id).status, 'open');
    await shot(alice, 'hub-voting');
    control.cancelVote(queued.id);
    control.release(bobId, 'test');
    await close(alice);
    await sleep(350);
    console.log('OK room ballot, proposer vote, strict quorum and serialized queue');
    await hub(alice, 'dice');
    await hub(bob, 'dice');
    await hub(carol, 'dice');
    await Promise.all([
        alice.ev('document.querySelector("[data-roll=d6]").click()'),
        bob.ev('document.querySelector("[data-roll=d10]").click()'),
        carol.ev('document.querySelector("[data-roll=coin]").click()'),
    ]);
    await until(alice, 'document.querySelectorAll("#rpHistory li[data-roll-id]").length===3');
    assert.equal(await alice.ev('document.querySelectorAll("#rpHistory b")[0].textContent'), 'Rolando…');
    await until(alice, `!!${$('rpDiceScene')}.querySelector('canvas')`);
    assert.equal(await alice.ev(`${$('rpDiceScene')}.querySelectorAll('canvas').length`), 1);
    await shot(alice, 'dice-rolling');
    await until(alice, '[...document.querySelectorAll("#rpHistory b")].every(e=>e.textContent!=="Rolando…")', 12000);
    await shot(alice, 'dice-result');
    const rows = await alice.ev(
        '[...document.querySelectorAll("#rpHistory li")].map(e=>[e.dataset.rollId,e.textContent])'
    );
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((r) => r[0])).size, 3);
    assert.deepEqual(
        await bob.ev('[...document.querySelectorAll("#rpHistory li")].map(e=>[e.dataset.rollId,e.textContent])'),
        rows
    );
    await close(alice);
    await close(bob);
    await close(carol);
    console.log('OK simultaneous 3D rolls, delayed numbers, common history and dedup');
    for (const g of catalog) {
        await hub(alice);
        await alice.ev(`document.querySelector('[data-game="${g.id}"]').click()`);
        await until(alice, frame(`${$('ready')}.hidden && !!document.getElementById('game')`));
        await sleep(100);
        assert.ok(control.active.get(aliceId)?.currentAttempt, `${g.id} starts`);
        await close(alice);
        console.log(`OK mouse game boots: ${g.id}`);
    }
    await alice.send('Emulation.setDeviceMetricsOverride', {
        width: 520,
        height: 850,
        deviceScaleFactor: 1,
        mobile: true,
    });
    await hub(alice);
    await shot(alice, 'hub-mobile');
    const overflow = await alice.ev(
        `${$('roomPlayHub')}.getBoundingClientRect().right>innerWidth || ${$('roomPlayHub')}.getBoundingClientRect().bottom>${$('bottomButtons')}.getBoundingClientRect().top`
    );
    assert.equal(overflow, false);
    assert.equal(errors.length, 0, JSON.stringify(errors).slice(0, 1000));
    console.log(
        JSON.stringify(
            {
                passed: true,
                games: catalog.length,
                attempts: control.attempts.size,
                ratings: control.ratings.size,
                screenshots: shots,
            },
            null,
            2
        )
    );
} catch (error) {
    for (const [i, p] of pages.entries()) {
        console.log(
            'DIAGNOSTIC',
            i,
            await p
                .ev(
                    `({status:document.getElementById('rpStatus')?.textContent,frame:document.querySelector('iframe')?.contentDocument?.body.innerText.slice(-1600)})`
                )
                .catch(() => null)
        );
        await shot(p, `failure-${i}`).catch(() => {});
    }
    console.log('Browser exceptions', JSON.stringify(errors));
    console.log('Screenshots', shots);
    throw error;
} finally {
    clearInterval(tick);
    chrome.close();
    await new Promise((r) => io.close(r));
    await new Promise((r) => server.close(r));
    await control.writes; /* keep screenshots for review */
}
