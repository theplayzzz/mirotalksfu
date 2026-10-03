// The window-audio rule, checked in a real browser page: whichever way a screen share starts, the options the
// app passes to getDisplayMedia() must ask for the audio of the shared window only (windowAudio 'window') and
// for the system audio when a whole screen is shared (systemAudio 'include').
//
//   in the room   - the share button of the room
//   before joining - the share button of the join screen (toggleScreenSharing)
//
// tests/test-AudioCaptureGuard.js checks the same thing in the source code; this one checks what really runs.
//
//   E2E_CHROME=... E2E_ORIGIN=https://mirotalk-dev... E2E_TOKEN=$(ssh ... dev-test-token.sh 20) node tests/e2e/audio-guard.mjs
import { joinTestRoom, launchChrome, sleep, startScreenShare, stubScreenCapture } from './lib.mjs';

const { E2E_CHROME: chromePath, E2E_ORIGIN: origin, E2E_TOKEN: token } = process.env;
if (!chromePath || !origin || !token) throw new Error('set E2E_CHROME, E2E_ORIGIN and E2E_TOKEN');

const chrome = await launchChrome({ chrome: chromePath });
let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
};
const rightOptions = (call) => !!call && call.audio === true && call.windowAudio === 'window' && call.systemAudio === 'include';

try {
    // ---- the share button inside the room ------------------------------------------------------------------
    const room = await chrome.newPage();
    await stubScreenCapture(room, { withAudio: true });
    await joinTestRoom(room, { origin, token, name: 'AG-Room' });
    await startScreenShare(room);
    const roomCalls = await room.ev('window.__displayMediaCalls');
    check('in the room: one getDisplayMedia call', roomCalls.length === 1, JSON.stringify(roomCalls.map((c) => Object.keys(c))));
    check('in the room: windowAudio "window", systemAudio "include", audio on', rightOptions(roomCalls[0]), JSON.stringify(roomCalls[0]));
    await room.close();

    // ---- the share button on the join screen -----------------------------------------------------------------
    const join = await chrome.newPage();
    await stubScreenCapture(join, { withAudio: true });
    await join.send('Page.navigate', { url: `${origin}/join/?room=teste&roomPassword=${encodeURIComponent(token)}&name=AG-Join&audio=0&video=0&screen=0&hide=0&notify=0` });
    for (let i = 0; i < 120 && !(await join.ev("typeof toggleScreenSharing === 'function' && !!document.getElementById('usernameInput')").catch(() => false)); i++) await sleep(250);
    await sleep(1000);
    await join.ev('toggleScreenSharing()');
    await sleep(1500);
    const joinCalls = await join.ev('window.__displayMediaCalls');
    check('before joining: one getDisplayMedia call', joinCalls.length === 1, JSON.stringify(joinCalls.map((c) => Object.keys(c))));
    check('before joining: windowAudio "window", systemAudio "include", audio on', rightOptions(joinCalls[0]), JSON.stringify(joinCalls[0]));
    await join.close();
} finally {
    chrome.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
