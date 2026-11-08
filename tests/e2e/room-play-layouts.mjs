// Real browser regressions for room layouts, interrupted requests and the shared game window.
// Isolated local rooms only: no deployed instance, desktop or microphone capture.
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
const { RoomPlayControl } = require('../../app/src/RoomPlayControl');
const { RoomUtilities } = require('../../app/src/RoomUtilities');
const { captchaRoutes } = require('../../app/src/CaptchaRoutes');
const catalog = require('../../app/src/captcha-games.json');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'room-play-layouts-'));
const shots = path.join(dataDir, 'shots');
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
    dataDir,
    policy: { targetCooldownMs: 0, proposalCooldownMs: 1500, voteGapMs: 100 },
});
const utilities = new RoomUtilities();
app.use(express.json());
// A success HTTP response with no game bridge models a frozen/unfinished player load.
app.get('/captcha/play/room.html', (req, res, next) => {
    if (!/(?:^|;\s*)auditHang=1(?:;|$)/.test(req.headers.cookie || '')) return next();
    res.type('html').send('<!doctype html><title>Unfinished local test player</title><p>Loading</p>');
});
app.use(
    ['/captcha', '/dev/captcha'],
    captchaRoutes({
        control,
        adminDir: path.join(repo, 'app/captcha-admin'),
        playerDir: path.join(repo, 'app/captcha-player'),
        adminKey: 'local-layout-regression-key-not-used-on-any-server',
    })
);
app.use(express.static(path.join(repo, 'public')));
app.get('/fixture', (_, res) =>
    res.type('html')
        .send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/RoomCaptcha.css"><style>
*{box-sizing:border-box}body{margin:0;background:#111015;color:#eee;font:14px 'Segoe UI',sans-serif}#grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:20px}.Camera,.pinned-video-container{position:relative;height:300px;overflow:hidden;border-radius:10px;background:#282234}.Camera video,.pinned-video-container video{width:100%;height:100%;background:linear-gradient(135deg,#8062ad,#335a62);object-fit:contain}.Camera img,.pinned-video-container img{width:100px;height:100px;position:absolute;left:40%;top:30%}.Camera>span,.pinned-video-container>span{position:absolute;bottom:10px;left:10px}#videoPinMediaContainer:not(:empty){width:72vw;height:66vh;margin:16px}#videoPinMediaContainer>.pinned-video-container{width:100%;height:100%}#videoPinMediaContainer:empty{display:none}#bottomButtons{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:8px;height:46px;z-index:3}button{font:inherit;color:#eee;background:#31283d;border:1px solid #ac93b2;padding:10px;border-radius:7px}#micWrap{position:relative}#audioMenu{position:absolute;bottom:50px;left:0;width:240px;height:170px;background:#554369;border:1px solid #a68bbb;padding:14px;z-index:9999}#audioMenu[hidden]{display:none}#audioMenu button{display:block;margin:5px}
</style></head><body><main id="grid"><div class="Camera" id="screenTile" data-peer-id="source"><video id="stream"></video><span>Tela compartilhada</span></div><div class="Camera" id="cameraTile" data-peer-id="camera"><video id="camera"></video><span>Câmera</span></div><div class="Camera" id="avatarTile" data-peer-id="avatar"><img class="videoAvatarImage" id="avatar" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Ccircle cx='50' cy='50' r='49' fill='teal'/%3E%3C/svg%3E"><span>Avatar</span></div></main><div id="videoPinMediaContainer"></div><div id="bottomButtons"><div id="micWrap"><button id="mic" onclick="document.getElementById('audioMenu').hidden=!document.getElementById('audioMenu').hidden">Microfone</button><div id="audioMenu" hidden><button id="audioChoice" onclick="this.dataset.clicked='true'">Microfone de teste</button><button>Outro microfone</button></div></div><button id="share">Compartilhar</button><button id="roomUtilitiesButton">Jogos</button></div>
<script src="/socket.io/socket.io.js"></script><script src="/js/RoomUtilities.js"></script><script src="/js/RoomCaptcha.js"></script><script>
const p=new URLSearchParams(location.search);window.socket=io({query:{name:p.get('name')||'Alice',room:p.get('room')||'friends',ackDelay:p.get('ackDelay')||'',closeAckDelay:p.get('closeAckDelay')||''}});socket.on('connect',()=>{RoomUtilities.connect(socket);RoomCaptcha.connect(socket)});
window.pinTile=id=>{const t=document.getElementById(id);t.className='pinned-video-container';document.getElementById('videoPinMediaContainer').append(t)};
window.unpinAll=()=>{for(const t of [...document.getElementById('videoPinMediaContainer').children]){t.className='Camera';document.getElementById('grid').append(t)}};
window.toolbarMode=vertical=>{const b=document.getElementById('bottomButtons');Object.assign(b.style,vertical?{top:'50%',left:'15px',bottom:'auto',height:'auto',width:'70px',transform:'translateY(-50%)',flexDirection:'column'}:{top:'auto',left:'50%',bottom:'16px',height:'46px',width:'auto',transform:'translateX(-50%)',flexDirection:'row'});dispatchEvent(new Event('resize'))};
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
        peer_uuid: socket.handshake.query.name,
        peer_name: socket.handshake.query.name,
    });
    utilities.bind(socket, () => room);
    const originalOn = socket.on.bind(socket);
    socket.on = (event, listener) =>
        originalOn(
            event,
            event === 'playManualStart' && socket.handshake.query.ackDelay
                ? (request, callback) =>
                      listener(request, (reply) => {
                          if (socket.data.delayedManualStart) callback(reply);
                          else {
                              socket.data.delayedManualStart = true;
                              setTimeout(() => callback(reply), 8500);
                          }
                      })
                : event === 'playClose' && socket.handshake.query.closeAckDelay
                  ? (request, callback) =>
                        listener(request, (reply) => {
                            if (request.reason !== 'load_error') return callback(reply);
                            socket.data.delayedCloseHandled = Date.now();
                            setTimeout(() => {
                                socket.data.delayedCloseAcknowledged = Date.now();
                                callback(reply);
                            }, 1500);
                        })
                  : listener
        );
    control.bind(socket, () => room);
    socket.on = originalOn;
    socket.on('disconnect', () => {
        room.peers.delete(socket.id);
        if (!room.peers.size) rooms.delete(roomId);
    });
});
const tick = setInterval(() => control.tick(), 100);
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
async function until(page, expression, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await page.ev(expression).catch(() => false)) return;
        await sleep(70);
    }
    throw new Error(`Timeout: ${expression}`);
}
async function open(name, room = 'friends', extra = '') {
    const page = await chrome.newPage();
    pages.push(page);
    const previous = page.ws.onmessage;
    page.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
        previous(event);
    };
    await page.send('Runtime.enable');
    await page.send('Page.navigate', {
        url: `${origin}/fixture?name=${encodeURIComponent(name)}&room=${encodeURIComponent(room)}${extra}`,
    });
    try {
        await until(page, 'socket.connected && !!document.getElementById("roomPlayHub")');
    } catch (error) {
        console.log('Initial page exceptions', JSON.stringify(errors));
        console.log(
            'Initial page state',
            await page.ev(
                '({socket:typeof socket,hub:!!document.getElementById("roomPlayHub"),text:document.body.innerText.slice(-400)})'
            )
        );
        throw error;
    }
    return page;
}
const frame = (expression) =>
    `document.querySelector('#rpFrameHost iframe').contentWindow.eval(${JSON.stringify(expression)})`;
