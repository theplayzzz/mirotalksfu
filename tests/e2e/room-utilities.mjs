// Real Socket.IO + real utility handlers/UI, without an SFU or remote server.
// node tests/e2e/room-utilities.mjs. Screenshots go to the system temporary folder.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib.mjs';
const require = createRequire(import.meta.url);
const { Server } = require('socket.io');
const { RoomUtilities } = require('../../app/src/RoomUtilities');
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shots = path.join(tmpdir(), 'room-utilities-shots');
mkdirSync(shots, { recursive: true });
const pageHTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/Root.css"><link rel="stylesheet" href="/css/Room.css"><link rel="stylesheet" href="/css/RoomUtilities.css"><style>body{margin:0;padding:32px;background:#14131c;color:#eee;font-family:Segoe UI,sans-serif}h1{font-size:18px}#bottomButtons{display:flex;opacity:1;position:fixed;bottom:18px;left:50%;transform:translateX(-50%)}#bottomButtons button{display:block!important;height:42px;width:44px;font-size:19px}.test-stream{height:65vh;background:linear-gradient(145deg,#272434,#36303b);border:1px solid #ffffff18;border-radius:14px;display:grid;place-content:center;color:#ad9aae}#testMedia{height:50px;width:220px;position:fixed;left:16px;top:12px;border:0;border-radius:8px;background:#252130;color:#e4dbeb}#testMedia[aria-pressed=true]{background:#604456}</style></head><body><button id="testMedia" aria-pressed="false" onclick="this.setAttribute('aria-pressed',this.getAttribute('aria-pressed')!=='true')">Controle de mídia</button><div class="test-stream">Stream de teste · controles livres</div><div id="bottomButtons"><button id="roomUtilitiesButton" class="hidden" aria-label="Dados e moeda" aria-expanded="false" aria-controls="roomUtilitiesPanel">⚄</button></div><script src="/socket.io/socket.io.js"></script><script src="/js/RoomUtilities.js"></script><script>const params=new URLSearchParams(location.search);const socket=io({query:{name:params.get('name')||'Alice',room:params.get('room')||'friends'}});socket.on('connect',()=>RoomUtilities.connect(socket));</script></body></html>`;
const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pageHTML);
    const files = {
        '/js/RoomUtilities.js': 'public/js/RoomUtilities.js',
        '/css/RoomUtilities.css': 'public/css/RoomUtilities.css',
        '/css/Root.css': 'public/css/Root.css',
        '/css/Room.css': 'public/css/Room.css',
    };
    if (!files[url.pathname]) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
    res.end(readFileSync(path.join(base, files[url.pathname])));
});
const io = new Server(server);
const service = new RoomUtilities();
const rooms = new Map();
io.on('connection', (socket) => {
    const roomId = socket.handshake.query.room;
    if (!rooms.has(roomId)) {
        const peers = new Map();
        rooms.set(roomId, {
            sessionId: `${roomId}-${Date.now()}`,
            peers,
            getPeer: (id) => peers.get(id),
            sendToAll: (event, data) => io.to(roomId).emit(event, data),
        });
    }
    const room = rooms.get(roomId);
    room.peers.set(socket.id, { peer_name: socket.handshake.query.name });
    socket.join(roomId);
    service.bind(socket, () => room);
    socket.on('disconnect', () => {
        room.peers.delete(socket.id);
        if (!room.peers.size) rooms.delete(roomId);
    });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    width: 1440,
    height: 900,
});
const errors = [];
async function open(name, room = 'friends') {
    const page = await chrome.newPage(`${url}/?name=${encodeURIComponent(name)}&room=${room}`);
    const previous = page.ws.onmessage;
    page.ws.onmessage = (message) => {
        const data = JSON.parse(message.data);
        if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text);
        previous(message);
    };
    await page.send('Runtime.enable');
    await until(
        page,
        "!!document.querySelector('#roomUtilitiesPanel') && !document.querySelector('[data-roll]').disabled"
    );
    return page;
}
async function until(page, expression, timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await page.ev(expression).catch(() => false)) return;
        await sleep(50);
    }
    throw new Error(`Timed out: ${expression}`);
}
const history = (page) =>
    page.ev("Array.from(document.querySelectorAll('#roomUtilitiesHistory li')).map(el=>el.textContent)");
