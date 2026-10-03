// End-to-end test of the browser side of the replay feature (docs/REPLAY.md, section 7): the gallery with its
// player, and the button, popover and toasts in the room. A headless Chrome is driven over CDP against the mock of
// the server (tests/e2e/replay-mock.mjs) and the room harness (tests/e2e/replay-room-harness.html), so it needs no
// SFU, no recorder and no secret. It takes screenshots of every important state at 1440x900 (-d) and 390x844 (-m).
//
//   node tests/e2e/replay-ui.mjs
//   E2E_CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe" SHOT_DIR=./shots node tests/e2e/replay-ui.mjs
//   ONLY=room-d,gallery-m node tests/e2e/replay-ui.mjs      (names: gallery-d, edges-d, room-d, gallery-m, edges-m, room-m)
//
// E2E_CHROME is the Chrome to drive (a default is tried per platform); SHOT_DIR is where the screenshots go (default
// <os tmp>/replay-ui-shots, outside the repo). Needs Node 22+, Chrome and ffmpeg (the mock makes its sample clips with
// it). The harness loads Font Awesome, Bootstrap and tippy from the same CDNs the room uses; offline the icons are
// blank and the checks still hold.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChrome, sleep } from './lib.mjs';
import { startMock, TEST_PEER } from './replay-mock.mjs';

const defaultChrome = () =>
    process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : 'google-chrome';
const chromePath = process.env.E2E_CHROME || defaultChrome();
const shotDir = process.env.SHOT_DIR || path.join(tmpdir(), 'replay-ui-shots');
mkdirSync(shotDir, { recursive: true });

// ---- reporting -----------------------------------------------------------------------------------------------------

let failures = 0;
let total = 0;
const check = (name, ok, detail = '') => {
    total++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  [${detail}]` : ''}`);
    if (!ok) failures++;
};
const section = (title) => console.log(`\n== ${title}`);
const near = (a, b, tolerance) => typeof a === 'number' && Math.abs(a - b) <= tolerance;
const show = (value) => JSON.stringify(value);

// ---- the mock, Chrome and small helpers ----------------------------------------------------------------------------

const mock = await startMock({ quiet: true });
const chrome = await launchChrome({ chrome: chromePath, width: 1440, height: 900 });
const downloads = mkdtempSync(path.join(tmpdir(), 'replay-ui-downloads-'));
await chrome.browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

