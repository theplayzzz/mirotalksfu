// Isolated browser regression: actual Socket.IO room membership, hub and lazy WebGL.
// Never joins a deployed room, captures a desktop or opens a microphone.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib.mjs';
const require = createRequire(import.meta.url);
const express = require('express'),
    { Server } = require('socket.io');
const { RoomPlayControl } = require('../../app/src/RoomPlayControl'),
    { RoomUtilities } = require('../../app/src/RoomUtilities'),
    { captchaRoutes } = require('../../app/src/CaptchaRoutes');
const catalog = require('../../app/src/captcha-games.json');
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync(path.join(tmpdir(), 'room-dice-e2e-')),
    shots = path.join(dir, 'shots');
mkdirSync(shots);
const app = express(),
    server = createServer(app),
    io = new Server(server),
    rooms = new Map();
const control = new RoomPlayControl({ enabled: true, rooms, sockets: io.sockets.sockets, catalog, dataDir: dir });
const utilities = new RoomUtilities();
app.use(express.json());
app.use(
    ['/captcha', '/dev/captcha'],
    captchaRoutes({
        control,
        adminDir: path.join(base, 'app/captcha-admin'),
        playerDir: path.join(base, 'app/captcha-player'),
        adminKey: 'isolated-room-dice-tests-not-a-deployed-key',
    })
);
app.use(express.static(path.join(base, 'public')));
app.get('/fixture', (_, res) =>
    res.type('html')
        .send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/RoomCaptcha.css"><style>
*{box-sizing:border-box}body{margin:0;background:#111015;color:#eee;font:14px 'Segoe UI',sans-serif}#bottomButtons{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);height:44px;display:flex;gap:8px;z-index:3}#bottomButtons button{padding:8px 10px;border:1px solid #9c86aa;border-radius:7px;background:#30263b;color:#eee}
</style></head><body><div id="bottomButtons"><button id="mic" onclick="this.dataset.clicked='true'">Mic</button><button id="share">Tela</button><button id="roomUtilitiesButton">Jogos</button></div><script src="/socket.io/socket.io.js"></script><script src="/js/RoomUtilities.js"></script><script src="/js/RoomCaptcha.js"></script><script>
const p=new URLSearchParams(location.search);window.socket=io({query:{name:p.get('name'),room:p.get('room')||'friends',ackDelay:p.get('ackDelay')||''}});socket.on('connect',()=>{RoomUtilities.connect(socket);RoomCaptcha.connect(socket)});
</script></body></html>`)
);
io.on('connection', (socket) => {
    const roomId = String(socket.handshake.query.room);
    if (!rooms.has(roomId)) {
        const peers = new Map();
        rooms.set(roomId, {
            peers,
            getPeers: () => peers,
            getPeer: (id) => peers.get(id),
            send(id, event, data) {
                io.sockets.sockets.get(id)?.emit(event, data);
            },
            sendToAll(event, data) {
                for (const id of peers.keys()) io.sockets.sockets.get(id)?.emit(event, data);
            },
        });
    }
    const room = rooms.get(roomId);
    room.peers.set(socket.id, {
        id: socket.id,
        peer_name: String(socket.handshake.query.name),
        peer_uuid: String(socket.handshake.query.name),
    });
    // Broadcast arrives before this delayed ACK, as it can across a real connection.
    const on = socket.on.bind(socket);
    socket.on = (event, listener) =>
        on(
            event,
            event === 'utilityRoll' && socket.handshake.query.ackDelay
                ? (request, callback) => listener(request, (reply) => setTimeout(() => callback(reply), 2400))
                : listener
        );
    utilities.bind(socket, () => room);
    control.bind(socket, () => room);
    socket.on('disconnect', () => {
        room.peers.delete(socket.id);
        if (!room.peers.size) rooms.delete(roomId);
    });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    width: 1440,
    height: 1000,
    extraFlags: ['--enable-unsafe-swiftshader'],
});
const pages = [],
    errors = [],
    checks = [];
async function until(page, expression, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await page.ev(expression).catch(() => false)) return;
        await sleep(80);
    }
    throw new Error(`Timeout: ${expression}`);
}
async function open(name, { room = 'friends', ackDelay = false, failDice = false } = {}) {
    const page = await chrome.newPage();
    const previous = page.ws.onmessage;
    page.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
        if (failDice && message.method === 'Fetch.requestPaused')
            page.send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'Failed' });
        previous(event);
    };
    await page.send('Runtime.enable');
    if (failDice)
        await page.send('Fetch.enable', {
            patterns: [{ urlPattern: '*/captcha/play/dice.js', requestStage: 'Request' }],
        });
    pages.push(page);
    await page.send('Page.navigate', {
        url: origin + `/fixture?name=${encodeURIComponent(name)}&room=${room}${ackDelay ? '&ackDelay=1' : ''}`,
    });
    await until(page, 'socket.connected && !!document.getElementById("roomPlayHub") && RoomUtilities.current().online');
    return page;
}
async function dice(page) {
    await page.ev(
        `if(document.getElementById('roomPlayHub').hidden)document.getElementById('roomUtilitiesButton').click();document.querySelector('[data-view=dice]').click()`
    );
    await until(page, '!document.getElementById("rpDice").hidden');
}
async function click(page, selector) {
    const point = await page.ev(
        `(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`
    );
    await page.click(point.x, point.y);
}
async function shot(page, name) {
    const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(shots, name + '.png'), Buffer.from(result.result.data, 'base64'));
}
async function visibleModelPixels(page) {
    const clip = await page.ev(`(()=>{const r=document.getElementById('rpDiceScene').getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()`);
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    // Reading WebGL's default drawing buffer can itself return cleared pixels after
    // compositing. Decode the browser's actual screenshot instead, without another
    // dependency or asking the renderer under test to render a diagnostic frame.
    return page.ev(`(async()=>{
        const image=new Image();image.src=${JSON.stringify('data:image/png;base64,' + screenshot.result.data)};
        await image.decode();const canvas=new OffscreenCanvas(image.naturalWidth,image.naturalHeight),context=canvas.getContext('2d');
        context.drawImage(image,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let count=0;
        for(let i=0;i<pixels.length;i+=4)if(pixels[i]>125&&pixels[i+1]>100&&pixels[i+2]<220)count++;
        return count;
    })()`);
}
const disabled = '[...document.querySelectorAll("[data-roll]")].every(button=>button.disabled)';
const enabled = '[...document.querySelectorAll("[data-roll]")].every(button=>!button.disabled)';
const rows =
    '[...document.querySelectorAll("#rpHistory li[data-roll-id]")].map(element=>[element.dataset.rollId,element.textContent])';
try {
    const alice = await open('Alice', { ackDelay: true }),
        bob = await open('Bob'),
        carol = await open('Carol' + 'NomeLongo'.repeat(8)),
        duplicate = await open('Alice'),
        other = await open('Other', { room: 'other' });
    await Promise.all([alice, bob, carol, duplicate, other].map(dice));
    await Promise.all([alice, bob, carol, duplicate, other].map((page) => until(page, enabled)));
    await alice.ev(`window.seenVisualRolls=new Set();new MutationObserver(()=>{
        for(const id of JSON.parse(document.getElementById('roomPlayDiceViewer').dataset.activeRollIds||'[]'))seenVisualRolls.add(id);
    }).observe(document.getElementById('roomPlayDiceViewer'),{attributes:true,attributeFilter:['data-active-roll-ids']})`);
    await alice.ev(`for(let i=0;i<80;i++)document.querySelectorAll('[data-roll]')[i%4].click()`);
    await until(alice, 'RoomUtilities.current().rolls.length===1');
    await until(duplicate, disabled);
    assert.equal(utilities.state(rooms.get('friends')).rolls.length, 1, 'rapid clicks must accept one roll only');
    assert.equal(await alice.ev(disabled), true, 'all four actions lock immediately, before a slow ACK');
    assert.equal(await bob.ev(enabled), true, 'another identity can roll independently');
    assert.equal(await other.ev('RoomUtilities.current().rolls.length'), 0, 'roll does not leak to another room');
    const bypass = await duplicate.ev(
        `new Promise(resolve=>socket.emit('utilityRoll',{kind:'d20',requestId:'attempt-cross-tab-bypass'},resolve))`
    );
    assert.equal(bypass.code, 'COOLDOWN', 'same identity cannot bypass the in-flight lock in another tab');
    await until(
        alice,
        'JSON.parse(document.getElementById("roomPlayDiceViewer").dataset.activeRollIds||"[]").length>0'
    );
    const activeBeforeMinimize = await alice.ev('document.getElementById("roomPlayDiceViewer").dataset.activeRollIds');
    await click(alice, '#rpMinimize');
    await until(alice, '!document.getElementById("roomPlayDock").hidden');
    await sleep(250);
    await click(alice, '#rpRestore');
    await until(alice, '!document.getElementById("rpDice").hidden');
    assert.equal(
        await alice.ev('document.getElementById("roomPlayDiceViewer").dataset.activeRollIds'),
        activeBeforeMinimize
    );
    assert.equal(await alice.ev(disabled), true, 'minimize/restore cannot restart a roll or release its actions');
    checks.push('rapid-click and duplicate-tab locks; other users remain independent');

    await bob.ev(`document.querySelector('[data-roll=coin]').click()`);
    await sleep(300);
    await carol.ev(`document.querySelector('[data-roll=d20]').click()`);
    await Promise.all(
        [alice, bob, carol, duplicate].map((page) => until(page, 'RoomUtilities.current().rolls.length===3'))
    );
    await sleep(1500);
    assert.equal(await alice.ev(disabled), true, 'lock persists past the obsolete 1.2-second cooldown');
    assert.equal(await bob.ev(disabled), true);
    assert.equal(await carol.ev(disabled), true);
    for (const page of [alice, bob, carol])
        assert.equal(
            await page.ev(
                '[...document.querySelectorAll("#rpHistory b")].every(element=>element.textContent.includes("Rolando"))'
            ),
            true,
            'history must mask each result until reveal'
        );
    await shot(alice, 'concurrent-rolling');
    await Promise.all([alice, bob, carol, duplicate].map((page) => until(page, enabled, 30000)));
    await until(
        alice,
        '[...document.querySelectorAll("#rpHistory b")].every(element=>!element.textContent.includes("Rolando"))'
    );
    const shared = await alice.ev(rows);
    assert.equal(shared.length, 3);
    assert.equal(new Set(shared.map(([id]) => id)).size, 3);
    for (const page of [bob, carol, duplicate]) assert.deepEqual(await page.ev(rows), shared);
    assert.deepEqual(
        (await alice.ev('[...seenVisualRolls]')).sort(),
        shared.map(([id]) => id).sort(),
        'a staggered roll must reach the visual queue rather than being discarded while the scene is rolling'
    );
    assert.ok(
        shared.some(([, text]) => /Bob.*Moeda.*(Cara|Coroa)/.test(text)),
        'coin is labeled with its face'
    );
    assert.equal(await other.ev('RoomUtilities.current().rolls.length'), 0);
    await shot(alice, 'concurrent-results');
    checks.push('staggered concurrent rolls, delayed reveals and one shared deduplicated history');

    const original = utilities.state(rooms.get('friends')).rolls.find((roll) => roll.peerName === 'Alice');
    const repeat = await duplicate.ev(
        `new Promise(resolve=>socket.emit('utilityRoll',${JSON.stringify({ kind: original.kind, requestId: original.requestId })},resolve))`
    );
    assert.equal(repeat.roll.id, original.id, 'retry returns the original accepted roll');
    assert.equal(utilities.state(rooms.get('friends')).rolls.length, 3);
    await alice.ev('socket.disconnect();socket.connect()');
    await until(
        alice,
        'socket.connected && RoomUtilities.current().online && RoomUtilities.current().rolls.length===3'
    );
    await until(alice, enabled);
    assert.deepEqual(await alice.ev(rows), shared);
    const returning = await open('Returning');
    await dice(returning);
    await until(returning, 'RoomUtilities.current().rolls.length===3');
    assert.deepEqual(await returning.ev(rows), shared);
    assert.notEqual(
        await returning.ev('document.getElementById("roomPlayDiceViewer").dataset.rolling'),
        'true',
        'late joins load history without replaying settled rolls'
    );
    checks.push('idempotent retry, reconnect and late join preserve history without old animations');

    for (const [width, height] of [
        [320, 740],
        [390, 844],
        [844, 390],
    ]) {
        await alice.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
        await alice.ev('dispatchEvent(new Event("resize"))');
        await dice(alice);
        await sleep(200);
        const bounds = await alice.ev(`(()=>{
            const windowElement=document.getElementById('roomPlayHub'),hub=windowElement.getBoundingClientRect(),
                bar=document.getElementById('bottomButtons').getBoundingClientRect(),
                pane=document.getElementById('rpDice');
            return {left:hub.left,right:hub.right,bottom:hub.bottom,barTop:bar.top,width:innerWidth,
                horizontalOverflow:pane.scrollWidth>pane.clientWidth+1,windowOverflow:windowElement.scrollWidth>windowElement.clientWidth+1,
                actions:[...document.querySelectorAll('[data-roll]')].map(element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height}})};
        })()`);
        assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, `${width}x${height}: window fits horizontally`);
        assert.ok(bounds.bottom <= bounds.barTop, `${width}x${height}: call toolbar remains below the window`);
        assert.equal(bounds.horizontalOverflow, false, `${width}x${height}: dice pane has no horizontal overflow`);
        assert.equal(bounds.windowOverflow, false, `${width}x${height}: window header and content fit horizontally`);
        for (const action of bounds.actions) {
            assert.ok(action.left >= bounds.left && action.right <= bounds.right + 1);
            assert.ok(action.width >= 44 && action.height >= 44, 'touch actions retain a usable target');
        }
        await click(alice, '#mic');
        assert.equal(await alice.ev('document.getElementById("mic").dataset.clicked'), 'true');
        await shot(alice, `dice-${width}x${height}`);
        if (width <= 390)
            assert.ok(
                (await visibleModelPixels(alice)) > 30,
                `${width}px: settled models remain painted after resizing`
            );
    }
    await click(alice, '[data-roll=d10]');
    await until(alice, 'RoomUtilities.current().rolls.length===4');
    await until(
        alice,
        'JSON.parse(document.getElementById("roomPlayDiceViewer").dataset.activeRollIds||"[]").length>0'
    );
    await until(
        alice,
        `(()=>{
        const pane=document.getElementById('rpDice').getBoundingClientRect(),scene=document.getElementById('rpDiceScene').getBoundingClientRect();
        return scene.top>=pane.top && scene.bottom<=pane.bottom+1;
    })()`
    );
    assert.equal(await alice.ev('document.scrollingElement.scrollTop'), 0, 'only the dice pane scrolls to the throw');
    await shot(alice, 'dice-landscape-own-roll');
    await until(alice, enabled, 20000);
    await alice.send('Emulation.clearDeviceMetricsOverride');
    checks.push('320px/390px mobile, landscape auto-scroll, usable touch actions and call controls');

    const freshMobile = await open('Mobile');
    await freshMobile.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
    });
    await dice(freshMobile);
    await until(freshMobile, enabled);
    await click(freshMobile, '[data-roll=coin]');
    await until(freshMobile, disabled);
    await until(freshMobile, enabled, 20000);
    assert.ok(
        (await visibleModelPixels(freshMobile)) > 300,
        'a scene first created on mobile has a readable physical coin'
    );
    await shot(freshMobile, 'dice-fresh-mobile-390');
    checks.push('a first throw created directly at 390px remains readable');

    const fallback = await open('Fallback', { failDice: true });
    await dice(fallback);
    await until(fallback, enabled);
    await click(fallback, '[data-roll=coin]');
    await until(fallback, disabled);
    await until(fallback, 'document.getElementById("rpDiceWho").textContent.includes("modo simples")');
    await until(fallback, enabled, 18000);
    assert.ok(
        await fallback.ev('/Cara|Coroa/.test(document.getElementById("rpDiceResult").textContent)'),
        'renderer failure still reveals the original room coin result'
    );
    await until(bob, 'RoomUtilities.current().rolls.length===6');
    assert.equal(await other.ev('RoomUtilities.current().rolls.length'), 0);
    await fallback.ev('document.getElementById("rpHistoryMore").click()');
    assert.equal(await fallback.ev('document.querySelectorAll("#rpHistory li[data-roll-id]").length'), 6);
    await shot(fallback, 'fallback-result');
    checks.push('renderer failure releases buttons, reveals the room result and preserves expandable history');
    assert.equal(errors.length, 0, JSON.stringify(errors).slice(0, 1200));
    console.log(JSON.stringify({ passed: true, checks, clients: pages.length, screenshots: shots }, null, 2));
} catch (error) {
    for (const [index, page] of pages.entries()) await shot(page, `failure-${index}`).catch(() => {});
    console.log('Browser exceptions', JSON.stringify(errors));
    console.log('Screenshots', shots);
    throw error;
} finally {
    chrome.close();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await control.writes;
}
