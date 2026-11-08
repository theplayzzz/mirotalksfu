// Opt-in DEVELOPMENT-ONLY smoke against the real room/server bindings.
// Needs CAPTCHA_KEY_FILE and CAPTCHA_TEST_TOKEN_FILE, just like captcha-dev.mjs.
// Uses three isolated Chrome profiles and the empty test room; no real media capture.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChrome, joinTestRoom, sleep } from './lib.mjs';

const origin = 'https://mirotalk-dev.40-160-143-32.sslip.io';
const key = readFileSync(process.env.CAPTCHA_KEY_FILE, 'utf8').trim();
const roomToken = readFileSync(process.env.CAPTCHA_TEST_TOKEN_FILE, 'utf8').trim();
const names = ['DADOS-QA-Alice', 'DADOS-QA-Bob', 'DADOS-QA-Carol'];
const shots = path.join(tmpdir(), 'room-dice-development-shots');
mkdirSync(shots, { recursive: true });
const browsers = [],
    pages = [],
    checks = [];
let adminToken;

async function api(route, body) {
    const response = await fetch(origin + '/captcha' + route, {
        method: body ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    assert.ok(response.ok, data.error || `HTTP ${response.status}`);
    return data;
}
async function until(page, expression, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await page.ev(expression).catch(() => false)) return;
        await sleep(100);
    }
    throw new Error(`Timeout: ${expression}`);
}
async function shot(page, name) {
    const result = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path.join(shots, name + '.png'), Buffer.from(result.result.data, 'base64'));
}
async function dice(page) {
    await until(page, '!!window.RoomUtilities && RoomUtilities.current().online && !RoomUtilities.current().busy');
    await page.ev(`
        showButtons();
        if(document.getElementById('roomPlayHub').hidden)document.getElementById('roomUtilitiesButton').click();
        document.querySelector('[data-view=dice]').click();
    `);
    await until(page, '!document.getElementById("rpDice").hidden');
}
async function click(page, selector) {
    const point = await page.ev(`(()=>{
        const element=document.querySelector(${JSON.stringify(selector)});
        element.scrollIntoView({block:'nearest'});
        const r=element.getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await page.click(point.x, point.y);
}
const enabled = '[...document.querySelectorAll("[data-roll]")].every(button=>!button.disabled)';
const disabled = '[...document.querySelectorAll("[data-roll]")].every(button=>button.disabled)';
const rows =
    '[...document.querySelectorAll("#rpHistory li[data-roll-id]")].map(element=>[element.dataset.rollId,element.textContent])';

try {
    adminToken = (await api('/login', { key })).token;
    const before = await api('/api/state');
    assert.ok(
        !before.rooms.some((room) => room.id === 'teste' && room.users.length),
        'The isolated development test room must be empty; never run this smoke alongside existing participants.'
    );
    for (const name of names) {
        const browser = await launchChrome({
            chrome: process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            width: 1440,
            height: 1000,
            extraFlags: ['--use-fake-device-for-media-stream'],
        });
        browsers.push(browser);
        const page = await browser.newPage();
        pages.push(page);
        await joinTestRoom(page, { origin, token: roomToken, name });
        assert.equal(
            await page.ev('rc.producers.size'),
            0,
            'All test participants join without camera, microphone or screen'
        );
        await dice(page);
    }
    const joined = await api('/api/state'),
        room = joined.rooms.find((entry) => entry.id === 'teste');
    assert.ok(room);
    assert.deepEqual(
        room.users.map((user) => user.name).sort(),
        [...names].sort(),
        'Only the three named QA peers may be present'
    );
    const identities = await Promise.all(pages.map((page) => page.ev('rc.peer_uuid')));
    assert.equal(identities.filter(Boolean).length, 3);
    assert.equal(
        new Set(identities).size,
        3,
        'Separate Chrome profiles must produce three independent room identities'
    );
    checks.push('three independent identities in the isolated room, without any real media capture');

    const [alice, bob, carol] = pages;
    await Promise.all(pages.map((page) => until(page, enabled)));
    assert.equal(await alice.ev('RoomUtilities.current().rolls.length'), 0);
    await alice.ev(`for(let i=0;i<70;i++)document.querySelector('[data-roll=d6]').click()`);
    await until(alice, 'RoomUtilities.current().rolls.length===1');
    assert.equal(await alice.ev(disabled), true, 'The first click immediately locks all four actions');
    assert.equal(await bob.ev(enabled), true, 'Another person is free to start their own roll');
    await click(bob, '[data-roll=coin]');
    await sleep(300);
    await click(carol, '[data-roll=d20]');
    await Promise.all(pages.map((page) => until(page, 'RoomUtilities.current().rolls.length===3')));
    for (const page of pages) {
        assert.equal(await page.ev(disabled), true);
        assert.equal(
            await page.ev(
                '[...document.querySelectorAll("#rpHistory b")].every(element=>element.textContent.includes("Rolando"))'
            ),
            true,
            'Every history masks all three outcomes while their server reveal times are pending'
        );
    }
    const accepted = await alice.ev('RoomUtilities.current().rolls');
    assert.equal(new Set(accepted.map((roll) => roll.id)).size, 3);
    for (const roll of accepted) assert.equal(roll.revealAt - roll.at, 4000);
    const sampleAt = Math.min(...accepted.map((roll) => roll.revealAt)) - 500;
    await shot(alice, '01-concurrent-rolling');
    const waitNearReveal = sampleAt - (await alice.ev('RoomUtilities.now()'));
    assert.ok(waitNearReveal > 0, 'Check masking before the first six-second reveal');
    await sleep(waitNearReveal);
    for (const page of pages)
        assert.equal(await page.ev(disabled), true, 'Buttons stay inactive throughout the physical roll');
    assert.equal(
        await alice.ev(
            '[...document.querySelectorAll("#rpHistory b")].every(element=>element.textContent.includes("Rolando"))'
        ),
        true
    );
    checks.push(
        'rapid clicks accept one roll; staggered d6, coin and d20 remain independently locked for four seconds'
    );

    await Promise.all(pages.map((page) => until(page, enabled, 35000)));
    await Promise.all(
        pages.map((page) =>
            until(
                page,
                '[...document.querySelectorAll("#rpHistory b")].every(element=>!element.textContent.includes("Rolando"))'
            )
        )
    );
    const shared = await alice.ev(rows);
    assert.equal(shared.length, 3, 'Rapid clicking cannot create hidden extra server rolls');
    assert.equal(new Set(shared.map(([id]) => id)).size, 3);
    for (const page of [bob, carol]) assert.deepEqual(await page.ev(rows), shared);
    assert.ok(
        shared.some(([, text]) => /DADOS-QA-Bob.*Moeda.*(Cara|Coroa)/.test(text)),
        'Coin result is named Cara or Coroa'
    );
    for (const page of pages)
        assert.ok(
            await page.ev('!!document.querySelector("#rpDiceScene canvas")'),
            'The deployed physical renderer must load'
        );
    await shot(alice, '02-shared-results');
    checks.push(
        'identical shared history, explicit coin face, deduplication and buttons released after queued animation'
    );

    await carol.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
    });
    await carol.ev('showButtons();dispatchEvent(new Event("resize"))');
    await sleep(250);
    const geometry = await carol.ev(`(()=>{
        const pane=document.getElementById('rpDice'),windowElement=document.getElementById('roomPlayHub'),
            hub=windowElement.getBoundingClientRect(),bar=document.getElementById('bottomButtons').getBoundingClientRect();
        return {left:hub.left,right:hub.right,bottom:hub.bottom,barTop:bar.top,barHeight:bar.height,width:innerWidth,
            paneOverflow:pane.scrollWidth>pane.clientWidth+1,windowOverflow:windowElement.scrollWidth>windowElement.clientWidth+1,
            actions:[...document.querySelectorAll('[data-roll]')].map(element=>{const r=element.getBoundingClientRect();return {width:r.width,height:r.height}})};
    })()`);
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width + 1, 'Mobile window fits the real room viewport');
    assert.equal(geometry.paneOverflow, false);
    assert.equal(geometry.windowOverflow, false);
    if (geometry.barHeight > 0) assert.ok(geometry.bottom <= geometry.barTop, 'Call toolbar remains accessible');
    for (const action of geometry.actions) assert.ok(action.width >= 44 && action.height >= 44);
    await shot(carol, '03-mobile-390');
    checks.push('390px real-room viewport with no horizontal overflow, touch targets and preserved call toolbar');
    console.log(JSON.stringify({ passed: true, environment: origin, clients: 3, checks, screenshots: shots }, null, 2));
} catch (error) {
    for (const [index, page] of pages.entries()) await shot(page, `failure-${index}`).catch(() => {});
    console.log('Screenshots', shots);
    throw error;
} finally {
    for (const page of pages) {
        await page.ev('rc?.exit()').catch(() => {});
        await page.close().catch(() => {});
    }
    for (const browser of browsers) browser.close();
    if (adminToken) await api('/api/logout', {}).catch(() => {});
}
