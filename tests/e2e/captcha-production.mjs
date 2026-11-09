// Read-only production smoke: own admin session, no meeting joins, assignments or settings changes.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChrome, sleep } from './lib.mjs';

const origin = 'https://livestream.grupogrowon.com.br';
const key = readFileSync(process.env.CAPTCHA_KEY_FILE, 'utf8').trim();
const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    width: 1440,
    height: 1000,
});
let token;
try {
    const unauthorized = await fetch(origin + '/captcha/api/state');
    assert.equal(unauthorized.status, 401);
    const page = await chrome.newPage(origin + '/captcha/');
    const until = async (expression) => {
        const end = Date.now() + 12000;
        while (Date.now() < end) {
            if (await page.ev(expression).catch(() => false)) return;
            await sleep(100);
        }
        throw new Error(`Timeout: ${expression}`);
    };
    await until('typeof document.getElementById("loginForm")?.onsubmit === "function"');
    await page.ev(
        `document.getElementById('key').value=${JSON.stringify(key)};document.getElementById('loginForm').requestSubmit()`
    );
    await until('!document.getElementById("dashboard").hidden');
    token = await page.ev('sessionStorage.getItem("captcha-admin-token")');
    assert.ok(token);
    assert.equal(await page.ev('document.getElementById("voteRequired").value'), '35');
    assert.equal(await page.ev('document.body.innerText.includes("AMBIENTE DE DESENVOLVIMENTO")'), false);
    const stateResponse = await fetch(origin + '/captcha/api/state', { headers: { Authorization: `Bearer ${token}` } });
    assert.ok(stateResponse.ok);
    const state = await stateResponse.json();
    assert.equal(state.catalog.length, 14);
    assert.equal(state.storageError, null);
    const player = await fetch(origin + '/captcha/play/room.html');
    assert.equal(player.status, 200);
    assert.equal(player.headers.get('x-frame-options'), 'SAMEORIGIN');
    const script = await (await fetch(origin + '/js/RoomCaptcha.js')).text();
    assert.ok(script.includes("frame.src = '/captcha/play/room.html'"));
    assert.ok(script.includes('deve passar pelo Boiolômetro?'));
    assert.ok(script.includes("hub.id = 'roomPlayHub'"));
    assert.ok(script.includes('rpRollStatus'));
    const room = await fetch(origin + '/join/link');
    assert.equal(room.status, 200);
    assert.ok((await room.text()).includes('aria-controls="roomPlayHub"'));
    const dice = await fetch(origin + '/captcha/play/dice.js');
    assert.equal(dice.status, 200);
    assert.equal(dice.headers.get('cache-control'), 'no-cache');
    const shots = path.join(tmpdir(), 'captcha-production-shots');
    mkdirSync(shots, { recursive: true });
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(shots, 'control.png'), Buffer.from(shot.result.data, 'base64'));
    console.log(
        `PASS production: private login, protected API, 14 games, game hub, shared dice module and room integration. No participant or setting changed. Screenshot: ${shots}`
    );
} finally {
    if (token)
        await fetch(origin + '/captcha/api/logout', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
        }).catch(() => {});
    chrome.close();
}
