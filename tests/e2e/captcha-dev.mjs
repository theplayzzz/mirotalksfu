// Opt-in smoke test against DEVELOPMENT ONLY. Own named peers, synthetic screen,
// and a short-lived test-room token; never captures a real desktop or microphone.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChrome, joinTestRoom, stubScreenCapture, startScreenShare, sleep } from './lib.mjs';
const origin = 'https://mirotalk-dev.40-160-143-32.sslip.io';
const key = readFileSync(process.env.CAPTCHA_KEY_FILE, 'utf8').trim();
const roomToken = readFileSync(process.env.CAPTCHA_TEST_TOKEN_FILE, 'utf8').trim();
const shots = path.join(tmpdir(), 'captcha-development-shots');
mkdirSync(shots, { recursive: true });
const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    width: 1440,
    height: 1000,
});
let adminToken, targetId;
const pages = [],
    names = ['CAPTCHA-verificacao-fonte', 'CAPTCHA-verificacao-jogador'];
async function api(route, body) {
    const response = await fetch(origin + '/dev/captcha' + route, {
        method: body ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    assert.ok(response.ok, data.error);
    return data;
}
async function until(page, expr, timeout = 18000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await page.ev(expr).catch(() => false)) return;
        await sleep(150);
    }
    throw new Error(`Timeout: ${expr}`);
}
const child = (expression) =>
    `document.querySelector('#rpFrameHost iframe').contentWindow.eval(${JSON.stringify(expression)})`;
async function shot(page, name) {
    const r = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.result.data, 'base64'));
}
try {
    adminToken = (await api('/login', { key })).token;
    let state = await api('/api/state');
    assert.ok(
        !state.rooms.some((room) => room.id === 'teste' && room.users.some((user) => !names.includes(user.name))),
        'Only use the isolated test room when it has no other participants.'
    );
    const source = await chrome.newPage(),
        player = await chrome.newPage();
    pages.push(source, player);
    await stubScreenCapture(source, { width: 640, height: 360, fps: 15, withAudio: true });
    await joinTestRoom(source, { origin, token: roomToken, name: names[0] });
    await joinTestRoom(player, { origin, token: roomToken, name: names[1] });
    await startScreenShare(source);
    await until(
        player,
        '[...document.querySelectorAll("video[data-room-captcha-screen=true]")].some(v=>v.videoWidth>0 && v.readyState>=2)'
    );
    await until(player, '[...rc.consumers.values()].some(c=>c.kind==="audio" && !c.closed)');
    state = await api('/api/state');
    const room = state.rooms.find((r) => r.id === 'teste');
    targetId = room.users.find((u) => u.name === names[1]).id;
    assert.equal(room.users.find((u) => u.id === targetId).ready, true);
    await api('/api/trigger', { roomId: 'teste', peerId: targetId, gameId: 'juggle' });
    await until(player, '!!document.querySelector(".rp-captcha-prompt:not([hidden])")');
    assert.equal(
        await player.ev('getComputedStyle(document.querySelector(".rp-captcha-prompt b")).color'),
        'rgb(247, 242, 252)'
    );
    assert.equal(await player.ev('!!document.querySelector("#rpFrameHost iframe")'), false);
    assert.equal(await source.ev('!!document.querySelector("#rpFrameHost iframe")'), false);
    const framesBefore = await player.ev(
        'document.querySelector("video[data-room-captcha-screen=true]").getVideoPlaybackQuality().totalVideoFrames'
    );
    assert.equal(
        await player.ev('getComputedStyle(document.querySelector("video[data-room-captcha-screen=true]")).filter'),
        'blur(14px)'
    );
    await sleep(1500);
    assert.ok(
        await player.ev(
            `document.querySelector('video[data-room-captcha-screen=true]').getVideoPlaybackQuality().totalVideoFrames>${framesBefore}`
        ),
        'Stream keeps receiving and decoding under blur.'
    );
    assert.ok(await player.ev('rc.socket.connected && !rc.consumerTransport.closed'));
    assert.ok(
        await source.ev(
            '[...rc.producers.values()].filter(p=>p.kind==="video").every(p=>!p.closed && p.track.readyState==="live")'
        )
    );
    assert.ok(
        await source.ev(
            '[...rc.producers.values()].some(p=>p.kind==="audio" && !p.closed && p.track.readyState==="live")'
        )
    );
    await shot(player, 'real-room-prompt');
    const button = await player.ev(
        '(()=>{const r=document.querySelector(".rp-captcha-prompt:not([hidden])").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()'
    );
    await player.click(button.x, button.y);
    await until(player, child('!document.getElementById("result").hidden'), 18000);
    // The local result precedes its server acknowledgment across the public TLS connection.
    await until(player, '!document.body.classList.contains("room-captcha-blur")');
    await until(player, child('document.getElementById("resultScore").textContent.includes("registrada")'));
    assert.equal(await player.ev('document.body.classList.contains("room-captcha-blur")'), false);
    await player.ev(child('document.querySelectorAll("#stars button")[4].click()'));
    await until(player, child('document.getElementById("ratingStatus").textContent.includes("registrada")'));
    await shot(player, 'real-room-result');
    const after = await api('/api/state');
    assert.ok(after.attempts.some((a) => a.name === names[1] && a.outcome));
    await api('/api/release', { peerId: targetId });
    console.log(
        `PASS development: actual SFU peers, synthetic video + audio screen, targeted delivery, live decoding under blur, game completion and rating persistence. Screenshots: ${shots}`
    );
} finally {
    if (targetId) await api('/api/release', { peerId: targetId }).catch(() => {});
    if (adminToken) await api('/api/logout', {}).catch(() => {});
    for (const page of pages) {
        await page.ev('rc?.exit()').catch(() => {});
        await page.close().catch(() => {});
    }
    chrome.close();
}
