'use strict';

require('should');

const fs = require('node:fs');
const path = require('node:path');
const Peer = require('../app/src/Peer');
const rules = require('../public/js/ScreenQuality');
const { pickLayer, pickTemporal, temporalLayersOf, decide, follow, layerScales, pickH264, h264Rank, chooseCodec, pickScreenCodec, fractionOf, lowestAllowed, struggling, adapt } = rules;

describe('test-ScreenQuality', () => {
    // The people of the room did not want screens to stop when they leave a window or look at something else, and a
    // stopped one takes 1 to 10 s to come back. A guard against putting it back by accident: the code of the page (not
    // its comments) has no request to pause and does not look at whether the window is hidden.
    describe('the page never pauses a screen', () => {
        const source = fs
            .readFileSync(path.join(__dirname, '../public/js/ScreenQuality.js'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');

        it('has no request to pause a video', () => {
            source.should.not.match(/paused\s*:\s*true/);
            source.should.not.match(/\.pause\(/);
        });

        it('does not watch whether the window or the page is hidden to change what it asks for', () => {
            source.should.not.match(/visibilitychange|document\.hidden|IntersectionObserver/);
            // the one place that reads it: a page nobody sees drops frames on purpose, so health() does not judge the viewer then
            (source.match(/visibilityState/g) || []).should.have.length(1);
            source.should.match(/visibilityState === 'hidden'\) \{\s*state\.calmSince = 0;\s*return;/);
        });
    });

    describe('layers', () => {
        it('knows the size of each layer', () => {
            layerScales(1).should.deepEqual([1]);
            layerScales(2).should.deepEqual([0.5, 1]);
            layerScales(3).should.deepEqual([0.25, 0.5, 1]);
            layerScales(7).should.deepEqual([0.25, 0.5, 1]);
        });

        it('picks the smallest layer that still fits the tile', () => {
            // three layers of a 1920 px screen: 480, 960, 1920
            pickLayer(3, 1920, 300).should.equal(0);
            pickLayer(3, 1920, 500).should.equal(0); // 480 is within 10% of 500
            pickLayer(3, 1920, 600).should.equal(1);
            pickLayer(3, 1920, 960).should.equal(1); // a 2x2 grid tile on a 1080p screen
            pickLayer(3, 1920, 1100).should.equal(2);
            pickLayer(3, 1920, 3840).should.equal(2); // never above the top layer
            // two layers: 960, 1920
            pickLayer(2, 1920, 400).should.equal(0);
            pickLayer(2, 1920, 1300).should.equal(1);
            // one layer: always the only one
            pickLayer(1, 1920, 100).should.equal(0);
            // a smaller shared window: layers are smaller too
            pickLayer(3, 1280, 900).should.equal(2);
            pickLayer(3, 1280, 600).should.equal(1);
        });

        it('knows how many frame-rate layers a scalability mode has', () => {
            temporalLayersOf('L1T3').should.equal(3);
            temporalLayersOf('L3T3').should.equal(3);
            temporalLayersOf('S1T2').should.equal(2);
            temporalLayersOf('L1T1').should.equal(1);
            temporalLayersOf(undefined).should.equal(1);
            temporalLayersOf('').should.equal(1);
        });

        it('gives a thumbnail the lowest frame rate, a medium tile the middle one and a big tile all of it', () => {
            // 3 layers = 60, 30 and 15 fps; the width is the one the eye sees, in CSS pixels
            pickTemporal(3, 250).should.equal(0); // a thumbnail
            pickTemporal(3, 450).should.equal(0);
            pickTemporal(3, 640).should.equal(1); // a 3x3 grid on a 1080p window
            pickTemporal(3, 720).should.equal(1);
            pickTemporal(3, 950).should.equal(2); // a 2x2 grid keeps every frame
            pickTemporal(3, 1920).should.equal(2);
            // two layers: 30 and 15 fps; one layer (H.264) cannot be reduced
            pickTemporal(2, 250).should.equal(0);
            pickTemporal(2, 640).should.equal(1);
            pickTemporal(1, 100).should.equal(0);
            // the size of the tile is not known: do not reduce anything
            pickTemporal(3, 0).should.equal(2);
            pickTemporal(3, undefined).should.equal(2);
        });
    });

    describe('what a screen should get', () => {
        const visible = { visible: true, width: 960 };

        it('asks for the layer of a visible tile', () => {
            decide({ layers: 3, topWidth: 1920, tile: visible }).should.deepEqual({
                spatialLayer: 1,
                temporalLayer: 0,
                reason: 'visible',
            });
        });

        it('(tile mode) asks for the frame-rate layer of the tile, but never leaves the screen below 24 fps', () => {
            const tile = (width, dpr = 1) => ({ visible: true, width: width * dpr, cssWidth: width });
            const wanted = (width, dpr, senderFps = 60) => decide({ layers: 1, topWidth: 1920, tile: tile(width, dpr), temporalLayers: 3, senderFps });
            // a 60 fps sender: the lowest layer is 15 fps, below the floor, so even a thumbnail gets 30 fps
            wanted(300).should.deepEqual({ spatialLayer: 0, temporalLayer: 1, reason: 'floor' });
            wanted(600).should.deepEqual({ spatialLayer: 0, temporalLayer: 1, reason: 'visible' });
            wanted(1400).should.containEql({ spatialLayer: 0, temporalLayer: 2 });
            // the size on the screen counts, not the device pixels: a thumbnail on a 2x display is still a thumbnail
            wanted(300, 2).should.containEql({ temporalLayer: 1 });
            // The first version took a screen sent at 16 fps down to 4 fps in a small tile. A sender that gives 45 fps could
            // only be taken to 22 fps (below the floor): everything. At 16 fps: everything. Not known yet: nothing is taken.
            wanted(300, 1, 45).should.containEql({ temporalLayer: 2 });
            wanted(300, 1, 16).should.containEql({ temporalLayer: 2 });
            wanted(300, 1, 0).should.containEql({ temporalLayer: 2 });
            // without frame-rate layers (H.264) there is nothing to reduce
            decide({ layers: 1, topWidth: 1920, tile: tile(300), temporalLayers: 1, senderFps: 60 }).should.containEql({ temporalLayer: 0 });
            // a screen sent in several sizes already has light small ones and keeps every frame
            decide({ layers: 3, topWidth: 1920, tile: tile(300), temporalLayers: 3 }).should.containEql({
                spatialLayer: 0,
                temporalLayer: 2,
            });
        });

        // The people of the room did not want screens to stop when they leave a window, and a stopped one takes 1 to 10 s to
        // come back (it needs a new full picture from the sender). Nothing pauses and nothing is lowered for it.
        it('never pauses: a tile nobody can see keeps the best layers, which is what a new consumer gets', () => {
            const out = { visible: false, width: 0, cssWidth: 0 };
            const best = decide({ layers: 1, topWidth: 1920, tile: out, temporalLayers: 3 });
            best.should.deepEqual({ spatialLayer: 0, temporalLayer: 2, reason: 'out-of-sight' });
            (best.paused === undefined).should.be.true();
            decide({ layers: 3, topWidth: 1920, tile: out, temporalLayers: 3 }).should.containEql({ spatialLayer: 2, temporalLayer: 2 });
            decide({ layers: 1, topWidth: 1920, tile: out, temporalLayers: 1 }).should.containEql({ spatialLayer: 0, temporalLayer: 0 });
        });

        it('does not look at the window at all: a hidden page asks for the same as a visible one', () => {
            // a page argument (hidden, picture in picture) used to decide a pause; it is not read any more
            const tile = { visible: true, width: 300, cssWidth: 300 };
            const asked = decide({ layers: 1, topWidth: 1920, tile, temporalLayers: 3 });
            decide({ layers: 1, topWidth: 1920, tile, temporalLayers: 3, page: { hidden: true } }).should.deepEqual(asked);
            decide({ layers: 3, topWidth: 1920, tile: visible, temporalLayers: 3, page: { hidden: true } }).should.have.property('spatialLayer');
            (asked.paused === undefined).should.be.true();
        });
    });

    // The first version cut screens by the size of the tile as if every sender gave 60 fps. Real senders give 16 to 60 (their
    // PCs also run the game): a screen sent at 16 fps became 4 fps in a small tile. These rules keep a floor under what is left.
    describe('the frame rate that is left', () => {
        it('knows what share of the frames each frame-rate layer carries', () => {
            fractionOf(2, 2).should.equal(1);
            fractionOf(1, 2).should.equal(0.5);
            fractionOf(0, 2).should.equal(0.25);
            fractionOf(0, 1).should.equal(0.5); // two layers
            fractionOf(0, 0).should.equal(1); // none
        });

        it('finds the lowest layer that still gives the floor, for the senders that really exist', () => {
            lowestAllowed(60, 2, 24).should.equal(1); // 15 fps is too little, 30 is fine
            lowestAllowed(60, 2, 12).should.equal(0); // a viewer that struggles may go to 15
            lowestAllowed(58, 2, 12).should.equal(0);
            lowestAllowed(45, 2, 24).should.equal(2); // 22 fps would be below the floor
            lowestAllowed(45, 2, 12).should.equal(1); // 22 fps is fine for a viewer that struggles, 11 is not
            lowestAllowed(32, 2, 12).should.equal(1); // 16 fps ok, 8 not
            lowestAllowed(16, 2, 12).should.equal(2); // a sender at 16 fps: nothing can be taken
            lowestAllowed(0, 2, 24).should.equal(2); // not known: nothing is taken
            lowestAllowed(60, 0, 24).should.equal(0); // a screen without layers has only one
        });
    });

    describe('is this viewer struggling?', () => {
        const row = (overrides) => ({ seconds: 2, fps: 58, drop: 0, frz: 0, loss: 0, decMs: 5, ...overrides });

        it('is not, when every frame is shown and the decoder has time', () => {
            struggling(row()).should.be.false();
            struggling(row({ decMs: 9 })).should.be.false(); // 9 ms x 58 fps = 52% busy
            struggling(null).should.be.false();
            struggling(row({ seconds: 0 })).should.be.false();
        });

        it('is, when the browser drops many frames before showing them (the 4-core laptop of the room: 300 a minute)', () => {
            struggling(row({ fps: 38, drop: 12 })).should.be.true(); // 12 of 88 = 14%
            struggling(row({ fps: 38, drop: 2 })).should.be.false(); // 2.6%: a few dropped is normal
        });

        it('is, when the decoder is busy most of the time', () => {
            struggling(row({ decMs: 13 })).should.be.true(); // 13 ms x 58 = 75%
        });

        it('is, when the picture froze although nothing was lost: it is not the network', () => {
            struggling(row({ frz: 2, loss: 0.1, drop: 4 })).should.be.true(); // some drops with the freeze
            struggling(row({ frz: 2, loss: 5, drop: 4 })).should.be.false(); // packets were lost: the network, the server handles it
            struggling(row({ frz: 2, loss: 0, drop: 0 })).should.be.false(); // a freeze alone says little
        });
    });

    describe('the adaptive mode: what to change, one at a time', () => {
        const entry = (id, layer, importance, senderFps = 60, top = 2) => ({ id, top, layer, senderFps, importance });
        const three = () => [entry('big', 2, 1e9 + 900000), entry('mid', 2, 400000), entry('small', 2, 150000)];

        it('does nothing while nobody struggles and it has not been calm long enough', () => {
            (adapt({ entries: three(), now: 100_000, struggle: false, calmSince: 90_000 }) === null).should.be.true();
        });

        it('takes a layer off the LEAST important screen first, all the way to its floor, then the next one, never the pinned one first', () => {
            adapt({ entries: three(), now: 100_000, struggle: true }).should.deepEqual({ id: 'small', layer: 1, why: 'struggle' });
            const next = [entry('big', 2, 1e9 + 900000), entry('mid', 2, 400000), entry('small', 1, 150000)];
            adapt({ entries: next, now: 120_000, struggle: true }).should.deepEqual({ id: 'small', layer: 0, why: 'struggle' });
            const after = [entry('big', 2, 1e9 + 900000), entry('mid', 2, 400000), entry('small', 0, 150000)];
            adapt({ entries: after, now: 140_000, struggle: true }).should.deepEqual({ id: 'mid', layer: 1, why: 'struggle' });
        });

        it('waits between changes: the numbers need time to show the effect', () => {
            (adapt({ entries: three(), now: 100_000, lastChangeAt: 95_000, struggle: true }) === null).should.be.true();
            adapt({ entries: three(), now: 104_000, lastChangeAt: 95_000, struggle: true }).should.containEql({ id: 'small' });
        });

        it('stops at the floor of a viewer that struggles (12 fps) and at the frame rate of the sender itself', () => {
            // a sender at 32 fps: layer 1 is 16 fps (fine), layer 0 is 8 fps (not): the screen can go to 1 and no lower
            const slow = [entry('a', 1, 1000, 32), entry('b', 2, 500, 32)];
            adapt({ entries: slow, now: 100_000, struggle: true }).should.deepEqual({ id: 'b', layer: 1, why: 'struggle' });
            const floor = [entry('a', 1, 1000, 32), entry('b', 1, 500, 32)];
            (adapt({ entries: floor, now: 100_000, struggle: true }) === null).should.be.true();
            // a sender at 16 fps cannot be reduced at all
            (adapt({ entries: [entry('a', 2, 1, 16)], now: 100_000, struggle: true }) === null).should.be.true();
        });

        it('gives a layer back, to the MOST important screen, only after 30 quiet seconds, one at a time', () => {
            const reduced = [entry('big', 2, 1e9), entry('mid', 1, 400000), entry('small', 1, 150000)];
            (adapt({ entries: reduced, now: 120_000, struggle: false, calmSince: 100_000 }) === null).should.be.true();
            adapt({ entries: reduced, now: 131_000, struggle: false, calmSince: 100_000 }).should.deepEqual({ id: 'mid', layer: 2, why: 'full' });
        });

        it('has nothing to do when every screen is already at its best', () => {
            (adapt({ entries: three(), now: 200_000, struggle: false, calmSince: 100_000 }) === null).should.be.true();
        });
    });

    describe('when to change', () => {
        const fresh = () => ({ applied: { spatialLayer: 2, temporalLayer: 0 }, candidate: null, lastChange: 0 });
        const layer = (spatialLayer, temporalLayer = 0) => ({ spatialLayer, temporalLayer, reason: 'visible' });

        it('does nothing while what is wanted is what is applied', () => {
            const state = fresh();
            (follow(state, layer(2), 1000) === null).should.be.true();
            (follow(state, layer(2), 9000) === null).should.be.true();
        });

        it('goes down slowly: only after the smaller size is still wanted 1.5 s later', () => {
            const state = fresh();
            (follow(state, layer(0), 10_000) === null).should.be.true();
            (follow(state, layer(0), 10_800) === null).should.be.true();
            follow(state, layer(0), 11_600).should.containEql({ spatialLayer: 0 });
            state.applied.should.deepEqual({ spatialLayer: 0, temporalLayer: 0 });
        });

        it('goes up quickly: 0.3 s', () => {
            const state = { applied: { spatialLayer: 0, temporalLayer: 0 }, candidate: null, lastChange: 0 };
            (follow(state, layer(2), 10_000) === null).should.be.true();
            follow(state, layer(2), 10_320).should.containEql({ spatialLayer: 2 });
        });

        it('does the same with frame-rate layers: down after 1.5 s, up after 0.3 s', () => {
            const state = { applied: { spatialLayer: 0, temporalLayer: 2 }, candidate: null, lastChange: 0 };
            (follow(state, layer(0, 0), 10_000) === null).should.be.true();
            (follow(state, layer(0, 0), 11_400) === null).should.be.true();
            follow(state, layer(0, 0), 11_600).should.containEql({ temporalLayer: 0 });
            (follow(state, layer(0, 2), 20_000) === null).should.be.true();
            (follow(state, layer(0, 2), 20_200) === null).should.be.true();
            follow(state, layer(0, 2), 20_320).should.containEql({ temporalLayer: 2 });
            state.applied.should.deepEqual({ spatialLayer: 0, temporalLayer: 2 });
        });

        it('forgets a change that was only wanted for a moment', () => {
            const state = fresh();
            (follow(state, layer(0), 10_000) === null).should.be.true();
            (follow(state, layer(2), 10_700) === null).should.be.true(); // back to what is applied
            (follow(state, layer(0), 10_800) === null).should.be.true(); // the wait starts again
            (follow(state, layer(0), 11_900) === null).should.be.true();
            follow(state, layer(0), 12_400).should.containEql({ spatialLayer: 0 });
        });

        it('a tile that comes back into view goes up at once to what it had: no pause, so no wait for a new picture', () => {
            // a thumbnail (15 fps) that is put back as the big tile asks for all frames after 0.3 s, never a pause
            const state = { applied: { spatialLayer: 0, temporalLayer: 0 }, candidate: null, lastChange: 0 };
            (follow(state, decide({ layers: 1, topWidth: 1920, tile: { visible: true, width: 1900, cssWidth: 1900 }, temporalLayers: 3 }), 50_000) === null).should.be.true();
            const change = follow(state, decide({ layers: 1, topWidth: 1920, tile: { visible: true, width: 1900, cssWidth: 1900 }, temporalLayers: 3 }), 50_300);
            change.should.containEql({ spatialLayer: 0, temporalLayer: 2 });
            (change.paused === undefined).should.be.true();
        });
    });

    describe('codec of the screen', () => {
        const h264 = (id, mode = 1) => ({
            mimeType: 'video/H264',
            clockRate: 90000,
            parameters: { 'packetization-mode': mode, 'profile-level-id': id, 'level-asymmetry-allowed': 1 },
        });
        const vp8 = { mimeType: 'video/VP8', clockRate: 90000 };

        it('uses H.264 when the server says so, or when it says auto and the browser encodes it smoothly in hardware', () => {
            chooseCodec('h264', null).should.equal('h264');
            chooseCodec('vp8', { supported: true, powerEfficient: true, smooth: true }).should.equal('vp8');
            chooseCodec('auto', { supported: true, powerEfficient: true, smooth: true }).should.equal('h264');
            chooseCodec('auto', { supported: true, powerEfficient: false, smooth: true }).should.equal('vp8');
            chooseCodec('auto', { supported: true, powerEfficient: true, smooth: false }).should.equal('vp8');
            chooseCodec('auto', { supported: false }).should.equal('vp8');
            chooseCodec('auto', null).should.equal('vp8');
            chooseCodec(undefined, null).should.equal('vp8');
        });

        it('picks the H.264 entry that covers 1080p60 and has a profile the hardware encoders take (Main first)', () => {
            const codecs = [vp8, h264('42e01f'), h264('42e02a'), h264('4d0032')];
            // Chrome on Windows encodes the Constrained Baseline in software: Main it is, though the Baseline 4.2 is "simpler"
            pickH264(codecs).parameters['profile-level-id'].should.equal('4d0032');
            pickH264([vp8, h264('42e01f'), h264('42e02a')]).parameters['profile-level-id'].should.equal('42e02a');
            // the plain Baseline (42001f) is hardware too, ahead of the constrained one
            pickH264([h264('42e02a'), h264('42002a')]).parameters['profile-level-id'].should.equal('42002a');
            // main before high
            pickH264([h264('640032'), h264('4d0032')]).parameters['profile-level-id'].should.equal('4d0032');
            // only a low level: better than nothing
            pickH264([vp8, h264('42e01f')]).parameters['profile-level-id'].should.equal('42e01f');
            // high profile only
            pickH264([h264('640032')]).parameters['profile-level-id'].should.equal('640032');
        });

        it('ranks the profiles: Main, High, Baseline, Constrained Baseline', () => {
            h264Rank(h264('4d0032')).should.equal(0);
            h264Rank(h264('640028')).should.equal(1);
            h264Rank(h264('42001f')).should.equal(2);
            h264Rank(h264('42e01f')).should.equal(3);
            h264Rank(h264('f4001f')).should.equal(4);
            h264Rank({ mimeType: 'video/H264', parameters: {} }).should.equal(4);
        });

        it('sends the screen in H.264 only where it is the hardware encoder (auto), or always when the server says so', () => {
            const hardware = { supported: true, powerEfficient: true, smooth: true };
            const room = [vp8, h264('42e01f'), h264('42e02a'), h264('4d0032')];
            pickScreenCodec('auto', hardware, room).parameters['profile-level-id'].should.equal('4d0032');
            (pickScreenCodec('auto', { supported: true, powerEfficient: false, smooth: true }, room) === null).should.be.true();
            (pickScreenCodec('auto', null, room) === null).should.be.true();
            (pickScreenCodec('vp8', hardware, room) === null).should.be.true();
            // a room that offers only the Constrained Baseline would give the software encoder: auto stays with VP8
            (pickScreenCodec('auto', hardware, [vp8, h264('42e01f'), h264('42e02a')]) === null).should.be.true();
            // the server said h264: the best entry there is
            pickScreenCodec('h264', null, [vp8, h264('42e01f'), h264('42e02a')]).parameters['profile-level-id'].should.equal('42e02a');
            (pickScreenCodec('h264', null, [vp8]) === null).should.be.true();
        });

        it('ignores entries it cannot use and finds nothing without H.264', () => {
            (pickH264([vp8]) === null).should.be.true();
            (pickH264([]) === null).should.be.true();
            (pickH264(undefined) === null).should.be.true();
            (pickH264([h264('42e02a', 0)]) === null).should.be.true(); // packetization mode 0 is not what the SFU uses
        });
    });

    describe('Peer.setConsumerPreferences (what the server does with the request)', () => {
        const createPeer = () => new Peer('peer-id', { peer_info: { peer_uuid: 'u', peer_name: 'Peer' } });

        const consumer = (overrides = {}) => {
            const calls = [];
            return Object.assign(
                {
                    id: 'c1',
                    producerId: 'p1',
                    kind: 'video',
                    type: 'simulcast',
                    closed: false,
                    paused: false,
                    rtpParameters: { encodings: [{ scalabilityMode: 'L3T3' }] },
                    appData: {},
                    calls,
                    setPreferredLayers: async (layers) => calls.push(['layers', layers]),
                    setPriority: async (priority) => calls.push(['priority', priority]),
                    pause: async function () {
                        this.paused = true;
                        calls.push(['pause']);
                    },
                    resume: async function () {
                        this.paused = false;
                        calls.push(['resume']);
                    },
                },
                overrides
            );
        };

        const withConsumer = (c) => {
            const peer = createPeer();
            peer.consumers.set(c.id, c);
            return peer;
        };

        it('sets the layers and the priority within the limits, and the pause only when it is allowed', async () => {
            const c = consumer();
            const peer = withConsumer(c);

            const applied = await peer.setConsumerPreferences('c1', { spatialLayer: 1, priority: 255, paused: true }, { allowPause: true });

            applied.should.deepEqual({ spatialLayer: 1, temporalLayer: 2, priority: 255, paused: true });
            c.calls.should.deepEqual([['layers', { spatialLayer: 1, temporalLayer: 2 }], ['priority', 255], ['pause']]);

            const clamped = await peer.setConsumerPreferences('c1', { spatialLayer: 99, temporalLayer: -4, priority: 9999, paused: false }, { allowPause: true });
            clamped.should.deepEqual({ spatialLayer: 2, temporalLayer: 0, priority: 255, paused: false });
        });

        // People did not want screens to stop when they leave a window, and a stopped one needs a new full picture from the
        // sender to start again (1 to 10 s). A browser with the first version of the page still asks for it: ignored.
        it('does not pause a video because a browser asks, unless SELECTIVE_PAUSE_HIDDEN is on (the default is off)', async () => {
            const c = consumer();
            const peer = withConsumer(c);

            const applied = await peer.setConsumerPreferences('c1', { spatialLayer: 1, paused: true });

            applied.should.deepEqual({ spatialLayer: 1, temporalLayer: 2, paused: false });
            c.paused.should.be.false();
            c.calls.should.deepEqual([['layers', { spatialLayer: 1, temporalLayer: 2 }]]); // the layers still count, no pause, no resume

            (await peer.setConsumerPreferences('c1', { paused: true }, {})).should.deepEqual({ paused: false });
            (await peer.setConsumerPreferences('c1', { paused: true }, { allowPause: false })).should.deepEqual({ paused: false });
            c.calls.should.have.length(1);
        });

        it('resumes a paused consumer when asked, whatever the setting', async () => {
            const c = consumer({ paused: true });
            const peer = withConsumer(c);

            const applied = await peer.setConsumerPreferences('c1', { paused: false });

            applied.should.deepEqual({ paused: false });
            c.calls.should.deepEqual([['resume']]);
        });

        it('leaves alone what was not asked and does not pause twice', async () => {
            const c = consumer();
            const peer = withConsumer(c);

            const applied = await peer.setConsumerPreferences('c1', { paused: false });

            applied.should.deepEqual({ paused: false });
            c.calls.should.deepEqual([]);
        });

        it('sets the frame-rate layer of a screen sent in one size (svc type, L1T3)', async () => {
            const c = consumer({ type: 'svc', rtpParameters: { encodings: [{ scalabilityMode: 'L1T3' }] } });
            const peer = withConsumer(c);

            const applied = await peer.setConsumerPreferences('c1', { spatialLayer: 0, temporalLayer: 0, paused: false });

            applied.should.deepEqual({ spatialLayer: 0, temporalLayer: 0, paused: false });
            c.calls.should.deepEqual([['layers', { spatialLayer: 0, temporalLayer: 0 }]]);

            const clamped = await peer.setConsumerPreferences('c1', { spatialLayer: 3, temporalLayer: 9 });
            clamped.should.containEql({ spatialLayer: 0, temporalLayer: 2 });
        });

        it('ignores layers of a consumer that has none, but can still pause it when that is allowed', async () => {
            const c = consumer({ type: 'simple', rtpParameters: { encodings: [{}] } });
            const peer = withConsumer(c);

            const applied = await peer.setConsumerPreferences('c1', { spatialLayer: 0, paused: true }, { allowPause: true });

            applied.should.deepEqual({ paused: true });
            c.calls.should.deepEqual([['pause']]);
        });

        it('refuses audio, unknown, closed and badly named consumers', async () => {
            const peer = withConsumer(consumer({ id: 'audio', kind: 'audio' }));
            peer.consumers.set('gone', consumer({ id: 'gone', closed: true }));
            const code = async (id) => {
                try {
                    await peer.setConsumerPreferences(id, { paused: true });
                } catch (error) {
                    return error.code;
                }
                return null;
            };

            (await code('audio')).should.equal('NOT_VIDEO');
            (await code('nope')).should.equal('CONSUMER_NOT_FOUND');
            (await code('gone')).should.equal('CONSUMER_NOT_FOUND');
            (await code(undefined)).should.equal('CONSUMER_NOT_FOUND');
            (await code({ id: 'c1' })).should.equal('CONSUMER_NOT_FOUND');
        });
    });
});
