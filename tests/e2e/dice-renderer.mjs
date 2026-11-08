import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChrome, sleep } from './lib.mjs';
const require = createRequire(import.meta.url),
    express = require('express');
const shots = mkdtempSync(path.join(tmpdir(), 'dice-renderer-'));
const app = express();
app.use('/captcha/play', express.static('app/captcha-player'));
app.get('/', (_, res) =>
    res.send(
        '<!doctype html><html><body style="background:#211c2c"><div id="scene" style="width:600px;height:300px"></div></body></html>'
    )
);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const chrome = await launchChrome({
    chrome: process.env.E2E_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    extraFlags: ['--enable-unsafe-swiftshader'],
});
async function until(page, expression, timeout = 9000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await page.ev(expression)) return;
        await sleep(100);
    }
    throw new Error(`Timeout: ${expression}`);
}
async function shot(page, name) {
    const clip = await page.ev(
        `(()=>{const r=document.getElementById('scene').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:2}})()`
    );
    const r = await page.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    return r.result.data;
}
async function visiblePixels(page, screenshot) {
    return page.ev(`(async()=>{
        const image=new Image();image.src=${JSON.stringify('data:image/png;base64,')}+${JSON.stringify(screenshot)};
        await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let count=0;
        for(let i=0;i<pixels.length;i+=4)if(Math.abs(pixels[i]-33)+Math.abs(pixels[i+1]-28)+Math.abs(pixels[i+2]-44)>60)count++;
        return count;
    })()`);
}
function motion(samples, index) {
    const frames = samples.map((s) => s.dice[index]).filter(Boolean);
    let radians = 0,
        bounces = 0,
        downward = false;
    for (let i = 1; i < frames.length; i++) {
        const previous = frames[i - 1],
            current = frames[i];
        const dot = Math.abs(current.quaternion.reduce((sum, q, j) => sum + q * previous.quaternion[j], 0));
        radians += 2 * Math.acos(Math.min(1, dot));
        const delta = current.position[2] - previous.position[2];
        if (delta < -1) downward = true;
        else if (delta > 1 && downward) {
            bounces++;
            downward = false;
        }
    }
    return { frames: frames.length, radians, bounces };
}
try {
    const page = await chrome.newPage(`http://127.0.0.1:${server.address().port}`);
    await page.send('Runtime.enable');
    const errors = [];
    const incoming = page.ws.onmessage;
    page.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') {
            errors.push(message.params);
            console.log('Browser exception', JSON.stringify(message.params));
        }
        incoming(event);
    };
    await sleep(300);
    const loaded = await page.ev(
        `(async()=>{try{const m=await import('/captcha/play/dice.js');window.scene=await m.createDiceScene(document.getElementById('scene'));return {ok:true};}catch(e){return {error:e.message,stack:e.stack};}})()`
    );
    assert.ok(loaded.ok, JSON.stringify(loaded));
    await page.ev(`window.samples=[];window.started=performance.now();window.done=null;
        window.sampler=setInterval(()=>samples.push(scene.snapshot()),16);
        scene.roll([{id:'a',kind:'d6',value:4},{id:'b',kind:'d10',value:10},{id:'c',kind:'d20',value:20},{id:'d',kind:'coin',value:2}]).then(result=>{window.done={result,elapsed:performance.now()-started};clearInterval(sampler)});void 0`);
    assert.equal(
        await page.ev(`scene.roll([{kind:'d6',value:1}]).then(()=>false,()=>true)`),
        true,
        'An overlapping call must not replace the in-flight throw.'
    );
    await sleep(1100);
    await shot(page, 'tumbling');
    await page.ev(
        `document.getElementById('scene').style.width='320px';document.getElementById('scene').style.height='260px'`
    );
    await until(page, '!!window.done');
    const done = await page.ev('window.done');
    assert.deepEqual(
        done.result.sets.map((s) => s.total),
        [4, 10, 20, 2]
    );
    assert.equal(done.result.sets[3].rolls[0].label, 'COROA');
    assert.ok(done.elapsed >= 3200 && done.elapsed <= 4000, `Readable toss duration: ${done.elapsed}`);
    const samples = await page.ev('window.samples');
    const metrics = ['d6', 'd10', 'd20', 'coin'].map((kind, index) => ({ kind, ...motion(samples, index) }));
    console.log('Measured physical motion', JSON.stringify(metrics));
    for (const die of metrics) {
        assert.ok(die.frames > 25, `${die.kind} animates over many visible frames`);
        assert.ok(die.radians > Math.PI * 2, `${die.kind} visibly tumbles more than one turn: ${die.radians}`);
        assert.ok(die.bounces >= 1, `${die.kind} rebounds rather than only dropping: ${die.bounces}`);
    }
    assert.deepEqual(samples.at(-1).dice[3].faces, ['coin-cara', 'coin-coroa']);
    console.log('Settled mixed coin', await page.ev('scene.snapshot().dice[3]'));
    assert.equal(await page.ev('scene.snapshot().dice[3].visibleCoinFace'), 'coin-coroa');
    assert.ok(
        await page.ev('scene.snapshot().dice[3].coinUpAlignment > .80'),
        'The mixed-batch coin keeps at least 80% projected face area when supported by another die or wall'
    );
    await shot(page, 'batch-settled-mobile');
    for (const width of [390, 320]) {
        await page.ev(`document.getElementById('scene').style.width='${width}px'`);
        await sleep(200);
        const png = await shot(page, `idle-resize-${width}`);
        assert.ok(
            (await visiblePixels(page, png)) > 300,
            `Settled dice must remain painted after idle resize to ${width}px`
        );
    }
    console.log(
        'PASS physical tumble, rebound, 3.4s playback, overlapping-call guard and resize',
        JSON.stringify(metrics)
    );
    for (const [value, label] of [
        [1, 'CARA'],
        [2, 'COROA'],
    ]) {
        const result = await page.ev(`scene.roll([{kind:'coin',value:${value}}])`);
        assert.equal(result.sets[0].total, value);
        assert.equal(result.sets[0].rolls[0].label, label);
        assert.equal(await page.ev('scene.snapshot().dice[0].visibleCoinFace'), `coin-${label.toLowerCase()}`);
        assert.ok(await page.ev('scene.snapshot().dice[0].coinUpAlignment > .98'), `${label} settles flat`);
        await shot(page, label.toLowerCase());
    }
    console.log('PASS two distinct named coin faces and both authoritative outcomes');
    await page.ev(`window.cancelled=null;scene.roll([{kind:'d6',value:3}]).then(r=>window.cancelled=r);void 0`);
    await sleep(250);
    await page.ev('scene.stop()');
    await until(page, '!!window.cancelled');
    assert.equal(await page.ev('window.cancelled.cancelled'), true);
    const next = await page.ev(`scene.roll([{kind:'d6',value:6}])`);
    assert.equal(next.sets[0].total, 6);
    await page.ev(
        `window.sibling=document.createElement('canvas');document.getElementById('scene').append(sibling);scene.dispose()`
    );
    assert.equal(await page.ev('document.querySelectorAll("#scene canvas").length'), 1);
    assert.equal(await page.ev('document.querySelector("#scene canvas")===window.sibling'), true);
    console.log('PASS stop resolves the batch, subsequent roll works and disposal preserves another renderer');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(`Screenshots: ${shots}`);
} finally {
    chrome.close();
    await new Promise((r) => server.close(r));
}