const api = (route, method = 'POST', body = {}) =>
    fetch(`${mock.url}/__mock${route}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body),
    }).then((response) => response.json());
const ctl = (route, body) => api(route, 'POST', body);
const mockState = () => api('/state', 'GET');
// Waits until what the mock keeps satisfies a condition (a click reaches the server a moment after it is made).
async function mockUntil(condition, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await condition(await mockState())) return true;
        await sleep(60);
    }
    return false;
}

const VIEWS = {
    d: { width: 1440, height: 900, mobile: false },
    m: { width: 390, height: 844, mobile: true },
};

const pageProblems = [];
async function openPage(kind, { peer = TEST_PEER, peerAsJson = false } = {}) {
    const view = VIEWS[kind];
    const page = await chrome.newPage();
    page.kind = kind;
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
        width: view.width,
        height: view.height,
        deviceScaleFactor: view.mobile ? 2 : 1,
        mobile: view.mobile,
    });
    await page.send('Emulation.setTouchEmulationEnabled', {
        enabled: view.mobile,
        maxTouchPoints: view.mobile ? 5 : 1,
    });
    page.ws.addEventListener('message', (message) => {
        const data = JSON.parse(message.data);
        if (data.method === 'Runtime.exceptionThrown') {
            pageProblems.push(
                `${kind}: exception ${show(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text).slice(0, 300)}`
            );
        }
    });
    // localStorage is shared by the pages of one Chrome: a page that is not supposed to have an id must really have none.
    const value = peerAsJson ? JSON.stringify(peer) : peer;
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: peer
            ? `try { localStorage.setItem('peer_uuid', ${JSON.stringify(value)}); } catch (error) {}`
            : `try { localStorage.removeItem('peer_uuid'); } catch (error) {}`,
    });
    return page;
}

const goto = (page, url) => page.send('Page.navigate', { url: `${mock.url}${url}` });
const until = async (page, expression, ms = 6000, step = 80) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = await page.ev(expression).catch(() => false);
        if (value) return value;
        await sleep(step);
    }
    return false;
};

async function shot(page, name) {
    await sleep(300); // let the animations of the state finish
    const result = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(shotDir, `${name}-${page.kind}.png`), Buffer.from(result.result.data, 'base64'));
}

const KEYS = {
    ' ': ['Space', 32, ' '],
    ArrowLeft: ['ArrowLeft', 37],
    ArrowRight: ['ArrowRight', 39],
    ArrowUp: ['ArrowUp', 38],
    ArrowDown: ['ArrowDown', 40],
    Home: ['Home', 36],
    End: ['End', 35],
    Escape: ['Escape', 27],
    Enter: ['Enter', 13, '\r'],
    Tab: ['Tab', 9],
    f: ['KeyF', 70, 'f'],
    m: ['KeyM', 77, 'm'],
};
async function press(page, key) {
    const [code, vk, text] = KEYS[key];
    await page.send('Input.dispatchKeyEvent', {
        type: text ? 'keyDown' : 'rawKeyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        text,
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
}

const center = (page, selector) =>
    page.ev(`(() => {
        const e = document.querySelector(${show(selector)});
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    })()`);
const move = (page, x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
async function tap(page, x, y) {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
// A person's click: a mouse on a computer (move, then click), a finger on a phone.
async function activate(page, selector, { scroll = true } = {}) {
    if (scroll)
        await page.ev(
            `document.querySelector(${show(selector)})?.scrollIntoView({ block: 'center', inline: 'center' })`
        );
    const at = await center(page, selector);
    if (!at) throw new Error(`nothing to click: ${selector}`);
    if (page.kind === 'm') await tap(page, at.x, at.y);
    else {
        await move(page, at.x, at.y);
        await page.click(at.x, at.y);
    }
    return at;
}

async function waitDownload(name, bytes, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const names = readdirSync(downloads).filter((file) => !file.endsWith('.crdownload') && file.includes(name));
        const file = names.find((n) => statSync(path.join(downloads, n)).size === bytes);
        if (file) return file;
        await sleep(100);
    }
    return null;
}
const sampleBytes = async (id, file) => {
    const response = await fetch(`${mock.url}/replay/media/${id}/${file}`);
    return (await response.arrayBuffer()).byteLength;
};

// ---- the gallery ------------------------------------------------------------------------------------------------------

async function seed() {
    await ctl('/reset');
    const clips = {};
    clips.A = await ctl('/clips', {
        sample: 'a',
        sharer: 'Beltrano',
        requestedBy: 'Fulano',
        mine: true,
        ageMs: 2 * 60_000,
        emit: false,
    });
    clips.B = await ctl('/clips', {
        sample: 'b',
        sharer: 'Ciclano',
        requestedBy: 'Beltrano',
        ageMs: 47 * 60_000,
        withMp4: true,
        emit: false,
    });
    clips.C = await ctl('/clips', {
        sample: 'a',
        sharer: 'Fulano',
        requestedBy: 'Ciclano',
        ageMs: 5 * 3_600_000,
        emit: false,
    });
    clips.D = await ctl('/clips', {
        sample: 'a',
        sharer: 'Dona Maria da Silva Sauro',
        requestedBy: 'Fulano',
        mine: true,
        ageMs: 26 * 3_600_000,
        emit: false,
    });
    clips.E = await ctl('/clips', {
        sample: 'b',
        sharer: 'Beltrano',
        requestedBy: 'Zé',
        ageMs: 6.97 * 86_400_000,
        emit: false,
    });
    return clips;
}

const cardsOf = (page) =>
    page.ev(`[...document.querySelectorAll('#rgGrid .rg-card:not(.is-leaving)')].map((c) => ({
        id: c.dataset.id,
        title: c.querySelector('.rg-card-title').textContent,
        sub: c.querySelector('.rg-card-sub').textContent,
        foot: c.querySelector('.rg-card-foot').textContent,
        dur: c.querySelector('.rg-dur').textContent,
        pill: !c.querySelector('.rg-pill').hidden,
        del: !!c.querySelector('.rg-card-del'),
        isNew: c.classList.contains('is-new'),
    }))`);
const ids = (cards) => cards.map((c) => c.id);

async function openGallery(kind, query = '?from=room', options) {
    const page = await openPage(kind, options);
    await goto(page, `/replay/${query}`);
    await until(
        page,
        `!!document.querySelector('#rgGrid .rg-card') || !document.getElementById('rgLogin').hidden || !document.getElementById('rgEmpty').hidden || !document.getElementById('rgError').hidden || !document.getElementById('rgPlayerView').hidden`
    );
    await sleep(500);
    return page;
}

// Is the whole page inside the window sideways (a phone must never scroll to the side)?
const sideways = (page) => page.ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);

async function gallerySuite(kind) {
    const label = kind === 'd' ? 'desktop 1440x900' : 'phone 390x844';
    const phone = kind === 'm';
    section(`gallery list and filters (${label})`);
    let clips = await seed();
    let page = await openGallery(kind);

    let cards = await cardsOf(page);
    check(
        'the list shows the five clips, newest first',
        show(ids(cards)) === show([clips.A.id, clips.B.id, clips.C.id, clips.D.id, clips.E.id]),
        show(ids(cards))
    );
    check(
        'a card says whose screen, who saved it, how long ago, the length and the time left',
        cards[0].title === 'Tela de Beltrano' &&
            cards[0].sub === 'Salvo por Fulano · há 2 min' &&
            cards[0].dur === '0:20' &&
            cards[0].foot === 'expira em 6 d',
        show(cards[0])
    );
    check(
        'the duration is what plays: the whole file, lead-in included (it starts at the first frame)',
        cards[1].dur === '0:45' && cards[0].dur === '0:20',
        show([cards[0].dur, cards[1].dur])
    );
    check(
        'only the clip with an MP4 has the "MP4 pronto" badge',
        show(cards.map((c) => c.pill)) === show([false, true, false, false, false]),
        show(cards.map((c) => c.pill))
    );
    check(
        'delete shows only for what is mine',
        show(cards.map((c) => c.del)) === show([true, false, false, true, false]),
        show(cards.map((c) => c.del))
    );
    check(
        'a clip about to expire says so',
        cards[4].foot.startsWith('expira em') && cards[4].foot.includes('min'),
        cards[4].foot
    );
    const calls = (await mockState()).log.filter((entry) => entry.path === '/replay/api/clips');
    check(
        'the page sends the browser id with every call (X-Replay-Peer)',
        calls.length > 0 && calls.every((entry) => entry.peer === TEST_PEER),
        show(calls)
    );
    check(
        'no leftover layer over the page (nothing fixed covers the window)',
        await page.ev(
            `(() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return !!e && !e.matches('html, body'); })()`
        )
    );
    if (phone)
        check('the phone layout never scrolls sideways', (await sideways(page)) <= 0, String(await sideways(page)));
    if (phone) {
        const columns = await page.ev(
            `getComputedStyle(document.getElementById('rgGrid')).gridTemplateColumns.split(' ').length`
        );
        check('on a phone the cards are a single column', columns === 1, String(columns));
    }
    await shot(page, 'gallery-list');

    const people = await page.ev(`[...document.querySelectorAll('#rgPerson option')].map((o) => o.textContent)`);
    check(
        'the person selector lists everybody, sorted',
        show(people) === show(['Todas', 'Beltrano', 'Ciclano', 'Dona Maria da Silva Sauro', 'Fulano', 'Zé']),
        show(people)
    );

    await activate(page, '.rg-seg-btn[data-scope="mine"]');
    await sleep(400);
    cards = await cardsOf(page);
    check(
        '"Meus" shows only what I asked for or shared',
        show(ids(cards)) === show([clips.A.id, clips.D.id]),
        show(ids(cards))
    );
    check(
        'the count says how many of the total',
        (await page.ev(`document.getElementById('rgCount').textContent`)) === '2 de 5 replays'
    );
    check(
        'the pressed filter is announced',
        (await page.ev(`document.querySelector('.rg-seg-btn[data-scope="mine"]').getAttribute('aria-pressed')`)) ===
            'true'
    );
    await shot(page, 'gallery-filter-mine');

    await page.ev(
        `(() => { const s = document.getElementById('rgPerson'); s.value = 'Zé'; s.dispatchEvent(new Event('change')); })()`
    );
    await sleep(300);
    check(
        '"Meus" and a person that is not mine leave nothing, and the page says so',
        (await cardsOf(page)).length === 0 &&
            (await page.ev(
                `!document.getElementById('rgEmpty').hidden && document.getElementById('rgEmptyTitle').textContent`
            )) === 'Nenhum replay com esses filtros'
    );
    await shot(page, 'gallery-filter-empty');
    await activate(page, '#rgEmptyAction');
    await sleep(300);
    check('"Limpar filtros" brings everything back', (await cardsOf(page)).length === 5);

    await page.ev(
        `(() => { const s = document.getElementById('rgPerson'); s.value = 'Beltrano'; s.dispatchEvent(new Event('change')); })()`
    );
    await sleep(300);
    cards = await cardsOf(page);
    check(
        'a person matches the screens they shared and the clips they saved',
        show(ids(cards)) === show([clips.A.id, clips.B.id, clips.E.id]),
        show(ids(cards))
    );
    await page.ev(
        `(() => { const s = document.getElementById('rgPerson'); s.value = ''; s.dispatchEvent(new Event('change')); })()`
    );
    await activate(page, '.rg-seg-btn[data-scope="all"]');
    await sleep(300);

    section(`gallery live updates (${label})`);
    const fresh = await ctl('/clips', { sample: 'a', sharer: 'Novinho', requestedBy: 'Alguém', ageMs: 0 });
    check(
        'a clip saved while the page is open appears by itself, at the top',
        !!(await until(page, `document.querySelector('#rgGrid .rg-card')?.dataset.id === ${show(fresh.id)}`, 4000))
    );
    cards = await cardsOf(page);
    check('and the count follows', (await page.ev(`document.getElementById('rgCount').textContent`)) === '6 replays');
    check(
        'the card that arrived is highlighted',
        cards[0].isNew === true || (await page.ev(`document.querySelector('.rg-card').classList.contains('is-new')`))
    );
    check('it is not marked as mine (the stream carries no browser id)', cards[0].del === false);
    await shot(page, 'gallery-live-new');
    await api(`/clips/${fresh.id}`, 'DELETE');
    check(
        'a clip deleted by somebody else disappears by itself',
        !!(await until(page, `!document.querySelector('[data-id=${show(fresh.id)}]:not(.is-leaving)')`, 4000))
    );
    await ctl(`/clips/${clips.C.id}/mp4`, { state: 'ready' });
    check(
        '"MP4 pronto" appears on the card when the conversion ends',
        !!(await until(page, `!document.querySelector('[data-id=${show(clips.C.id)}] .rg-pill').hidden`, 4000))
    );
    check(
        'the header shows that the page is live',
        (await page.ev(`document.getElementById('rgLive').dataset.state`)) === 'on'
    );

    // The stream comes in two shapes: named events, or plain messages with the type inside.
    await ctl('/config', { sseFormat: 'plain' });
    await ctl('/sse/drop');
    await until(page, `document.getElementById('rgLive').dataset.state === 'on'`, 6000);
    const plain = await ctl('/clips', { sample: 'a', sharer: 'Plano', requestedBy: 'Alguém', ageMs: 0 });
    check(
        'plain messages (type inside the data) work too, after the stream came back by itself',
        !!(await until(page, `!!document.querySelector('[data-id=${show(plain.id)}]')`, 5000))
    );
    await ctl('/config', { sseFormat: 'named' });
    await api(`/clips/${plain.id}`, 'DELETE');
    await until(page, `!document.querySelector('[data-id=${show(plain.id)}]:not(.is-leaving)')`, 4000);

    section(`gallery player (${label})`);
    await page.ev(`ReplayGallery.timings.idleMs = 500`);
    await activate(page, `[data-id=${show(clips.A.id)}] .rg-card-link`);
    await until(
        page,
        `!document.getElementById('rgPlayerView').hidden && document.getElementById('rpVideo').readyState >= 1`
    );
    await sleep(700);
    check(
        'clicking a card opens the player and puts the clip in the address',
        (await page.ev(`location.search`)) === `?clip=${clips.A.id}&from=room`
    );
    check('the tab keeps a single history entry', (await page.ev(`history.length`)) <= 2);
    check(
        'the title says whose screen',
        (await page.ev(`document.getElementById('rpTitle').textContent`)) === 'Tela de Beltrano'
    );
    check(
        'who saved it, when and for how long',
        /Salvo por Fulano · \d\d\/\d\d\/\d{4} às \d\d:\d\d · duração 0:20 \(o pedido começa em 0:03\) · expira em 6 d/.test(
            await page.ev(`document.getElementById('rpMeta').textContent`)
        ),
        await page.ev(`document.getElementById('rpMeta').textContent`)
    );
    const start = await page.ev(
        `({ t: document.getElementById('rpVideo').currentTime, time: document.getElementById('rpTime').textContent, max: document.getElementById('rpTimeline').getAttribute('aria-valuemax'), mark: (() => { const m = document.getElementById('rpAsked'); return { hidden: m.hidden, at: document.getElementById('rpTimeline').style.getPropertyValue('--ask') }; })() })`
    );
    // The lead-in is not hidden by a seek (the browser would decode all of it before the first picture: seconds, and
    // very many on a PC busy with a game): the video starts at its first frame and a mark shows where the asked part begins
    check(
        'the timeline starts at the first frame, with no seek, and marks where the asked part begins (3 s of 20)',
        near(start.t, 0, 0.35) && start.time === '0:00 / 0:20' && start.max === '20' && start.mark.hidden === false && near(parseFloat(start.mark.at), 15, 0.1),
        show(start)
    );
    check(
        'the player opened paused with a big play button',
        await page.ev(
            `!document.getElementById('rpStage').classList.contains('is-playing') && !!document.getElementById('rpBig').offsetParent`
        )
    );
    check(
        'the controls sit under the picture on a phone and over it on a computer',
        (await page.ev(`getComputedStyle(document.getElementById('rpControls')).position`)) ===
            (phone ? 'static' : 'absolute')
    );
    if (phone) check('the player does not scroll sideways', (await sideways(page)) <= 0, String(await sideways(page)));
    await shot(page, 'gallery-player');

    await activate(page, '#rpBig', { scroll: false });
    await until(page, `document.getElementById('rpVideo').currentTime > 1.1`, 6000);
    const playing = await page.ev(
        `({ paused: document.getElementById('rpVideo').paused, t: document.getElementById('rpVideo').currentTime, time: document.getElementById('rpTime').textContent, cls: document.getElementById('rpStage').className })`
    );
    check(
        'the big button plays: the video runs and the timeline follows',
        !playing.paused && /^0:0[1-9] \/ 0:20$/.test(playing.time) && playing.cls.includes('is-playing'),
        show(playing)
    );
    check(
        'the play button became a pause button',
        (await page.ev(`document.getElementById('rpPlay').getAttribute('aria-label')`)) === 'Pausar'
    );
    await sleep(phone ? 100 : 900);
    if (!phone)
        check(
            'the controls fade while it plays and the pointer rests',
            (await page.ev(`document.getElementById('rpStage').classList.contains('is-idle')`)) === true
        );
    await shot(page, 'gallery-player-playing');
    if (!phone) {
        const stage = await center(page, '#rpStage');
        await move(page, stage.x - 40, stage.y + 10);
        await move(page, stage.x, stage.y);
        await sleep(200);
        check(
            'moving the pointer brings the controls back',
            (await page.ev(`document.getElementById('rpStage').classList.contains('is-idle')`)) === false
        );
    }

    await press(page, ' ');
    await sleep(250);
    const afterSpace = await page.ev(
        `({ paused: document.getElementById('rpVideo').paused, t: document.getElementById('rpVideo').currentTime, ended: document.getElementById('rpVideo').ended, focus: document.activeElement.tagName + '#' + document.activeElement.id, view: ReplayGallery.state.view })`
    );
    check('Space pauses', afterSpace.paused, show(afterSpace));
    const at1 = await page.ev(`document.getElementById('rpVideo').currentTime`);
    await press(page, 'ArrowRight');
    await sleep(350);
    const at2 = await page.ev(`document.getElementById('rpVideo').currentTime`);
    check('the right arrow goes 5 s ahead', near(at2 - at1, 5, 0.6), `${at1} -> ${at2}`);
    await press(page, 'ArrowLeft');
    await sleep(350);
    const at3 = await page.ev(`document.getElementById('rpVideo').currentTime`);
    check('the left arrow goes 5 s back', near(at2 - at3, 5, 0.6), `${at2} -> ${at3}`);
    await press(page, 'ArrowLeft');
    await press(page, 'ArrowLeft');
    await sleep(400);
    const atStart = await page.ev(`document.getElementById('rpVideo').currentTime`);
    check('it never goes back to before the start of the file', atStart >= 0 && atStart < 0.4, String(atStart));
    await press(page, 'End');
    await sleep(500);
    check('End goes to the end', (await page.ev(`document.getElementById('rpTime').textContent`)) === '0:20 / 0:20');
    await press(page, 'Home');
    await sleep(400);
    check(
        'Home goes back to the start',
        (await page.ev(`document.getElementById('rpTime').textContent`)) === '0:00 / 0:20'
    );
    await press(page, ' ');
    await sleep(500);
    check('Space plays again', !(await page.ev(`document.getElementById('rpVideo').paused`)));
    await press(page, ' ');

    await press(page, 'm');
    check('M mutes', await page.ev(`document.getElementById('rpVideo').muted`));
    await sleep(150);
    check(
        'and the button says so',
        (await page.ev(`document.getElementById('rpMute').getAttribute('aria-label')`)) === 'Ativar o som'
    );
    await press(page, 'm');
    check('M again brings the sound back', !(await page.ev(`document.getElementById('rpVideo').muted`)));
    await page.ev(
        `(() => { const v = document.getElementById('rpVolume'); v.value = '0.3'; v.dispatchEvent(new Event('input', { bubbles: true })); })()`
    );
    check(
        'the volume slider sets the volume',
        near(await page.ev(`document.getElementById('rpVideo').volume`), 0.3, 0.01)
    );
    await page.ev(
        `(() => { const v = document.getElementById('rpVolume'); v.value = '1'; v.dispatchEvent(new Event('input', { bubbles: true })); })()`
    );

    for (const [rate, text] of [
        ['1.5', '1,5x'],
        ['2', '2x'],
        ['1', '1x'],
    ]) {
        await activate(page, `.rp-speed-btn[data-rate="${rate}"]`, { scroll: false });
        const speed = await page.ev(
            `({ rate: document.getElementById('rpVideo').playbackRate, pressed: [...document.querySelectorAll('.rp-speed-btn')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent.trim()) })`
        );
        check(`speed ${text}`, speed.rate === Number(rate) && show(speed.pressed) === show([text]), show(speed));
    }

    // seek with the pointer: a click at 50%, then a drag
    const bar = await center(page, '#rpTimeline');
    if (phone) await tap(page, bar.left + bar.w * 0.5, bar.y);
    else {
        await move(page, bar.left + bar.w * 0.5, bar.y);
        await page.click(bar.left + bar.w * 0.5, bar.y);
    }
    await sleep(500);
    const half = await page.ev(`document.getElementById('rpVideo').currentTime`);
    check('a click on the timeline seeks there', near(half, 10, 0.8), String(half));
    if (!phone) {
        await move(page, bar.left + bar.w * 0.1, bar.y);
        await page.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: bar.left + bar.w * 0.1,
            y: bar.y,
            button: 'left',
            clickCount: 1,
        });
        for (const f of [0.3, 0.5, 0.7, 0.9]) {
            await move(page, bar.left + bar.w * f, bar.y);
            await sleep(60);
        }
        await page.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: bar.left + bar.w * 0.9,
            y: bar.y,
            button: 'left',
            clickCount: 1,
        });
        await sleep(600);
        const dragged = await page.ev(`document.getElementById('rpVideo').currentTime`);
        check('the timeline can be dragged', near(dragged, 18, 0.9), String(dragged));
        await move(page, bar.left + bar.w * 0.25, bar.y);
        check(
            'hovering the timeline shows the time under the pointer',
            /^0:0[4-6]$/.test(
                await page.ev(
                    `document.getElementById('rpHover').hidden ? '' : document.getElementById('rpHover').textContent`
                )
            )
        );
    }
    check(
        'the timeline is a slider with its values for a screen reader',
        await page.ev(
            `(() => { const t = document.getElementById('rpTimeline'); return t.getAttribute('role') === 'slider' && t.getAttribute('aria-valuemax') === '20' && /de 0:20$/.test(t.getAttribute('aria-valuetext')); })()`
        )
    );
    await page.ev(`document.getElementById('rpTimeline').focus()`);
    await press(page, 'Home');
    await press(page, 'ArrowRight');
    await sleep(300);
    check(
        'the timeline also answers to the arrow keys',
        near(await page.ev(`document.getElementById('rpVideo').currentTime`), 5, 0.7)
    );

    if (!phone) {
        await press(page, 'f');
        await sleep(500);
        const full = await page.ev(`document.fullscreenElement === document.getElementById('rpStage')`);
        check('F goes full screen (the controls go with it)', full === true);
        if (full) {
            check(
                'and the button changes',
                (await page.ev(`document.getElementById('rpFull').getAttribute('aria-label')`)) === 'Sair da tela cheia'
            );
            await shot(page, 'gallery-player-fullscreen');
            await press(page, 'f');
            await sleep(400);
            check('F again leaves it', !(await page.ev(`document.fullscreenElement`)));
        }
    }

    // Watching a clip never converts it: only a click on "Baixar MP4" does (the people of the room open clips to watch
    // them, and keep most of them in the gallery; converting costs the recorder's core for a minute or more)
    check(
        'nothing was converted while the clip was opened, played, paused, sought and sped up',
        (await mockState()).stats.mp4Requests === 0,
        String((await mockState()).stats.mp4Requests)
    );

    // a portrait clip: the player takes the shape of the picture
    await press(page, 'Escape');
    await until(page, `!document.getElementById('rgBrowse').hidden`);
    check(
        'Esc goes back to the list and the address loses the clip',
        (await page.ev(`location.search`)) === '?from=room'
    );
    check(
        'focus goes back to the card that was open',
        await page.ev(
            `document.activeElement === document.querySelector('[data-id=${show(clips.A.id)}] .rg-card-link')`
        )
    );
    await activate(page, `[data-id=${show(clips.B.id)}] .rg-card-link`);
    await until(page, `document.getElementById('rpVideo').readyState >= 1`);
    await sleep(500);
    const portrait = await page.ev(
        `({ ar: Number(getComputedStyle(document.getElementById('rpStage')).getPropertyValue('--rp-ar')), w: document.getElementById('rpVideo').videoWidth, h: document.getElementById('rpVideo').videoHeight, time: document.getElementById('rpTime').textContent, stage: document.getElementById('rpStage').getBoundingClientRect().toJSON() })`
    );
    check(
        'a portrait clip makes a portrait player',
        near(portrait.ar, portrait.w / portrait.h, 0.01) &&
            portrait.ar < 1 &&
            portrait.stage.height > portrait.stage.width,
        show(portrait)
    );
    check('its timeline is its own length (0:45, the lead-in included)', portrait.time === '0:00 / 0:45', portrait.time);
    await shot(page, 'gallery-player-portrait');
    check(
        'a clip with an MP4 says it is ready, with the size',
        /pronto para baixar/.test(await page.ev(`document.getElementById('rpMp4Note').textContent`))
    );
    await press(page, 'Escape');
    await until(page, `!document.getElementById('rgBrowse').hidden`);

    section(`gallery downloads (${label})`);
    await activate(page, `[data-id=${show(clips.A.id)}] .rg-card-link`);
    await until(page, `document.getElementById('rpVideo').readyState >= 1`);
    const original = await page.ev(
        `({ href: document.getElementById('rpOriginal').getAttribute('href'), text: document.getElementById('rpOriginal').textContent.replace(/\\s+/g, ' ').trim() })`
    );
    check(
        '"Baixar original" is a plain download link, with the note',
        original.href === `/replay/media/${clips.A.id}/clip.webm?download=1` &&
            original.text.includes('Baixar original') &&
            original.text.includes('pode começar até ~1 min antes'),
        show(original)
    );
    const originalBytes = await sampleBytes(clips.A.id, 'clip.webm');
    await activate(page, '#rpOriginal');
    const gotOriginal = await waitDownload('.webm', originalBytes);
    check('the original downloads at once, whole', !!gotOriginal, show(readdirSync(downloads)));
    check(
        'the file has the name the server gave it',
        !!gotOriginal && /^replay-beltrano-.*\.webm$/.test(gotOriginal),
        gotOriginal || ''
    );

    await ctl('/config', { mp4: { mode: 'manual', ahead: 1 } });
    const estimate = await page.ev(`document.getElementById('rpMp4Note').textContent`);
    check(
        'before it starts, the MP4 button says it only converts when clicked, and how long it takes',
        /^só converte ao clicar · leva ~\d+ s$/.test(estimate),
        estimate
    );
    await activate(page, '#rpMp4');
    check(
        'waiting in the queue says how many conversions are ahead',
        !!(await until(page, `document.getElementById('rpMp4Label').textContent === 'Na fila — 1 conversão na frente'`))
    );
    check(
        'and the button is busy',
        await page.ev(
            `document.getElementById('rpMp4').dataset.phase === 'queued' && document.getElementById('rpMp4').getAttribute('aria-disabled') === 'true'`
        )
    );
    await shot(page, 'gallery-mp4-queued');
    await ctl(`/clips/${clips.A.id}/mp4`, { state: 'running', progress: 0.25, etaSeconds: 40 });
    await until(page, `document.getElementById('rpMp4').dataset.phase === 'running'`);
    await ctl(`/clips/${clips.A.id}/mp4`, { state: 'running', progress: 0.58, etaSeconds: 24 });
    await until(page, `document.getElementById('rpMp4Note').textContent.startsWith('58%')`);
    await sleep(700); // the bar slides to the new value
    const running = await page.ev(
        `({ label: document.getElementById('rpMp4Label').textContent, note: document.getElementById('rpMp4Note').textContent, p: getComputedStyle(document.getElementById('rpMp4')).getPropertyValue('--p'), fill: document.querySelector('#rpMp4 .rp-dl-fill').getBoundingClientRect().width, whole: document.getElementById('rpMp4').getBoundingClientRect().width })`
    );
    check(
        'while it converts: the real percentage and the time left',
        running.label === 'Convertendo para MP4…' && running.note === '58% · cerca de 25 s',
        show(running)
    );
    check(
        'the progress bar fills that much of the button',
        near(running.fill / running.whole, 0.58, 0.04) && running.p.trim() === '58',
        show(running)
    );
    await shot(page, 'gallery-mp4-running');
    check(
        'the page announces the progress to a screen reader',
        /Convertendo para MP4/.test(await page.ev(`document.getElementById('rpMp4Status').textContent`))
    );
    await ctl(`/clips/${clips.A.id}/mp4`, { state: 'ready' });
    check(
        'when it is ready the MP4 downloads by itself',
        !!(await waitDownload('.mp4', (await mockState()).clips.find((c) => c.id === clips.A.id).files.mp4.bytes)),
        show(readdirSync(downloads))
    );
    check(
        'and the button becomes an instant download',
        (await page.ev(`document.getElementById('rpMp4').dataset.phase`)) === 'ready'
    );
    check(
        'the card in the list got its "MP4 pronto" badge',
        await page.ev(`!document.querySelector('[data-id=${show(clips.A.id)}] .rg-pill').hidden`)
    );
    await shot(page, 'gallery-mp4-ready');
    const requests = (await mockState()).stats.mp4Requests;
    rmSync(path.join(downloads, readdirSync(downloads).find((f) => f.endsWith('.mp4')) || 'none'), { force: true });
    await activate(page, '#rpMp4');
    check(
        'a second click downloads again without asking the server to convert',
        !!(await waitDownload('.mp4', (await mockState()).clips.find((c) => c.id === clips.A.id).files.mp4.bytes)) &&
            (await mockState()).stats.mp4Requests === requests
    );
    await press(page, 'Escape');
    await until(page, `!document.getElementById('rgBrowse').hidden`);

    // a conversion that fails, then tried again; one told only by the answers to the page (the stream is silent)
    await activate(page, `[data-id=${show(clips.C.id)}] .rg-card-link`);
    await until(page, `document.getElementById('rpVideo').readyState >= 1`);
    check(
        'a clip that already has an MP4 shows it ready from the start',
        (await page.ev(`document.getElementById('rpMp4').dataset.phase`)) === 'ready'
    );
    await press(page, 'Escape');
    await until(page, `!document.getElementById('rgBrowse').hidden`);
    await activate(page, `[data-id=${show(clips.D.id)}] .rg-card-link`);
    await until(page, `document.getElementById('rpVideo').readyState >= 1`);
    await ctl('/config', { mp4: { mode: 'manual', ahead: 0 } });
    const asked = (await mockState()).stats.mp4Requests;
    await activate(page, '#rpMp4');
    await mockUntil((state) => state.stats.mp4Requests === asked + 1);
    await until(page, `document.getElementById('rpMp4').dataset.phase === 'running'`);
    await ctl(`/clips/${clips.D.id}/mp4`, { state: 'error', message: 'ffmpeg exited with 1' });
    const mp4Button = () =>
        page.ev(
            `({ phase: document.getElementById('rpMp4').dataset.phase, label: document.getElementById('rpMp4Label').textContent, note: document.getElementById('rpMp4Note').textContent })`
        );
    check(
        'a conversion that fails says so and offers to try again',
        !!(await until(
            page,
            `document.getElementById('rpMp4').dataset.phase === 'error' && document.getElementById('rpMp4Note').textContent === 'toque para tentar de novo'`
        )),
        show(await mp4Button())
    );
    await shot(page, 'gallery-mp4-error');
    const before = (await mockState()).stats.mp4Requests;
    await activate(page, '#rpMp4');
    check(
        'trying again asks the server again',
        !!(await until(page, `document.getElementById('rpMp4').dataset.phase === 'running'`)) &&
            (await mockState()).stats.mp4Requests === before + 1
    );
    await ctl('/config', { sseMuted: true });
    await page.ev(`ReplayGallery.timings.mp4QuietMs = 250; ReplayGallery.timings.mp4PollMs = 300`);
    await ctl(`/clips/${clips.D.id}/mp4`, { state: 'running', progress: 0.4, etaSeconds: 12 });
    check(
        'if the stream is silent the page asks again and still shows the progress',
        !!(await until(page, `document.getElementById('rpMp4Note').textContent.startsWith('40%')`, 5000))
    );
    await ctl(`/clips/${clips.D.id}/mp4`, { state: 'queued', ahead: null });
    check(
        'a queue with no count says it waits its turn',
        !!(await until(
            page,
            `document.getElementById('rpMp4Label').textContent === 'Na fila — aguardando a vez'`,
            5000
        ))
    );
    await ctl('/config', { sseMuted: false });
    await press(page, 'Escape');
    await until(page, `!document.getElementById('rgBrowse').hidden`);

    section(`gallery delete (${label})`);
    await page.ev(`window.scrollTo(0, 0)`);
    const cardA = `[data-id=${show(clips.A.id)}]`;
    if (!phone) {
        const at = await center(page, `${cardA} .rg-card-link`);
        await move(page, at.x, at.y);
        await sleep(300);
        check(
            'the delete button shows when the pointer is on the card',
            (await page.ev(`getComputedStyle(document.querySelector('${cardA} .rg-card-del')).opacity`)) === '1'
        );
    }
    await activate(page, `${cardA} .rg-card-del`);
    check(
        'delete asks first, with "Cancelar" focused',
        !!(await until(
            page,
            `document.activeElement?.textContent === 'Cancelar' && !!document.querySelector('${cardA} .rg-card-confirm')`
        ))
    );
    await shot(page, 'gallery-delete-confirm');
    await activate(page, `${cardA} .rg-card-confirm .rg-btn:not(.rg-btn-danger)`);
    check(
        '"Cancelar" leaves the clip alone',
        !(await page.ev(`!!document.querySelector('${cardA} .rg-card-confirm')`)) &&
            (await mockState()).clips.some((c) => c.id === clips.A.id)
    );
    await activate(page, `${cardA} .rg-card-del`);
    await until(page, `!!document.querySelector('${cardA} .rg-card-confirm')`);
    await press(page, 'Escape');
    check('Esc cancels it too', !(await page.ev(`!!document.querySelector('${cardA} .rg-card-confirm')`)));
    await activate(page, `${cardA} .rg-card-del`);
    await until(page, `!!document.querySelector('${cardA} .rg-card-confirm')`);
    await activate(page, `${cardA} .rg-card-confirm .rg-btn-danger`);
    check(
        '"Excluir" removes the card',
        !!(await until(page, `!document.querySelector('${cardA}:not(.is-leaving)')`, 4000))
    );
    const afterDelete = await mockState();
    check(
        'and the clip in the server, asked by the owner',
        !afterDelete.clips.some((c) => c.id === clips.A.id) &&
            afterDelete.log.some(
                (entry) => entry.method === 'DELETE' && entry.status === 200 && entry.peer === TEST_PEER
            )
    );
    check(
        'the page says it was deleted',
        /Replay excluído/.test(await page.ev(`document.getElementById('rgToast').textContent`))
    );
    const forbidden = await page.ev(
        `fetch('/replay/api/clips/${clips.B.id}', { method: 'DELETE', headers: { 'X-Replay-Peer': ${show(TEST_PEER)} } }).then((r) => r.status)`
    );
    check("somebody else's clip cannot be deleted (the server says no)", forbidden === 403, String(forbidden));
    await page.close();

    section(`gallery from the player: delete, and the stream going away (${label})`);
    clips = await seed();
    page = await openGallery(kind, `?clip=${clips.D.id}&from=room`);
    check(
        '?clip= opens that clip straight away',
        await page.ev(
            `!document.getElementById('rgPlayerView').hidden && document.getElementById('rpTitle').textContent === 'Tela de Dona Maria da Silva Sauro'`
        )
    );
    await activate(page, '#rpDelete');
    check(
        'the player has its own delete, which asks first',
        await page.ev(
            `!document.getElementById('rpConfirm').hidden && document.activeElement === document.getElementById('rpConfirmNo')`
        )
    );
    await shot(page, 'gallery-player-delete-confirm');
    await activate(page, '#rpConfirmYes');
    check(
        'deleting from the player goes back to the list',
        !!(await until(
            page,
            `!document.getElementById('rgBrowse').hidden && !document.querySelector('[data-id=${show(clips.D.id)}]:not(.is-leaving)')`,
            4000
        ))
    );
    // a clip deleted by somebody else while it is open
    await activate(page, `[data-id=${show(clips.C.id)}] .rg-card-link`);
    await until(page, `!document.getElementById('rgPlayerView').hidden`);
    await api(`/clips/${clips.C.id}`, 'DELETE');
    check(
        'if the open clip is deleted by somebody else the page goes back to the list and says so',
        !!(await until(
            page,
            `!document.getElementById('rgBrowse').hidden && /foi excluído/.test(document.getElementById('rgToast').textContent)`,
            4000
        ))
    );
    await page.close();
}

async function galleryEdges(kind) {
    const label = kind === 'd' ? 'desktop' : 'phone';
    const phone = kind === 'm';
    section(`gallery: the other states and the query (${label})`);
    let clips = await seed();

    // empty
    await ctl('/reset');
    let page = await openGallery(kind);
    check(
        'no replays: a welcome that says how to make one',
        await page.ev(
            `!document.getElementById('rgEmpty').hidden && document.getElementById('rgEmptyTitle').textContent === 'Nenhum replay ainda' && document.getElementById('rgEmptyAction').hidden`
        )
    );
    check('and no filters nobody can use', await page.ev(`document.querySelector('.rg-toolbar').hidden`));
    await shot(page, 'gallery-empty');
    // the server fails
    await ctl('/config', { listStatus: 500 });
    await goto(page, '/replay/?from=room');
    await until(page, `!document.getElementById('rgError').hidden`);
    check(
        'a failing server shows an error with "Tentar de novo"',
        await page.ev(`!document.getElementById('rgError').hidden && !!document.getElementById('rgRetry')`)
    );
    await shot(page, 'gallery-error');
    clips = await seed();
    await activate(page, '#rgRetry');
    check(
        'and trying again recovers',
        !!(await until(page, `document.querySelectorAll('#rgGrid .rg-card').length === 5`))
    );
    await page.close();

    // ?clip=
    page = await openGallery(kind, `?clip=${clips.B.id}&from=room`);
    check(
        '?clip=<id> opens that clip',
        await page.ev(
            `document.getElementById('rpTitle').textContent === 'Tela de Ciclano' && !document.getElementById('rgPlayerView').hidden`
        )
    );
    check(
        '"Todos os replays" leads to the list and drops the clip from the address',
        await (async () => {
            await activate(page, '#rpBack');
            await until(page, `!document.getElementById('rgBrowse').hidden`);
            return (await page.ev(`location.search`)) === '?from=room';
        })()
    );
    await page.close();
    page = await openGallery(kind, `?clip=20990101-000000-deadbeef-xxxx&from=room`);
    check(
        '?clip= of a clip that is gone says so and shows the list',
        await page.ev(
            `!document.getElementById('rgBrowse').hidden && /não existe mais/.test(document.getElementById('rgToast').textContent)`
        )
    );
    await page.close();
    page = await openGallery(kind, `?clip=<script>&from=room`);
    check(
        '?clip= with something that is not an id is ignored',
        await page.ev(
            `!document.getElementById('rgBrowse').hidden && document.querySelectorAll('#rgGrid .rg-card').length === 5`
        )
    );
    await page.close();

    // the browser id may be stored as a JSON string
    page = await openGallery(kind, '?from=room', { peerAsJson: true });
    check(
        'a browser id stored as a JSON string still marks my clips',
        (await cardsOf(page)).filter((c) => c.del).length === 2
    );
    await page.close();
    page = await openGallery(kind, '?from=room', { peer: null });
    check(
        'a browser that never joined the room has no clips of its own, and the page explains',
        await (async () => {
            await activate(page, '.rg-seg-btn[data-scope="mine"]');
            await sleep(300);
            return page.ev(
                `document.getElementById('rgEmptyTitle').textContent === 'Não dá para saber quais são seus' && !document.querySelector('.rg-card-del')`
            );
        })()
    );
    await page.close();

    // back to the room
    page = await openGallery(kind, '');
    check(
        'without from=room "Voltar para a sala" is a link to the room',
        await page.ev(
            `document.getElementById('rgBack').getAttribute('href') === '/join/link' && document.getElementById('rgBack').textContent.includes('Voltar para a sala')`
        )
    );
    await page.close();
    section(`gallery: back to the room closes the tab (${label})`);
    const opener = await openPage(kind);
    await goto(opener, '/robots.txt');
    await sleep(300);
    await opener.ev(`window.__child = window.open('/replay/?from=room', '_blank'); true`);
    await until(
        opener,
        `window.__child && window.__child.document && window.__child.document.readyState === 'complete' && !!window.__child.document.getElementById('rgBack')`,
        8000
    );
    await sleep(500);
    check(
        'the gallery opened from the room has the back button',
        await opener.ev(`!!window.__child && !window.__child.closed`)
    );
    await opener.ev(`window.__child.document.getElementById('rgBack').click(); true`);
    check('"Voltar para a sala" closes the tab', !!(await until(opener, `window.__child.closed === true`, 3000)));
    await opener.close();

    section(`gallery: the password form (${label})`);
    clips = await seed();
    await ctl('/config', { requireAuth: true, lockMs: 1500, maxLoginFailures: 3 });
    page = await openGallery(kind);
    check(
        'without access the page shows the password form and no clips',
        await page.ev(
            `!document.getElementById('rgLogin').hidden && document.getElementById('rgBrowse').hidden && !document.querySelector('.rg-card')`
        )
    );
    check(
        'the field is a password field with a label and the right autocomplete',
        await page.ev(
            `(() => { const i = document.getElementById('rgPassword'); return i.type === 'password' && i.autocomplete === 'current-password' && !!document.querySelector('label[for=rgPassword]'); })()`
        )
    );
    check('and it has the focus', await page.ev(`document.activeElement === document.getElementById('rgPassword')`));
    await shot(page, 'gallery-login');
    await page.ev(
        `(() => { document.getElementById('rgPassword').value = 'senha-errada'; document.getElementById('rgLoginForm').requestSubmit(); })()`
    );
    check(
        'a wrong password is refused with a message',
        !!(await until(page, `/Senha incorreta/.test(document.getElementById('rgLoginError').textContent)`))
    );
    await shot(page, 'gallery-login-error');
    for (let i = 0; i < 3; i++) {
        await page.ev(
            `(() => { document.getElementById('rgPassword').value = 'errada-de-novo'; document.getElementById('rgLoginForm').requestSubmit(); })()`
        );
        await sleep(250);
    }
    check(
        'too many tries are told to wait, with the time, and the button waits',
        !!(await until(
            page,
            `/Muitas tentativas\\. Tente de novo em \\d+ s/.test(document.getElementById('rgLoginError').textContent) && document.getElementById('rgLoginSubmit').disabled`
        ))
    );
    await shot(page, 'gallery-login-wait');
    check(
        'then the button comes back by itself',
        !!(await until(page, `!document.getElementById('rgLoginSubmit').disabled`, 5000))
    );
    await page.ev(
        `(() => { document.getElementById('rgPassword').value = ${show(mockPassword())}; document.getElementById('rgLoginForm').requestSubmit(); })()`
    );
    check(
        'the right password opens the list',
        !!(await until(page, `document.querySelectorAll('#rgGrid .rg-card').length === 5`, 5000))
    );
    check(
        'and the password is not left in the page',
        (await page.ev(`document.getElementById('rgPassword').value`)) === ''
    );
    const cookies = (await page.send('Network.getCookies', { urls: [`${mock.url}/replay/`] })).result.cookies.filter(
        (c) => c.name === 'replay_access'
    );
    check(
        'the access cookie is HttpOnly, only for /replay/, and lasts about 30 days',
        cookies.length === 1 &&
            cookies[0].httpOnly &&
            cookies[0].path === '/replay/' &&
            cookies[0].sameSite === 'Lax' &&
            near(cookies[0].expires - Date.now() / 1000, 30 * 86400, 600),
        show(cookies)
    );
    await page.send('Page.reload');
    check(
        'after a reload it is still open (the cookie remembers)',
        !!(await until(page, `document.querySelectorAll('#rgGrid .rg-card').length === 5`, 5000))
    );
    await shot(page, 'gallery-after-login');
    // the access goes away while the page is open
    await ctl('/reset');
    clips = await seed();
    await ctl('/config', { requireAuth: true });
    await ctl(`/clips`, { sample: 'a', sharer: 'X', requestedBy: 'Y', emit: false });
    await page.ev(`ReplayGallery.refresh()`);
    check(
        'if the access ends while the page is open the form comes back',
        !!(await until(page, `!document.getElementById('rgLogin').hidden`, 5000))
    );
    await page.close();
    await ctl('/config', { requireAuth: false });

    section(`gallery: accessibility (${label})`);
    page = await openGallery(kind, `?clip=${clips.A.id}&from=room`);
    const unnamed = await page.ev(
        `[...document.querySelectorAll('button, a[href], [role=slider], input, select')].filter((e) => e.offsetParent !== null || e === document.activeElement).filter((e) => { const name = (e.getAttribute('aria-label') || e.textContent || e.title || (e.id && document.querySelector('label[for=' + e.id + ']')?.textContent) || '').trim(); return !name; }).map((e) => e.outerHTML.slice(0, 80))`
    );
    check('every control has a name a screen reader can say', unnamed.length === 0, show(unnamed));
    check(
        'the icons are hidden from screen readers',
        await page.ev(`[...document.querySelectorAll('svg.rg-i')].every((s) => !!s.closest('[aria-hidden="true"]'))`)
    );
    check(
        'the page has a language and one h1',
        await page.ev(`document.documentElement.lang === 'pt-BR' && document.querySelectorAll('h1').length === 1`)
    );
    check('there is a skip link', await page.ev(`!!document.querySelector('a.rg-skip[href="#rgMain"]')`));
    // tab through: focus is visible
    await page.ev(`document.body.focus()`);
    let visible = 0;
    let seen = 0;
    for (let i = 0; i < 14; i++) {
        await press(page, 'Tab');
        const outline = await page.ev(
            `(() => { const e = document.activeElement; if (!e || e === document.body) return null; const s = getComputedStyle(e); return { w: parseFloat(s.outlineWidth), style: s.outlineStyle, off: e.tagName }; })()`
        );
        if (outline) {
            seen++;
            if (outline.style !== 'none' && outline.w >= 2) visible++;
        }
    }
    check('while tabbing, the focused control always shows a ring', seen > 6 && visible === seen, `${visible}/${seen}`);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await goto(page, `/replay/?from=room`);
    await until(page, `!!document.querySelector('#rgGrid .rg-card')`);
    await ctl('/clips', { sample: 'a', sharer: 'Calmo', requestedBy: 'Alguém', ageMs: 0 });
    await until(page, `!!document.querySelector('[data-id]:first-child')`);
    await sleep(300);
    check(
        'with reduced motion asked, no card flies in and the live dot does not pulse',
        await page.ev(
            `!document.querySelector('.rg-card.is-new') && getComputedStyle(document.querySelector('.rg-live-dot')).animationName === 'none'`
        )
    );
    await page.close();
}

const mockPassword = () => process.env.MOCK_REPLAY_PASSWORD || 'mock-password';

// ---- the room -----------------------------------------------------------------------------------------------------------

const buffers = (page, shares, extra = {}) =>
    page.ev(`harness.socket.fire('replayBuffers', ${show({ available: true, maxSeconds: 300, shares, ...extra })})`);
const emitted = (page, event) =>
    page.ev(`harness.socket.emitted.filter((e) => e.event === ${show(event)}).map((e) => e.data)`);

// What the server keeps for the three screens of the room tests (the popover counts up between messages, so the
// numbers a check reads are set again right before it).
const keep = (page, remote, other, own) =>
    buffers(page, [
        { producerId: remote.producerId, peerName: 'Beltrano', bufferSeconds: 150, codec: 'vp8', hasAudio: true },
        { producerId: other.producerId, peerName: 'Ciclano', bufferSeconds: 320, codec: 'vp8', hasAudio: true },
        { producerId: own.producerId, peerName: 'Eu', bufferSeconds: 40, codec: 'vp8', hasAudio: false },
    ]);

async function openRoom(kind, query = '', { flagOff = false } = {}) {
    const page = await openPage(kind);
    await goto(
        page,
        `/__harness/room.html${kind === 'm' ? `?mobile=1${query ? `&${query.replace(/^\?/, '')}` : ''}` : query}`
    );
    await until(page, `window.harness && window.harness.ready === true`, 10000);
    // The script reads /config at its start: wait for the answer (it turns the feature on, unless the flag is off).
    await until(
        page,
        flagOff
            ? `performance.getEntriesByType('resource').some((e) => e.name.endsWith('/config'))`
            : `window.Replay && Replay.state.enabled === true`,
        6000
    );
    await sleep(300);
    return page;
}

// The bar on a screen: on a computer it shows when the pointer is on the picture; on a phone, when it is tapped.
async function showBar(page, tile) {
    if (page.kind === 'm') {
        // A tap on the picture toggles its bar: tap only when it is hidden.
        const id = tile.consumerId || tile.producerId;
        if (await page.ev(`document.getElementById(${show(`${id}__vb`)}).classList.contains('hidden')`)) {
            const at = await center(page, `#${id}`);
            await tap(page, at.x, at.y);
        }
    } else {
        // The pointer comes in from outside the pictures (a tile that moved under it gets no new "enter"), and rests on
        // the lower right of the picture: a popover opens near the button, never over that spot.
        const at = await center(page, `#${tile.consumerId || tile.producerId}__video`);
        await move(page, 1, 1);
        await sleep(60);
        await move(page, at.x + at.w * 0.3 - 30, at.y + at.h * 0.25 + 20);
        await move(page, at.x + at.w * 0.3, at.y + at.h * 0.25);
    }
    await sleep(700);
}

