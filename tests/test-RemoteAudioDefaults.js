'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RoomClient = vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../public/js/RoomClient.js'), 'utf8') + '\nRoomClient;'
);

function viewer() {
    const audio = { dataset: { peerId: 'sender' }, volume: 1 };
    const button = { addEventListener: (_, fn) => (button.click = fn) };
    const rc = Object.assign(Object.create(RoomClient.prototype), {
        peer_id: 'viewer',
        remoteAudioDefaults: new Map(),
        locallyMutedPeerIds: new Set(),
        masterOutputVolume: 1,
        isMobileDevice: false,
        getOutputAudioElements: () => [audio],
        getOutputGainNode: () => null,
        refreshLocalPeerAudioButton() {},
        remoteAudioEl: { querySelectorAll: () => [audio] },
        getId: () => button,
    });
    rc.handleAU('mute', 'sender');
    return { rc, audio, button };
}

describe('remote stream audio defaults', () => {
    it('mutes before audio attaches, whichever media is announced first (including a silent screen)', () => {
        for (const type of ['audioType', 'screenType', 'videoType']) {
            const { rc, audio } = viewer();
            rc.initializeRemoteAudio('sender', type, 'producer-1');
            assert.equal(audio.volume, 0);
            const laterAudio = { dataset: { peerId: 'sender' }, volume: 1 };
            rc.applyOutputVolume(laterAudio);
            assert.equal(laterAudio.volume, 0);
        }
    });

    it('keeps the listener choice when audio arrives after the screen, or the same share is reconciled', () => {
        const { rc, audio, button } = viewer();
        rc.initializeRemoteAudio('sender', 'screenType', 'screen-1');
        button.click();
        assert.equal(audio.volume, 1);
        rc.initializeRemoteAudio('sender', 'audioType', 'audio-1');
        rc.initializeRemoteAudio('sender', 'screenType', 'screen-1');
        assert.equal(audio.volume, 1);
        assert.equal(rc.locallyMutedPeerIds.has('sender'), false);
    });

    it('mutes again for a new share from the same sender', () => {
        const { rc, audio, button } = viewer();
        rc.initializeRemoteAudio('sender', 'screenType', 'screen-1');
        button.click();
        rc.initializeRemoteAudio('sender', 'screenType', 'screen-2');
        assert.equal(audio.volume, 0);
        button.click();
        assert.equal(audio.volume, 1);
    });

    it('unmutes only the viewer who clicked, and keeps mute when the volume slider changes', () => {
        const first = viewer();
        const second = viewer();
        for (const { rc } of [first, second]) rc.initializeRemoteAudio('sender', 'screenType', 'screen-1');
        first.button.click();
        second.rc.setMasterOutputVolume(0.5);
        assert.equal(first.audio.volume, 1);
        assert.equal(second.audio.volume, 0);
        second.button.click();
        assert.equal(second.audio.volume, 0.5);
    });

    it('does not treat the local producer as a remote stream', () => {
        const { rc } = viewer();
        rc.initializeRemoteAudio('viewer', 'screenType', 'local-screen');
        assert.equal(rc.remoteAudioDefaults.size, 0);
        assert.equal(rc.locallyMutedPeerIds.size, 0);
    });
});
