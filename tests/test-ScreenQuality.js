'use strict';

require('should');

const fs = require('node:fs');
const path = require('node:path');
const Peer = require('../app/src/Peer');
const rules = require('../public/js/ScreenQuality');
const { pickLayer, pickTemporal, temporalLayersOf, decide, follow, layerScales, pickH264, chooseCodec } = rules;

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

        it('does not read whether the window or the page is hidden', () => {
            source.should.not.match(/visibilityState|visibilitychange|document\.hidden|IntersectionObserver/);
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

        it('asks for the frame-rate layer of a screen that is sent in one size', () => {
            const tile = (width, dpr = 1) => ({ visible: true, width: width * dpr, cssWidth: width });
            const wanted = (width, dpr) => decide({ layers: 1, topWidth: 1920, tile: tile(width, dpr), temporalLayers: 3 });
            wanted(300).should.deepEqual({ spatialLayer: 0, temporalLayer: 0, reason: 'visible' });
            wanted(600).should.containEql({ spatialLayer: 0, temporalLayer: 1 });
            wanted(1400).should.containEql({ spatialLayer: 0, temporalLayer: 2 });
            // the size on the screen counts, not the device pixels: a thumbnail on a 2x display is still a thumbnail
            wanted(300, 2).should.containEql({ temporalLayer: 0 });
            // without frame-rate layers (H.264) there is nothing to reduce
            decide({ layers: 1, topWidth: 1920, tile: tile(300), temporalLayers: 1 }).should.containEql({ temporalLayer: 0 });
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

        it('picks the H.264 entry that covers 1080p60 and has the simplest profile', () => {
            const codecs = [vp8, h264('42e01f'), h264('42e02a'), h264('4d0032')];
            pickH264(codecs).parameters['profile-level-id'].should.equal('42e02a');
            // no 4.2 baseline: main 5.0
            pickH264([vp8, h264('42e01f'), h264('4d0032')]).parameters['profile-level-id'].should.equal('4d0032');
            // only a low level: better than nothing
            pickH264([vp8, h264('42e01f')]).parameters['profile-level-id'].should.equal('42e01f');
            // high profile only
            pickH264([h264('640032')]).parameters['profile-level-id'].should.equal('640032');
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