async function click(page, selector) {
    const point = await page.ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`
    );
    await page.click(point.x, point.y);
}
async function shot(page, name) {
    const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(shots, `${name}.png`), Buffer.from(result.result.data, 'base64'));
}
async function showHub(page, view = 'games') {
    if (await page.ev('document.getElementById("roomPlayHub").hidden')) await click(page, '#roomUtilitiesButton');
    await page.ev(`document.querySelector('[data-view="${view}"]').click()`);
    await sleep(100);
}
async function close(page) {
    await page.ev(`document.getElementById('rpClose').click()`);
    await sleep(180);
}
async function start(page, game = 'arena') {
    await showHub(page);
    await page.ev(`document.querySelector('[data-game="${game}"]').click()`);
    await until(page, frame('document.getElementById("ready").hidden'));
}
async function check(name, fn) {
    try {
        await fn();
        checks.push({ name, passed: true });
        console.log('PASS', name);
    } catch (error) {
        checks.push({ name, passed: false, error: error.message });
        console.log('FAIL', name, error.message);
        for (const [i, p] of pages.entries()) await shot(p, `failure-${checks.length}-${i}`).catch(() => {});
        // A failure must not leave fullscreen, an assignment or a hidden grid for the next check.
        for (const page of pages) await reset(page).catch(() => {});
        for (const peerId of [...control.active.keys()]) control.release(peerId, 'test_cleanup');
    }
}
async function reset(page) {
    await page.ev(
        `(async()=>{if(document.fullscreenElement)await document.exitFullscreen();document.cookie='auditHang=;Max-Age=0;path=/';unpinAll();toolbarMode(false);document.getElementById('audioMenu').hidden=true;document.getElementById('grid').style.display='grid';document.querySelectorAll('.Camera').forEach(t=>{t.style.width='';t.style.height=''})})()`
    );
    await close(page);
}
try {
    const alice = await open('Alice'),
        bob = await open('Bob'),
        carol = await open('Carol'),
        dave = await open('Dave'),
        eve = await open('Eve'),
        other = await open('Other', 'other');
    const aid = await alice.ev('socket.id'),
        bid = await bob.ev('socket.id');
    await check('grid blur is target-local and leaves call actions usable', async () => {
        control.trigger({ roomId: 'friends', peerId: aid, gameId: 'rain' });
        await until(alice, 'document.body.classList.contains("room-captcha-blur")');
        for (const id of ['stream', 'camera', 'avatar'])
            assert.equal(await alice.ev(`getComputedStyle(document.getElementById('${id}')).filter`), 'blur(14px)');
        for (const page of [bob, carol, dave, eve, other])
            assert.equal(await page.ev('document.body.classList.contains("room-captcha-blur")'), false);
        await click(alice, '#mic');
        assert.equal(await alice.ev('document.getElementById("audioMenu").hidden'), false);
        await alice.ev('document.getElementById("audioMenu").hidden=true');
    });
    await check('pinned screen and avatar retain local blur and verification access', async () => {
        for (const [tile, visual] of [
            ['screenTile', 'stream'],
            ['avatarTile', 'avatar'],
        ]) {
            await alice.ev(`unpinAll();pinTile('${tile}')`);
            await sleep(200);
            assert.equal(await alice.ev(`getComputedStyle(document.getElementById('${visual}')).filter`), 'blur(14px)');
            const available = await alice.ev(
                `!!document.querySelector('#${tile} .rp-captcha-prompt') || !document.getElementById('roomPlayChallenge').hidden`
            );
            assert.ok(available);
        }
        await shot(alice, 'pinned-verification');
        await alice.ev('unpinAll()');
    });
    await check('tiny tile uses a bounded indicator and empty grid keeps one main invitation', async () => {
        await alice.ev(`Object.assign(document.getElementById('screenTile').style,{width:'100px',height:'100px'})`);
        await sleep(120);
        const fit = await alice.ev(
            `(()=>{const t=document.getElementById('screenTile').getBoundingClientRect(),p=document.querySelector('#screenTile .rp-captcha-prompt');if(!p)return false;const b=p.getBoundingClientRect();return b.left>=t.left&&b.right<=t.right&&p.scrollWidth<=p.clientWidth+2})()`
        );
        assert.ok(fit);
        await alice.ev('document.getElementById("grid").style.display="none"');
        await until(
            alice,
            '!!document.getElementById("roomPlayChallenge") && !document.getElementById("roomPlayChallenge").hidden'
        );
        assert.equal(await alice.ev('document.querySelectorAll("#roomPlayChallenge").length'), 1);
        const hit = await alice.ev(
            `(()=>{const b=document.getElementById('rpChallengeStart'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`
        );
        assert.ok(hit);
        await shot(alice, 'empty-grid-invitation');
        await alice.ev('document.getElementById("grid").style.display="grid"');
    });
    await check('video fullscreen invitation is visible and game starts only after leaving it', async () => {
        await alice.ev(`document.getElementById('screenTile').requestFullscreen()`);
        await sleep(150);
        const selector = await alice.ev(
            `!document.getElementById('roomPlayChallenge').hidden?'#rpChallengeStart':'#screenTile .rp-captcha-prompt'`
        );
        const visible = await alice.ev(
            `(()=>{const b=document.querySelector('${selector}'),r=b.getBoundingClientRect();return document.fullscreenElement.contains(b)&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`
        );
        assert.ok(visible);
        await click(alice, selector);
        await until(alice, frame('document.getElementById("ready").hidden'));
        assert.equal(await alice.ev('document.fullscreenElement'), null);
        const hit = await alice.ev(
            `(()=>{const h=document.getElementById('roomPlayHub'),r=h.getBoundingClientRect();return h.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`
        );
        assert.ok(hit);
        await reset(alice);
    });
    await check('full application fullscreen keeps the game visible', async () => {
        await alice.ev('document.documentElement.requestFullscreen()');
        await start(alice);
        assert.equal(await alice.ev('document.fullscreenElement===document.documentElement'), true);
        const visible = await alice.ev(
            `(()=>{const h=document.getElementById('roomPlayHub'),r=h.getBoundingClientRect();return document.fullscreenElement.contains(h)&&h.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`
        );
        assert.ok(visible);
        await reset(alice);
    });
    await check('maximized window reserves the left call toolbar', async () => {
        await alice.ev('toolbarMode(true)');
        await showHub(alice);
        await click(alice, '#rpMaximize');
        await sleep(150);
        const geometry = await alice.ev(
            `(()=>{const b=document.getElementById('bottomButtons').getBoundingClientRect(),h=document.getElementById('roomPlayHub').getBoundingClientRect(),m=document.getElementById('mic'),r=m.getBoundingClientRect();return {reserved:h.left>=b.right+4,hit:m.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`
        );
        assert.ok(geometry.reserved, JSON.stringify(geometry));
        assert.ok(geometry.hit);
        await shot(alice, 'left-toolbar');
        await reset(alice);
    });
    await check('expanded microphone menu stays clickable above the window', async () => {
        await showHub(alice);
        await click(alice, '#mic');
        await sleep(100);
        const hit = await alice.ev(
            `(()=>{const b=document.getElementById('audioChoice'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`
        );
        assert.ok(hit);
        await click(alice, '#audioChoice');
        assert.equal(await alice.ev('document.getElementById("audioChoice").dataset.clicked'), 'true');
        await reset(alice);
    });
    await check('pending verification preserves a manual game and is resumable from Ranking', async () => {
        await start(bob);
        await bob.ev('document.getElementById("rpPause").click()');
        await sleep(100);
        const assignment = control.active.get(bid),
            attemptId = assignment.currentAttempt;
        await bob.ev('window.auditFrame=document.querySelector("#rpFrameHost iframe")');
        control.trigger({ roomId: 'friends', peerId: bid, gameId: 'rain' });
        await until(bob, 'document.getElementById("rpPendingText").textContent.includes("aguarda")');
        assert.equal(control.active.get(bid).id, assignment.id);
        assert.equal(control.active.get(bid).currentAttempt, attemptId);
        assert.equal(await bob.ev('document.body.classList.contains("room-captcha-blur")'), false);
        await bob.ev('document.getElementById("rpBack").click()');
        await showHub(bob, 'ranking');
        await click(bob, '#rpMinimize');
        await click(bob, '#rpRestore');
        await until(bob, '!document.getElementById("rpContinue").hidden');
        await click(bob, '#rpContinue');
        assert.equal(await bob.ev('document.querySelector("#rpFrameHost iframe")===window.auditFrame'), true);
        await reset(bob);
        assert.equal(control.pending.has(bid), false);
        assert.equal(control.active.has(bid), false);
    });
    await check(
        'a delayed manual-start acknowledgment remains recoverable and cannot duplicate the match',
        async () => {
            const slow = await open('Slow', 'friends', '&ackDelay=1'),
                id = await slow.ev('socket.id');
            await showHub(slow);
            await slow.ev('document.querySelector("[data-game=arena]").click()');
            await sleep(8150);
            if (!(await slow.ev('!!document.querySelector("#rpFrameHost iframe")'))) {
                const selector = await slow.ev(
                    `!document.getElementById('rpContinue').hidden?'#rpContinue':!document.getElementById('rpResume').hidden?'#rpResume':null`
                );
                assert.ok(selector, 'accepted assignment must have a visible recovery action');
                await click(slow, selector);
            }
            await until(slow, frame('document.getElementById("ready").hidden'));
            await slow.ev('document.querySelector("#rpFrameHost iframe").dataset.auditKept="true"');
            await sleep(600);
            assert.equal(await slow.ev('document.querySelector("#rpFrameHost iframe").dataset.auditKept'), 'true');
            assert.equal(control.active.get(id).attempts.length, 1);
            await reset(slow);
        }
    );
    await check('an unfinished player load releases the assignment permanently after its timeout', async () => {
        await alice.ev('document.cookie="auditHang=1;path=/"');
        control.trigger({ roomId: 'friends', peerId: aid, gameId: 'rain' });
        await until(alice, '!document.getElementById("roomPlayChallenge").hidden');
        await click(alice, '#rpChallengeStart');
        await until(alice, '!!document.querySelector("#rpFrameHost iframe")');
        await until(
            alice,
            '!document.body.classList.contains("room-captcha-blur") && !document.querySelector("#rpFrameHost iframe")',
            23000
        );
        assert.equal(control.active.has(aid), false);
        await alice.ev('dispatchEvent(new Event("resize"))');
        await sleep(2800);
        assert.equal(await alice.ev('document.body.classList.contains("room-captcha-blur")'), false);
        await reset(alice);
    });
    await check('a late load-timeout close acknowledgment cannot replace reopened Ranking or a new match', async () => {
        const ranking = await open('RaceRanking', 'friends', '&closeAckDelay=1'),
            match = await open('RaceMatch', 'friends', '&closeAckDelay=1');
        const ids = await Promise.all([ranking, match].map((page) => page.ev('socket.id')));
        await Promise.all(
            [ranking, match].map(async (page, i) => {
                await page.ev('document.cookie="auditHang=1;path=/"');
                control.trigger({ roomId: 'friends', peerId: ids[i], gameId: 'rain' });
                await until(page, '!document.getElementById("roomPlayChallenge").hidden');
                await click(page, '#rpChallengeStart');
                await until(page, '!!document.querySelector("#rpFrameHost iframe")');
            })
        );
        await Promise.all(
            [ranking, match].map((page) =>
                until(
                    page,
                    '!document.querySelector("#rpFrameHost iframe") && document.getElementById("roomPlayHub").hidden',
                    23000
                )
            )
        );
        for (const id of ids) {
            assert.equal(control.active.has(id), false);
            const socket = io.sockets.sockets.get(id);
            assert.ok(socket.data.delayedCloseHandled, 'server must already have handled the close mutation');
            assert.equal(socket.data.delayedCloseAcknowledged, undefined, 'interaction must occur before the late ACK');
        }
        await ranking.ev('document.cookie="auditHang=;Max-Age=0;path=/"');
        await match.ev('document.cookie="auditHang=;Max-Age=0;path=/"');
        await Promise.all([showHub(ranking, 'ranking'), start(match)]);
        await match.ev('window.raceFrame=document.querySelector("#rpFrameHost iframe")');
        const newAssignment = control.active.get(ids[1]).id;
        await sleep(1700);
        for (const id of ids) assert.ok(io.sockets.sockets.get(id).data.delayedCloseAcknowledged);
        assert.equal(await ranking.ev('document.getElementById("rpRanking").hidden'), false);
        assert.equal(
            await ranking.ev('document.querySelector("[data-view=ranking]").getAttribute("aria-current")'),
            'page'
        );
        assert.equal(
            await ranking.ev('document.getElementById("rpStatus").textContent.includes("não carregou")'),
            false
        );
        assert.equal(await match.ev('document.querySelector("#rpFrameHost iframe")===window.raceFrame'), true);
        assert.equal(await match.ev('document.getElementById("rpStage").hidden'), false);
        assert.equal(await match.ev('document.getElementById("rpStatus").textContent.includes("não carregou")'), false);
        assert.equal(control.active.get(ids[1]).id, newAssignment);
        await Promise.all([reset(ranking), reset(match)]);
    });
    await check('a refused proposal recovers after its author cooldown without changing targets', async () => {
        await showHub(carol, 'vote');
        await until(carol, '!!document.getElementById("rpVoteTarget")?.options.length');
        const cid = await carol.ev('socket.id');
        await carol.ev(
            `document.getElementById('rpVoteTarget').value=${JSON.stringify(aid)};document.getElementById('rpVoteTarget').dispatchEvent(new Event('change'))`
        );
        control.proposalAt.set(control.identity('friends', cid), Date.now() + 900);
        await click(carol, '#rpPropose');
        await until(carol, 'document.getElementById("rpStatus").textContent.includes("Aguarde")');
        await sleep(1100);
        await until(carol, '!document.getElementById("rpPropose").disabled', 4500);
        await reset(carol);
    });
    await check('a full vote queue gives feedback and permits a later valid proposal', async () => {
        const targetIds = [bob, dave, eve, alice];
        const ids = await Promise.all(targetIds.map((page) => page.ev('socket.id')));
        const slow = control.uniquePeers('friends').find((p) => p.peer.peer_name === 'Slow');
        assert.ok(slow);
        await showHub(carol, 'vote');
        await carol.ev(
            `document.getElementById('rpVoteTarget').value=${JSON.stringify(slow.id)};document.getElementById('rpVoteTarget').dispatchEvent(new Event('change'))`
        );
        for (const peerId of ids) control.openVote({ roomId: 'friends', peerId, gameId: 'rain' });
        await carol.ev('document.getElementById("rpPropose").click()');
        await until(carol, 'document.getElementById("rpStatus").textContent.toLowerCase().includes("fila")');
        const queue = [...control.votes.values()].filter((v) => ['open', 'queued'].includes(v.status));
        assert.equal(queue.length, 4);
        control.cancelVote(queue.find((v) => v.status === 'queued').id);
        await until(carol, '!document.getElementById("rpPropose").disabled');
        await carol.ev('document.getElementById("rpPropose").click()');
        const cid = await carol.ev('socket.id');
        await until(carol, '/Proposta na fila|Voto enviado/.test(document.getElementById("rpStatus").textContent)');
        assert.ok(
            [...control.votes.values()].some(
                (v) => v.authorKey === control.identity('friends', cid) && ['open', 'queued'].includes(v.status)
            )
        );
        for (const vote of control.votes.values()) control.cancelVote(vote.id);
        await reset(carol);
    });
    assert.equal(errors.length, 0, JSON.stringify(errors).slice(0, 1200));
    console.log(JSON.stringify({ passed: checks.every((x) => x.passed), checks, screenshots: shots }, null, 2));
    if (checks.some((x) => !x.passed)) process.exitCode = 1;
} finally {
    clearInterval(tick);
    chrome.close();
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await control.writes;
}