async function shot(page, name) {
    const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(shots, `${name}.png`), Buffer.from(result.result.data, 'base64'));
}
try {
    const alice = await open('<img src=x onerror=alert(1)>Alice');
    const bob = await open('Bob');
    const other = await open('Other', 'another');
    await alice.ev(
        "document.getElementById('roomUtilitiesButton').click();document.querySelector('[data-roll=d20]').click()"
    );
    await until(alice, "document.querySelectorAll('#roomUtilitiesHistory li strong').length===1");
    await until(bob, "document.querySelectorAll('#roomUtilitiesHistory li strong').length===1");
    assert.deepEqual(await history(alice), await history(bob), 'same server roll for two users');
    assert.equal(
        await alice.ev("document.querySelectorAll('#roomUtilitiesHistory img').length"),
        0,
        'names are rendered as text'
    );
    assert.equal(
        await other.ev("document.querySelectorAll('#roomUtilitiesHistory li strong').length"),
        0,
        'other rooms are isolated'
    );
    await until(alice, "document.getElementById('roomUtilitiesViewer').classList.contains('is-revealed')");
    assert.equal(
        await alice.ev("document.getElementById('roomUtilitiesResult').textContent"),
        await alice.ev("document.querySelector('#roomUtilitiesHistory li strong').textContent"),
        'animated result equals history'
    );
    await shot(alice, 'desktop-d20');
    // The root overlay must not intercept media controls outside its actual panel.
    await alice.click(100, 35);
    assert.equal(await alice.ev("document.getElementById('testMedia').getAttribute('aria-pressed')"), 'true');
    for (const kind of ['d6', 'd10', 'coin']) {
        await until(alice, `!document.querySelector('[data-roll=${kind}]').disabled`);
        await alice.ev(`document.querySelector('[data-roll=${kind}]').click()`);
        await sleep(100);
    }
    await until(bob, "document.querySelectorAll('#roomUtilitiesHistory li strong').length===4");
    assert.deepEqual(await history(alice), await history(bob));
    await bob.send('Page.reload');
    await until(bob, "document.querySelectorAll('#roomUtilitiesHistory li strong').length===4");
    assert.deepEqual(await history(alice), await history(bob), 'reconnect restores all history without old animations');
    assert.equal(await bob.ev("document.getElementById('roomUtilitiesViewer').hidden"), true);
    await bob.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
    });
    await bob.ev("document.body.style.boxSizing='border-box'");
    await bob.ev(
        "document.getElementById('roomUtilitiesButton').click();document.querySelector('[data-roll=coin]').click()"
    );
    await until(bob, "document.getElementById('roomUtilitiesViewer').classList.contains('is-revealed')");
    const fits = await bob.ev(
        "(() => {const p=document.getElementById('roomUtilitiesPanel').getBoundingClientRect();const v=document.getElementById('roomUtilitiesViewer').getBoundingClientRect();return p.left>=0&&p.right<=390&&p.bottom<=844&&v.left>=0&&v.right<=390&&v.bottom<=p.top;})()"
    );
    await shot(bob, 'mobile-coin');
    assert.equal(
        fits,
        true,
        `mobile panel and result fit without overlapping: ${await bob.ev("JSON.stringify({innerWidth,clientWidth:document.documentElement.clientWidth,panel:document.getElementById('roomUtilitiesPanel').getBoundingClientRect().toJSON(),viewer:document.getElementById('roomUtilitiesViewer').getBoundingClientRect().toJSON()})")}`
    );
    await bob.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    assert.equal(await bob.ev("document.getElementById('roomUtilitiesPanel').hidden"), true);
    assert.equal(await bob.ev('document.activeElement.id'), 'roomUtilitiesButton');
    await bob.ev('socket.disconnect()');
    assert.equal(await bob.ev("document.querySelector('[data-roll]').disabled"), true);
    assert.deepEqual(errors, []);
    console.log(
        `PASS real sockets: shared rolls, four utilities, identity escaping, room isolation, reconnect, animation, controls, mobile layout, keyboard, disconnect. Screenshots: ${shots}`
    );
} finally {
    chrome.close();
    io.close();
    server.close();
}
