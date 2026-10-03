// The recorder restarts while a screen is being shared (a crash, an out-of-memory kill, a deploy that touches only
// it). It forgets its registrations; the SFU has to notice and connect the screen to it again, without the sharer or
// the viewers doing anything. The test shares a screen, restarts the recorder with RESTART_RECORDER_CMD, and watches
// what the room is told: the screen may disappear for a few seconds and must come back and keep growing.
//
//   RESTART_RECORDER_CMD='ssh ovh-mirotalk "sudo docker restart mirotalk-replay-dev"' \
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 30) node tests/e2e/replay-recorder-restart.mjs
import { spawnSync } from 'node:child_process';
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token, RESTART_RECORDER_CMD: restartCommand } = process.env;
if (!chromePath || !origin || !token || !restartCommand) throw new Error('set E2E_CHROME, E2E_ORIGIN, E2E_TOKEN and RESTART_RECORDER_CMD');

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};

const watch = `(() => {
    window.__buffers = [];
    const timer = setInterval(() => {
        try {
            if (typeof socket === 'undefined' || !socket || typeof socket.on !== 'function' || socket.__watched) return;
            socket.__watched = true;
            socket.on('replayBuffers', (data) => window.__buffers.push({ at: Date.now(), data }));
            clearInterval(timer);
        } catch (e) {}
    }, 10);
})();`;

const chrome = await launchChrome({ chrome: chromePath });
try {
    const sharer = await chrome.newPage();
    await stubScreenCapture(sharer, { withAudio: true });
    await joinTestRoom(sharer, { origin, token, name: 'RR-Sharer' });
    const viewer = await chrome.newPage();
    await viewer.send('Page.addScriptToEvaluateOnNewDocument', { source: watch });
    await joinTestRoom(viewer, { origin, token, name: 'RR-Viewer' });
    await startScreenShare(sharer);

    const kept = async () => {
        const last = await viewer.ev('(() => { const l = window.__buffers; return l.length ? l[l.length - 1].data : null; })()');
        const share = last && last.shares && last.shares[0];
        return { kept: share ? share.bufferSeconds : null, available: last ? last.available : null, hasAudio: share ? share.hasAudio : null };
    };

    // it records, for 35 s
    for (let i = 0; i < 7; i++) await sleep(5000);
    const before = await kept();
    check('before the restart the screen is kept, with its sound', before.kept !== null && before.kept >= 20 && before.hasAudio === true, JSON.stringify(before));

    console.log('restarting the recorder ...');
    const restarted = spawnSync(restartCommand, { shell: true, encoding: 'utf8', timeout: 90000 });
    check('the recorder was restarted', restarted.status === 0, (restarted.stderr || restarted.stdout || '').trim().slice(0, 200));

    // The SFU checks the recorder every 5 s and a share that the recorder does not list for 8 s is connected again
    const timeline = [];
    for (let i = 0; i < 12; i++) {
        await sleep(5000);
        timeline.push(await kept());
    }
    console.log('seconds kept after the restart, every 5 s:', JSON.stringify(timeline.map((t) => (t.kept === null ? 'none' : t.kept))));
    const final = timeline[timeline.length - 1];
    check('a minute after the restart the screen is being kept again', final.kept !== null && final.kept >= 10, JSON.stringify(final));
    check('with its sound', final.hasAudio === true, JSON.stringify(final));
    check('and replay is available', final.available === true, JSON.stringify(final));
    const regrowing = timeline.map((t) => t.kept).filter((k) => k !== null);
    let growing = true;
    for (let i = 1; i < regrowing.length; i++) if (regrowing[i] < regrowing[i - 1]) growing = false;
    check('the counter grows again from where the new recording started', growing && regrowing.length >= 4, JSON.stringify(regrowing));

    // and it still makes a clip
    const clip = await viewer.ev(`new Promise((resolve) => {
        const share = window.__buffers[window.__buffers.length - 1].data.shares[0];
        let requestId = null;
        socket.on('replayStatus', (s) => { if (s.requestId === requestId && (s.state === 'done' || s.state === 'error')) resolve(s); });
        socket.emit('replayRequest', { producerId: share.producerId, seconds: 10 }, (answer) => { if (answer.error) resolve(answer); else requestId = answer.requestId; });
        setTimeout(() => resolve({ error: 'timeout' }), 20000);
    })`);
    check('and a clip can be made from what was recorded after the restart', clip.state === 'done' && clip.clip && clip.clip.hasAudio === true, JSON.stringify(clip).slice(0, 240));
} catch (error) {
    check('the test ran to the end', false, error.message);
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