async function roomSuite(kind) {
    const label = kind === 'd' ? 'desktop 1440x900' : 'phone 390x844';
    const phone = kind === 'm';
    section(`room: the flag (${label})`);
    await ctl('/reset');
    await ctl('/config', { replayEnabled: false });
    let page = await openRoom(kind, '', { flagOff: true });
    const off = await page.ev(`harness.addRemoteScreen({ peerName: 'Beltrano' })`);
    await buffers(page, [{ producerId: off.producerId, peerName: 'Beltrano', bufferSeconds: 200 }]);
    await sleep(300);
    check(
        'with the flag off there is no button, no badge and no gallery button',
        await page.ev(
            `!document.querySelector('.replay-btn') && !document.querySelector('.replay-badge') && document.getElementById('replayGalleryButton').classList.contains('hidden') && Replay.state.enabled === false`
        )
    );
    await page.close();
    await ctl('/config', { replayEnabled: true });

    section(`room: the button and the badge (${label})`);
    page = await openRoom(kind);
    const remote = await page.ev(`harness.addRemoteScreen({ peerName: 'Beltrano' })`);
    const other = await page.ev(`harness.addRemoteScreen({ peerName: 'Ciclano' })`);
    const camera = await page.ev(`harness.addCamera({ peerName: 'Dona Maria' })`);
    const own = await page.ev(`harness.addOwnScreen()`);
    await sleep(500);
    check(
        'the gallery button is on, in the bottom bar, between the view menu and the settings',
        await page.ev(
            `(() => { const b = document.getElementById('replayGalleryButton'); const bar = document.getElementById('bottomButtons'); return !b.classList.contains('hidden') && b.parentElement === bar && !!b.querySelector('i.fa-film') && (b.nextElementSibling?.id === 'settingsSplit'); })()`
        )
    );
    check(
        'before the server says what it keeps there is no button and no badge',
        await page.ev(`!document.querySelector('.replay-btn') && !document.querySelector('.replay-badge')`)
    );
    await shot(page, 'room-tiles-nothing-kept');
    await buffers(page, [
        { producerId: remote.producerId, peerName: 'Beltrano', bufferSeconds: 150, codec: 'vp8', hasAudio: true },
        { producerId: other.producerId, peerName: 'Ciclano', bufferSeconds: 320, codec: 'vp8', hasAudio: true },
        { producerId: own.producerId, peerName: 'Eu', bufferSeconds: 40, codec: 'vp8', hasAudio: false },
    ]);
    await sleep(500);
    const buttons = await page.ev(
        `[...document.querySelectorAll('.replay-btn')].map((b) => ({ id: b.id, tile: b.closest('.Camera')?.id || b.closest('.videoMenuBar')?.id, label: b.getAttribute('aria-label'), hidden: b.hidden }))`
    );
    check(
        'the screens the server keeps get the button, the camera does not',
        buttons.length === 3 &&
            !buttons.some((b) => b.hidden) &&
            buttons.every((b) => !b.tile.startsWith(camera.consumerId)),
        show(buttons)
    );
    check(
        'the button says what it does',
        buttons.some((b) => b.label === 'Salvar replay da tela de Beltrano') &&
            buttons.some((b) => b.label === 'Salvar replay da tela de Ciclano'),
        show(buttons.map((b) => b.label))
    );
    check(
        'my own screen has it too',
        buttons.some((b) => b.id === `${own.producerId}__replay`)
    );
    check(
        phone
            ? 'the button is a real button, at the end of the bar (a phone has no pin button)'
            : 'the button is a real button, next to the pin button',
        await page.ev(
            `(() => { const b = document.getElementById(${show(`${remote.producerId}__replay`)}); const pin = document.getElementById(${show(`${remote.consumerId}__pin`)}); if (!b || b.tagName !== 'BUTTON' || b.type !== 'button') return false; ${phone ? `return !pin && b.parentElement.id === ${show(`${remote.consumerId}__vb`)} && b.parentElement.classList.contains('mobile-floating');` : `return b.parentElement === pin.parentElement && Math.abs([...b.parentElement.children].indexOf(b) - [...b.parentElement.children].indexOf(pin)) === 1;`} })()`
        )
    );
    const badges = await page.ev(
        `[...document.querySelectorAll('.replay-badge')].map((b) => ({ text: b.textContent, shown: getComputedStyle(b).display !== 'none', tile: b.parentElement.className }))`
    );
    check(
        'a "Replay" badge sits on every screen being kept',
        badges.length === 3 && badges.every((b) => b.text === 'Replay' && b.shown && b.tile === 'Camera'),
        show(badges)
    );
    check(
        'the badge does not catch clicks',
        await page.ev(`getComputedStyle(document.querySelector('.replay-badge')).pointerEvents === 'none'`)
    );
    await shot(page, 'room-tiles');

    await showBar(page, remote);
    check(
        'the hover bar shows the button',
        await page.ev(
            `(() => { const b = document.getElementById(${show(`${remote.producerId}__replay`)}); const r = b.getBoundingClientRect(); return r.width > 20 && r.height > 20 && getComputedStyle(b.parentElement).display !== 'none'; })()`
        )
    );
    if (!phone) {
        const button = await center(page, `#${remote.producerId}__replay`);
        await move(page, button.x, button.y);
        await sleep(600);
        check(
            'hovering it shows a tooltip',
            await page.ev(
                `!!document.querySelector('[data-tippy-root]') || !!document.getElementById(${show(`${remote.producerId}__replay`)}).title`
            )
        );
        await shot(page, 'room-hover-bar');
    } else {
        await shot(page, 'room-hover-bar');
    }

    section(`room: the popover (${label})`);
    await keep(page, remote, other, own);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    const pop =
        await page.ev(`(() => { const p = document.querySelector('.replay-popover'); const r = p.getBoundingClientRect(); const b = document.getElementById(${show(`${remote.producerId}__replay`)}); return {
        role: p.getAttribute('role'), modal: p.hasAttribute('aria-modal'), title: p.querySelector('.replay-pop-title').textContent, sub: p.querySelector('.replay-pop-sub').textContent,
        options: [...p.querySelectorAll('.replay-opt')].map((o) => ({ text: o.textContent, disabled: o.getAttribute('aria-disabled'), title: o.title })),
        note: p.querySelector('.replay-pop-note').hidden ? '' : p.querySelector('.replay-pop-note').textContent,
        expanded: b.getAttribute('aria-expanded'), focus: p.contains(document.activeElement), inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        below: r.top >= b.getBoundingClientRect().bottom - 1, parent: p.parentElement.tagName, z: getComputedStyle(p).zIndex }; })()`);
    check(
        'the popover is a dialog (not a modal), anchored to the button, outside the screens',
        pop.role === 'dialog' && !pop.modal && pop.parent === 'BODY' && pop.expanded === 'true' && pop.below,
        show(pop)
    );
    check(
        'it says whose screen and what is available',
        pop.title === 'Salvar replay da tela de Beltrano' && /^Disponível: últimos 2:[34]\d$/.test(pop.sub),
        show([pop.title, pop.sub])
    );
    check(
        'four options: 1, 2, 3 and 5 min',
        show(pop.options.map((o) => o.text)) === show(['1 min', '2 min', '3 min', '5 min']),
        show(pop.options)
    );
    check(
        'the ones longer than the buffer are off, with the hint',
        pop.options[0].disabled === 'false' &&
            pop.options[1].disabled === 'false' &&
            pop.options[2].disabled === 'true' &&
            pop.options[3].disabled === 'true' &&
            /^A tela começou há 2:[34]\d$/.test(pop.options[2].title) &&
            /a tela começou há 2:[34]\d/i.test(pop.note),
        show(pop)
    );
    check('focus moved into it', pop.focus);
    check('it fits in the window', pop.inside);
    check('it is above everything else', Number(pop.z) >= 10000, pop.z);
    await shot(page, 'room-popover');
    if (!phone) {
        // the pointer goes from the button into the popover: the bar must not vanish
        const option = await center(page, '.replay-opt[data-seconds="60"]');
        await move(page, option.x, option.y);
        await sleep(400);
        check(
            'the hover bar stays while the popover is open',
            await page.ev(
                `getComputedStyle(document.getElementById(${show(`${remote.consumerId}__vb`)})).display !== 'none'`
            )
        );
    }

    if (!phone) await showBar(page, remote); // the pointer leaves the popover: the bar is the picture's again
    await press(page, 'Escape');
    check('Esc closes it', !(await page.ev(`!!document.querySelector('.replay-popover')`)));
    check(
        'and the focus goes back to the button',
        await page.ev(`document.activeElement === document.getElementById(${show(`${remote.producerId}__replay`)})`)
    );
    check(
        'the hover bar returns to what it was',
        await page.ev(`!document.getElementById(${show(`${remote.consumerId}__vb`)}).classList.contains('replay-keep')`)
    );
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    check('the button toggles it', !(await page.ev(`!!document.querySelector('.replay-popover')`)));
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    if (phone) await tap(page, 195, 700);
    else {
        await move(page, 700, 800);
        await page.click(700, 800);
    }
    await sleep(250);
    check('a click or tap outside closes it', !(await page.ev(`!!document.querySelector('.replay-popover')`)));
    await showBar(page, other);
    await activate(page, `#${other.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    check(
        'with 5 minutes kept every option is on',
        (await page.ev(
            `[...document.querySelectorAll('.replay-opt')].every((o) => o.getAttribute('aria-disabled') === 'false') && document.querySelector('.replay-pop-note').hidden`
        )) === true
    );
    check(
        '"Disponível" never goes above the limit',
        (await page.ev(`document.querySelector('.replay-pop-sub').textContent`)) === 'Disponível: últimos 5:00'
    );
    await press(page, 'Escape');
    await keep(page, remote, other, own);
    await showBar(page, own);
    await activate(page, `#${own.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    check(
        'on a screen kept only for a few seconds all options are off',
        await page.ev(
            `[...document.querySelectorAll('.replay-opt')].every((o) => o.getAttribute('aria-disabled') === 'true') && /a tela começou há 0:4/i.test(document.querySelector('.replay-pop-note').textContent)`
        )
    );
    await shot(page, 'room-popover-young');
    await press(page, 'Escape');
    await activate(page, `#${own.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    const ownDisabled = await page.ev(
        `(() => { document.querySelector('.replay-opt').click(); return harness.socket.emitted.filter((e) => e.event === 'replayRequest').length; })()`
    );
    check(
        'an option that is off does nothing when pressed',
        ownDisabled === 0 && (await page.ev(`!!document.querySelector('.replay-popover')`))
    );
    await press(page, 'Escape');

    section(`room: the keyboard (${label})`);
    await keep(page, remote, other, own);
    await showBar(page, remote);
    await page.ev(`document.getElementById(${show(`${remote.producerId}__replay`)}).focus()`);
    await press(page, 'Enter');
    await until(page, `!!document.querySelector('.replay-popover')`);
    check(
        'Enter on the button opens it and focuses the first option that is on',
        await page.ev(`document.activeElement === document.querySelector('.replay-opt[data-seconds="60"]')`)
    );
    await press(page, 'ArrowDown');
    check(
        'the down arrow goes to the next option',
        await page.ev(`document.activeElement === document.querySelector('.replay-opt[data-seconds="120"]')`)
    );
    await press(page, 'ArrowDown');
    await press(page, 'ArrowDown');
    await press(page, 'ArrowDown');
    check(
        'and wraps around',
        await page.ev(`document.activeElement === document.querySelector('.replay-opt[data-seconds="60"]')`)
    );
    await press(page, 'End');
    check(
        'End goes to the last',
        await page.ev(`document.activeElement === document.querySelector('.replay-opt[data-seconds="300"]')`)
    );
    await press(page, 'ArrowUp');
    await press(page, 'ArrowUp');
    check(
        'the up arrow goes back',
        await page.ev(`document.activeElement === document.querySelector('.replay-opt[data-seconds="120"]')`)
    );
    await press(page, 'Escape');
    check(
        'Esc closes it and the button has the focus again',
        await page.ev(
            `!document.querySelector('.replay-popover') && document.activeElement === document.getElementById(${show(`${remote.producerId}__replay`)})`
        )
    );
    check(
        'the button shows a focus ring',
        await page.ev(
            `(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; })()`
        )
    );
    await press(page, 'Enter');
    await until(page, `!!document.querySelector('.replay-popover')`);
    await press(page, 'Tab');
    await press(page, 'Tab');
    await press(page, 'Tab');
    await press(page, 'Tab');
    await press(page, 'Tab');
    await sleep(200);
    check('Tab out of the popover closes it', !(await page.ev(`!!document.querySelector('.replay-popover')`)));

    section(`room: one click, one request, and its toasts (${label})`);
    await page.ev(
        `Replay.timings.savedMs = 900; Replay.timings.errorMs = 900; Replay.timings.otherMs = 900; Replay.timings.leaveMs = 50`
    );
    await showBar(page, remote);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    const twoMin = await center(page, '.replay-opt[data-seconds="120"]');
    if (phone) await tap(page, twoMin.x, twoMin.y);
    else {
        await move(page, twoMin.x, twoMin.y);
        await page.click(twoMin.x, twoMin.y);
        await page.click(twoMin.x, twoMin.y);
    }
    await sleep(300);
    const requested = await emitted(page, 'replayRequest');
    check(
        'a click on "2 min" asks the server once, for that screen and that many seconds',
        requested.length === 1 && requested[0].producerId === remote.producerId && requested[0].seconds === 120,
        show(requested)
    );
    check('the popover is gone', !(await page.ev(`!!document.querySelector('.replay-popover')`)));
    const generating = await page.ev(
        `(() => { const t = document.querySelector('.replay-toast--generating'); return t ? { text: t.textContent, bar: !!t.querySelector('.replay-toast-bar'), icon: !!t.querySelector('.replay-toast-icon'), close: !!t.querySelector('.replay-toast-close') } : null; })()`
    );
    check(
        'a "generating" toast shows at once, with a spinner and an indeterminate bar',
        !!generating &&
            /Gerando replay…/.test(generating.text) &&
            generating.bar &&
            generating.icon &&
            !generating.close,
        show(generating)
    );
    await shot(page, 'room-toast-generating');
    check(
        'toasts live in the bottom left corner, over nothing but the picture',
        await page.ev(
            `(() => { const r = document.querySelector('.replay-toast').getBoundingClientRect(); return r.left < 120 && r.bottom > innerHeight * 0.5; })()`
        )
    );
    check(
        'the toasts are in a live region',
        await page.ev(`document.getElementById('replayToasts').getAttribute('role') === 'status'`)
    );
    check(
        'the container does not catch clicks, only the toasts do (no invisible layer)',
        await page.ev(
            `getComputedStyle(document.getElementById('replayToasts')).pointerEvents === 'none' && getComputedStyle(document.querySelector('.replay-toast')).pointerEvents === 'auto'`
        )
    );
    const first = await page.ev(`harness.socket.lastRequestId`);
    await page.ev(`harness.socket.fire('replayStatus', { requestId: ${show(first)}, state: 'preparing' })`);
    check(
        '"preparing" keeps the generating toast',
        await page.ev(`!!document.querySelector('.replay-toast--generating')`)
    );
    const clipId = '20261003-141502-3f9a2c1b-x7k2';
    await page.ev(
        `harness.socket.fire('replayStatus', { requestId: ${show(first)}, state: 'done', clip: { id: ${show(clipId)}, sharer: 'Beltrano', seconds: 120 } })`
    );
    await sleep(200);
    const saved = await page.ev(
        `(() => { const t = document.querySelector('.replay-toast--saved'); if (!t) return null; const a = t.querySelector('a'); return { text: t.textContent, href: a.getAttribute('href'), target: a.target, rel: a.rel, label: a.getAttribute('aria-label'), close: !!t.querySelector('button.replay-toast-close'), generating: !!document.querySelector('.replay-toast--generating') }; })()`
    );
    check(
        '"done" turns it into "Replay salvo na galeria"',
        !!saved && /Replay salvo na galeria/.test(saved.text) && !saved.generating,
        show(saved)
    );
    check(
        'with a "Ver ▸" link that opens that clip in a new tab, for the room',
        !!saved &&
            /Ver ▸/.test(saved.text) &&
            saved.href === `/replay/?clip=${clipId}&from=room` &&
            saved.target === '_blank' &&
            /noopener/.test(saved.rel),
        show(saved)
    );
    check('and a close button', !!saved && saved.close);
    check(
        'the gallery button counts the new clip',
        (await page.ev(`document.getElementById('replayGalleryBadge').textContent`)) === '1' &&
            /1 novo/.test(await page.ev(`document.getElementById('replayGalleryButton').getAttribute('aria-label')`))
    );
    await shot(page, 'room-toast-saved');
    await until(page, `!document.querySelector('.replay-toast--saved')`, 3000);
    check('the saved toast goes away by itself', !(await page.ev(`!!document.querySelector('.replay-toast--saved')`)));
    check(
        'and with nothing to show, no container is left behind',
        !(await page.ev(`!!document.getElementById('replayToasts')`))
    );

    // the toast can be closed, and it waits while the pointer is on it
    await page.ev(`Replay.timings.savedMs = 5000`);
    await showBar(page, remote);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    await activate(page, '.replay-opt[data-seconds="60"]', { scroll: false });
    await sleep(300);
    const second = await page.ev(`harness.socket.lastRequestId`);
    await page.ev(
        `harness.socket.fire('replayStatus', { requestId: ${show(second)}, state: 'done', clip: { id: '20261003-141600-aaaaaaaa-0001', sharer: 'Beltrano', seconds: 60 } })`
    );
    await sleep(200);
    await activate(page, '.replay-toast--saved .replay-toast-close', { scroll: false });
    await sleep(250);
    check('the ✕ closes the toast', !(await page.ev(`!!document.querySelector('.replay-toast--saved')`)));
    await page.ev(`Replay.timings.savedMs = 900`);

    // an error from the server answering the request, one saying so afterwards, one that never answers
    await page.ev(`harness.socket.ack = () => ({ error: 'limite', code: 'RATE_LIMITED' })`);
    await showBar(page, remote);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    await activate(page, '.replay-opt[data-seconds="60"]', { scroll: false });
    await sleep(300);
    const errorToast = await page.ev(
        `(() => { const t = document.querySelector('.replay-toast--error'); return t ? t.textContent : null; })()`
    );
    check(
        'if the server refuses, an error toast says so',
        errorToast === 'Não deu para gerar o replay — tente de novo',
        errorToast || 'none'
    );
    check(
        'and the generating toast is gone',
        !(await page.ev(`!!document.querySelector('.replay-toast--generating')`))
    );
    await shot(page, 'room-toast-error');
    await until(page, `!document.querySelector('.replay-toast--error')`, 3000);
    await page.ev(
        `harness.socket.ack = (event) => (event === 'replayRequest' ? { ok: true, requestId: 'req-late' } : undefined)`
    );
    await showBar(page, remote);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    await activate(page, '.replay-opt[data-seconds="60"]', { scroll: false });
    await sleep(200);
    await page.ev(
        `harness.socket.fire('replayStatus', { requestId: 'req-late', state: 'error', message: 'ffmpeg falhou' })`
    );
    await sleep(200);
    check(
        'if the clip fails afterwards, the same error toast shows',
        !!(await page.ev(`!!document.querySelector('.replay-toast--error')`))
    );
    await until(page, `!document.querySelector('.replay-toast--error')`, 3000);
    // the status can beat the answer
    await page.ev(
        `harness.socket.ack = (event) => { if (event === 'replayRequest') { harness.socket.fire('replayStatus', { requestId: 'req-fast', state: 'done', clip: { id: '20261003-141700-bbbbbbbb-0002', sharer: 'Beltrano', seconds: 60 } }); return { ok: true, requestId: 'req-fast' }; } }`
    );
    await showBar(page, remote);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    await activate(page, '.replay-opt[data-seconds="60"]', { scroll: false });
    check(
        'a status that arrives before the answer is not lost',
        !!(await until(page, `!!document.querySelector('.replay-toast--saved')`, 2000))
    );
    await until(page, `!document.querySelector('.replay-toast--saved')`, 3000);
    await page.ev(`Replay.timings.ackMs = 400; harness.socket.ack = () => undefined`);
    await showBar(page, remote);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    await activate(page, '.replay-opt[data-seconds="60"]', { scroll: false });
    check(
        'a server that never answers ends in the error toast',
        !!(await until(page, `!!document.querySelector('.replay-toast--error')`, 3000))
    );
    await until(page, `!document.querySelector('.replay-toast--error')`, 3000);
    await page.ev(`harness.socket.ack = harness.socket.defaultAck`);

    section(`room: what other people save, and the counter (${label})`);
    const countBefore = await page.ev(`document.getElementById('replayGalleryBadge').textContent`);
    await page.ev(
        `harness.socket.fire('replayCreated', { clip: { id: '20261003-142000-cccccccc-0003', sharer: 'Beltrano', requestedBy: 'Fulano' }, requestedBy: 'Fulano', sharerPeerId: 'x' })`
    );
    await sleep(200);
    const discreet = await page.ev(
        `(() => { const t = document.querySelector('.replay-toast--other'); if (!t) return null; const a = t.querySelector('a'); return { text: t.textContent.replace(/\\s+/g, ' ').trim(), href: a.getAttribute('href'), size: parseFloat(getComputedStyle(t).fontSize) }; })()`
    );
    check(
        'somebody else saving a clip gives a discreet toast',
        !!discreet && /^Fulano salvou um replay da tela de Beltrano · Ver/.test(discreet.text),
        show(discreet)
    );
    check(
        'whose link opens that clip for the room',
        !!discreet && discreet.href === '/replay/?clip=20261003-142000-cccccccc-0003&from=room'
    );
    check(
        'the counter on the gallery button went up',
        (await page.ev(`document.getElementById('replayGalleryBadge').textContent`)) ===
            String(Number(countBefore || 0) + 1),
        countBefore
    );
    await shot(page, 'room-toast-others');
    await page.ev(
        `harness.socket.fire('replayCreated', { clip: { id: '20261003-142000-cccccccc-0003', sharer: 'Beltrano', requestedBy: 'Fulano' }, requestedBy: 'Fulano' })`
    );
    check(
        'the same clip announced again is counted once',
        (await page.ev(`document.getElementById('replayGalleryBadge').textContent`)) ===
            String(Number(countBefore || 0) + 1)
    );
    await page.ev(
        `harness.socket.fire('replayCreated', { clip: { id: '20261003-142100-dddddddd-0004', sharer: 'Beltrano', requestedBy: 'Eu' }, requestedBy: 'Eu' })`
    );
    await sleep(100);
    check(
        'a clip I saved myself gets no discreet toast (mine says it)',
        (await page.ev(`document.querySelectorAll('.replay-toast--other').length`)) === 1
    );
    for (let i = 0; i < 12; i++)
        await page.ev(
            `harness.socket.fire('replayCreated', { clip: { id: '20261003-1430${String(i).padStart(2, '0')}-eeeeeeee-${String(i).padStart(4, '0')}', sharer: 'Beltrano', requestedBy: 'Zé' }, requestedBy: 'Zé' })`
        );
    await sleep(150);
    check(
        'the counter stops at 9+',
        (await page.ev(`document.getElementById('replayGalleryBadge').textContent`)) === '9+'
    );
    check(
        'and toasts never pile up beyond four',
        (await page.ev(`document.querySelectorAll('.replay-toast').length`)) <= 4
    );
    await shot(page, 'room-gallery-counter');
    await page.ev(`window.__opened = []; window.open = (...args) => { window.__opened.push(args); return null; }`);
    await showBarIfNeeded(page);
    await activate(page, '#replayGalleryButton', { scroll: false });
    const opened = await page.ev(`window.__opened`);
    check(
        'the gallery button opens the gallery for the room in a new tab',
        opened.length === 1 && opened[0][0] === '/replay/?from=room' && opened[0][1] === '_blank',
        show(opened)
    );
    check(
        'and the counter goes back to zero',
        await page.ev(
            `document.getElementById('replayGalleryBadge').classList.contains('hidden') && /^Galeria de replays$/.test(document.getElementById('replayGalleryButton').getAttribute('aria-label'))`
        )
    );
    await page.ev(`Replay.timings.otherMs = 400`);

    section(`room: the ticket (${label})`);
    await ctl('/config', { requireAuth: true });
    const ticket = (await ctl('/ticket')).ticket;
    await page.ev(`harness.socket.fire('replayTicket', { ticket: ${show(ticket)}, expiresAt: Date.now() + 60000 })`);
    check(
        'the ticket is exchanged for the access cookie',
        !!(await until(page, `Replay.state.session === 'ok'`, 3000)) && (await mockState()).stats.sessions === 1
    );
    await page.ev(`harness.socket.fire('replayTicket', { ticket: ${show(ticket)}, expiresAt: Date.now() + 60000 })`);
    await sleep(300);
    check(
        'the same ticket goes once',
        (await mockState()).stats.sessions === 1 &&
            (await mockState()).log.filter((e) => e.path === '/replay/api/session').length === 1
    );
    check(
        'and the gallery then opens without a password (same browser)',
        (await page.ev(`fetch('/replay/api/me').then((r) => r.status)`)) === 200
    );
    await page.ev(`harness.socket.fire('replayTicket', { ticket: 'invented', expiresAt: 0 })`);
    await sleep(300);
    check(
        'a ticket the server does not know changes nothing and breaks nothing',
        (await mockState()).stats.sessions === 1 && (await page.ev(`Replay.state.session`)) === 'failed'
    );
    await ctl('/config', { requireAuth: false });

    section(`room: when the server cannot keep up (${label})`);
    await buffers(page, [{ producerId: remote.producerId, peerName: 'Beltrano', bufferSeconds: 200 }], {
        available: false,
        reason: 'load',
    });
    await sleep(300);
    check(
        'while it is paused the badge goes and the button is off, with the reason',
        await page.ev(
            `(() => { const b = document.getElementById(${show(`${remote.producerId}__replay`)}); const badge = document.querySelector('#${remote.consumerId}__video .replay-badge'); return b.getAttribute('aria-disabled') === 'true' && /indisponível/.test(b.getAttribute('aria-label')) && badge.hidden; })()`
        )
    );
    await showBar(page, remote);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await sleep(300);
    check('and pressing it opens nothing', !(await page.ev(`!!document.querySelector('.replay-popover')`)));
    await shot(page, 'room-unavailable');
    await buffers(page, [{ producerId: remote.producerId, peerName: 'Beltrano', bufferSeconds: 200 }]);
    await sleep(300);
    check(
        'when it recovers everything comes back',
        await page.ev(
            `document.getElementById(${show(`${remote.producerId}__replay`)}).getAttribute('aria-disabled') === 'false' && !document.querySelector('#${remote.consumerId}__video .replay-badge').hidden`
        )
    );
    await showBar(page, remote);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    await buffers(page, [{ producerId: remote.producerId, peerName: 'Beltrano', bufferSeconds: 200 }], {
        available: false,
        reason: 'load',
    });
    await sleep(300);
    check(
        'a popover that is open when the pause comes shows it and turns everything off',
        await page.ev(
            `[...document.querySelectorAll('.replay-opt')].every((o) => o.getAttribute('aria-disabled') === 'true') && /indisponível agora/.test(document.querySelector('.replay-pop-note').textContent)`
        )
    );
    await shot(page, 'room-popover-unavailable');
    await press(page, 'Escape');
    await buffers(page, [{ producerId: remote.producerId, peerName: 'Beltrano', bufferSeconds: 200 }]);

    section(`room: tiles that go away, and the pin (${label})`);
    await buffers(page, [
        { producerId: remote.producerId, peerName: 'Beltrano', bufferSeconds: 200 },
        { producerId: other.producerId, peerName: 'Ciclano', bufferSeconds: 200 },
    ]);
    await sleep(200);
    check(
        'a screen that is not listed any more loses its button and badge',
        await page.ev(
            `document.getElementById(${show(`${own.producerId}__replay`)}).hidden && document.querySelector('#${own.producerId}__video .replay-badge').hidden`
        )
    );
    if (!phone) {
        await showBar(page, other);
        await activate(page, `#${other.consumerId}__pin`, { scroll: false });
        await sleep(500);
        check(
            'pinning a screen keeps the button and the badge on it',
            await page.ev(
                `(() => { const t = document.getElementById(${show(`${other.consumerId}__video`)}); return t.className === 'pinned-video-container' && !!t.querySelector('.replay-badge') && !!t.querySelector('.replay-btn'); })()`
            )
        );
        await showBar(page, other);
        await activate(page, `#${other.producerId}__replay`, { scroll: false });
        await until(page, `!!document.querySelector('.replay-popover')`);
        const placed = await page.ev(
            `(() => { const r = document.querySelector('.replay-popover').getBoundingClientRect(); const b = document.getElementById(${show(`${other.producerId}__replay`)}).getBoundingClientRect(); return { below: r.top >= b.bottom - 1, near: Math.abs((r.left + r.width / 2) - (b.left + b.width / 2)) < 220 }; })()`
        );
        check('and its popover points at the button there', placed.below && placed.near, show(placed));
        await press(page, 'Escape');
        await activate(page, `#${other.consumerId}__pin`, { scroll: false });
        await sleep(300);
    }
    await showBar(page, remote);
    await activate(page, `#${remote.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    await page.ev(`harness.removeTile(${show(remote.consumerId)})`);
    await sleep(1300);
    check(
        'when the screen stops, its popover closes by itself',
        !(await page.ev(`!!document.querySelector('.replay-popover')`))
    );
    await buffers(page, [{ producerId: other.producerId, peerName: 'Ciclano', bufferSeconds: 200 }]); // the next message of the server
    check(
        'and with the next message of the server the room forgets it',
        !(await page.ev(`Replay.state.tiles.has(${show(remote.producerId)})`)) &&
            (await page.ev(`Replay.state.tiles.has(${show(other.producerId)})`))
    );

    section(`room: nothing is left over (${label})`);
    await sleep(1200);
    check(
        'with everything closed there is no popover, no toast container and no fixed layer of ours',
        await page.ev(
            `!document.querySelector('.replay-popover') && !document.getElementById('replayToasts') && [...document.body.children].filter((c) => getComputedStyle(c).position === 'fixed' && c.className && /replay/.test(c.className)).length === 0`
        )
    );
    const stray = await page.ev(
        `(() => { const e = document.elementFromPoint(24, innerHeight - 140); return e ? e.className.toString() : ''; })()`
    );
    check('where the toasts were, clicks reach the room again', !/replay/.test(stray), stray);
    await page.close();

    if (!phone) {
        section(`room: the buttons bar in a column on the left (${label})`);
        page = await openRoom(kind, '?bar=left');
        const left = await page.ev(`harness.addRemoteScreen({ peerName: 'Beltrano' })`);
        await buffers(page, [{ producerId: left.producerId, peerName: 'Beltrano', bufferSeconds: 200 }]);
        await page.ev(
            `harness.socket.fire('replayCreated', { clip: { id: '20261003-142000-ffffffff-0003', sharer: 'Beltrano', requestedBy: 'Fulano' }, requestedBy: 'Fulano' })`
        );
        await sleep(400);
        check(
            'the toasts move to the right of the bar',
            await page.ev(
                `(() => { const t = document.querySelector('.replay-toast').getBoundingClientRect(); const bar = document.getElementById('bottomButtons').getBoundingClientRect(); return t.left >= bar.right; })()`
            )
        );
        await shot(page, 'room-bar-left');
        await page.close();
    }

    section(`room: reduced motion (${label})`);
    page = await openRoom(kind);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const calm = await page.ev(`harness.addRemoteScreen({ peerName: 'Beltrano' })`);
    await buffers(page, [{ producerId: calm.producerId, peerName: 'Beltrano', bufferSeconds: 200 }]);
    await showBar(page, calm);
    await activate(page, `#${calm.producerId}__replay`, { scroll: false });
    await until(page, `!!document.querySelector('.replay-popover')`);
    check(
        'with reduced motion asked the popover does not animate',
        await page.ev(`getComputedStyle(document.querySelector('.replay-popover')).animationName === 'none'`)
    );
    check(
        'nor does the badge pulse',
        await page.ev(`getComputedStyle(document.querySelector('.replay-badge'), '::before').animationName === 'none'`)
    );
    await page.close();
}

