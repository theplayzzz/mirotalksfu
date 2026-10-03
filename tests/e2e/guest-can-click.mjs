// Regression test for the bug of 2026-10-01: only the presenter could click anything in the room.
//
// A closed SweetAlert2 join dialog was left in the page (an invisible layer over everything) for everybody who
// was not the first to join, so a guest could not click "share screen", could not leave, and could not hover or
// pin a video. A presenter and a guest join the test room; the guest must be able to click the main buttons, to
// start a screen share, and the presenter must see the guest's screen with the hover bar (pin, full screen).
//
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 20) node tests/e2e/guest-can-click.mjs
import { joinTestRoom, launchChrome, sleep, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');

const chrome = await launchChrome({ chrome: chromePath });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

// Is the element the one that receives a click at its center, or does something cover it?
const coverage = `(() => {
    showButtons();
    const hit = (id) => {
        const b = document.getElementById(id);
        if (!b) return 'missing';
        const r = b.getBoundingClientRect();
        const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return t === b || b.contains(t) ? 'ok' : 'BLOCKED by ' + (t?.className || t?.id || t?.tagName);
    };
    return {
        isPresenter,
        startScreenButton: hit('startScreenButton'),
        exitButton: hit('exitButton'),
        settingsButton: hit('settingsButton'),
        leftoverContainers: document.querySelectorAll('.swal2-container').length,
    };
})()`;

try {
    const presenter = await chrome.newPage();
    await stubScreenCapture(presenter);
    await joinTestRoom(presenter, { origin, token, name: 'GC-Presenter' });
    const p = await presenter.ev(coverage);
    check('the presenter is the first to join', p.isPresenter === true, JSON.stringify(p));

    const guest = await chrome.newPage();
    await stubScreenCapture(guest);
    await joinTestRoom(guest, { origin, token, name: 'GC-Guest' });
    await sleep(2500); // the safety net for the join dialog acts 1.5 s after joining

    const g = await guest.ev(coverage);
    check('the guest is not the presenter', g.isPresenter === false, JSON.stringify(g));
    check('no dialog layer is left over the room', g.leftoverContainers === 0, `containers: ${g.leftoverContainers}`);
    check('the share button receives clicks', g.startScreenButton === 'ok', g.startScreenButton);
    check('the exit button receives clicks', g.exitButton === 'ok', g.exitButton);
    check('the settings button receives clicks', g.settingsButton === 'ok', g.settingsButton);

    // The guest shares the screen with a real click
    await guest.send('Page.bringToFront');
    const position = await guest.ev(`(() => { showButtons(); const r = document.getElementById('startScreenButton').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await guest.click(position[0], position[1]);
    let sharing = false;
    for (let i = 0; i < 60 && !sharing; i++) {
        sharing = await guest.ev("[...rc.producers.values()].some((x) => x.kind === 'video' && !x.closed)");
        await sleep(250);
    }
    check('the guest can start a screen share', sharing);

    // The presenter sees the guest's screen and its hover bar
    await presenter.send('Page.bringToFront');
    let tile = null;
    for (let i = 0; i < 60 && !tile; i++) {
        tile = await presenter.ev(`(() => { const v = [...document.querySelectorAll('video')].find((v) => v.id && !v.hasAttribute('name') && v.closest('.Camera') && rc.consumers.has(v.id)); if (!v) return null; const r = v.getBoundingClientRect(); return { id: v.id, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await sleep(250);
    }
    check("the presenter receives the guest's screen", !!tile);
    if (tile) {
        await presenter.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tile.x - 5, y: tile.y - 5 });
        await presenter.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tile.x, y: tile.y });
        await sleep(900);
        const bar = await presenter.ev(`(() => { const bar = [...document.querySelectorAll('.videoMenuBar')].find((x) => getComputedStyle(x).display !== 'none' && !x.classList.contains('hidden')); return { visible: !!bar, pin: !!bar?.querySelector('[id$=__pin]') }; })()`);
        check('hovering the screen shows its bar with the pin button', bar.visible && bar.pin, JSON.stringify(bar));
    }
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
