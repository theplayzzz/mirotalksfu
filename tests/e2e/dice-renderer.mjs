import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { launchChrome, sleep } from './lib.mjs';
const require = createRequire(import.meta.url),
    express = require('express');
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
try {
    const page = await chrome.newPage(`http://127.0.0.1:${server.address().port}`);
    await sleep(300);
    const loaded = await page.ev(
        `(async()=>{try{const m=await import('/captcha/play/dice.js');window.scene=await m.createDiceScene(document.getElementById('scene'));return {ok:true};}catch(e){return {error:e.message,stack:e.stack};}})()`
    );
    console.log(loaded);
    assert.ok(loaded.ok);
    const done = await page.ev(
        `scene.roll([{kind:'d6',value:4},{kind:'d10',value:10},{kind:'d20',value:20},{kind:'coin',value:2}])`
    );
    assert.deepEqual(
        done.sets.map((s) => s.total),
        [4, 10, 20, 2]
    );
    console.log('3D batch completed with the four server-supplied outcomes');
} finally {
    chrome.close();
    await new Promise((r) => server.close(r));
}