// Shows the buttons bar if the room hides it (it hides after a while without movement).
async function showBarIfNeeded(page) {
    await page.ev(`(() => { const bar = document.getElementById('bottomButtons'); bar.style.display = 'flex'; })()`);
}

// ---- run ----------------------------------------------------------------------------------------------------------------

// ONLY=room-d,gallery-m runs just those (names: gallery-d, edges-d, room-d, gallery-m, edges-m, room-m).
const only = new Set((process.env.ONLY || '').split(',').filter(Boolean));
const wanted = (name) => !only.size || only.has(name);

try {
    for (const [name, suite, kind] of [
        ['gallery-d', gallerySuite, 'd'],
        ['edges-d', galleryEdges, 'd'],
        ['room-d', roomSuite, 'd'],
        ['gallery-m', gallerySuite, 'm'],
        ['edges-m', galleryEdges, 'm'],
        ['room-m', roomSuite, 'm'],
    ]) {
        if (wanted(name)) await suite(kind);
    }

    section('the page code');
    check('no script error on any page', pageProblems.length === 0, pageProblems.slice(0, 3).join(' | '));
} catch (error) {
    failures++;
    console.log(`FAIL  the test itself crashed: ${error.stack || error}`);
} finally {
    chrome.close();
    await mock.close();
    rmSync(downloads, { recursive: true, force: true });
}

console.log(
    `\nscreenshots: ${shotDir}  (${existsSync(shotDir) ? readdirSync(shotDir).filter((f) => f.endsWith('.png')).length : 0} files)`
);
console.log(failures ? `\n${failures} of ${total} check(s) failed` : `\nall ${total} checks passed`);
process.exit(failures ? 1 : 0);
