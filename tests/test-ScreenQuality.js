'use strict';

require('should');

const Peer = require('../app/src/Peer');
const rules = require('../public/js/ScreenQuality');
const { pickLayer, pickTemporal, temporalLayersOf, decide, follow, layerScales, pickH264, chooseCodec } = rules;

describe('test-ScreenQuality', () => {
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
            // 3 layers = 60, 30 and 15 fps; the screen is 1920 px wide
            pickTemporal(3, 1920, 250).should.equal(0); // a thumbnail
            pickTemporal(3, 1920, 576).should.equal(0); // 30% is still a thumbnail
            pickTemporal(3, 1920, 700).should.equal(1); // 3x3 grid on a 1080p window
            pickTemporal(3, 1920, 864).should.equal(1); // 45%
            pickTemporal(3, 1920, 960).should.equal(2); // a 2x2 grid keeps every frame
            pickTemporal(3, 1920, 1920).should.equal(2);
            pickTemporal(3, 1920, 5000).should.equal(2);
            // two layers: 30 and 15 fps; one layer (H.264) cannot be reduced
            pickTemporal(2, 1920, 250).should.equal(0);
            pickTemporal(2, 1920, 700).should.equal(1);
            pickTemporal(1, 1920, 100).should.equal(0);
            // the size of the screen is not known yet: do not reduce anything
            pickTemporal(3, 0, 100).should.equal(2);
        });
    });

    describe('what a screen should get', () => {
        const visible = { visible: true, width: 960 };
        const page = { hidden: false, pictureInPicture: false };

        it('asks for the layer of a visible tile', () => {
            decide({ layers: 3, topWidth: 1920, tile: visible, page }).should.deepEqual({
                paused: false,
                spatialLayer: 1,
                temporalLayer: 0,
                reason: 'visible',
            });
        });

        it('asks for the frame-rate layer of a screen that is sent in one size', () => {
            const tile = (width) => ({ visible: true, width });
            const wanted = (width) => decide({ layers: 1, topWidth: 1920, tile: tile(width), page, temporalLayers: 3 });
            wanted(300).should.deepEqual({ paused: false, spatialLayer: 0, temporalLayer: 0, reason: 'visible' });
            wanted(800).should.containEql({ spatialLayer: 0, temporalLayer: 1 });
            wanted(1920).should.containEql({ spatialLayer: 0, temporalLayer: 2 });
            // without frame-rate layers (H.264) there is nothing to reduce
            decide({ layers: 1, topWidth: 1920, tile: tile(300), page, temporalLayers: 1 }).should.containEql({ temporalLayer: 0 });
            // a screen sent in several sizes already has light small ones and keeps every frame
            decide({ layers: 3, topWidth: 1920, tile: tile(300), page, temporalLayers: 3 }).should.containEql({
                spatialLayer: 0,
                temporalLayer: 2,
            });
        });

        it('pauses a tile nobody can see and everything when the page is hidden', () => {
            decide({ layers: 3, topWidth: 1920, tile: { visible: false, width: 0 }, page }).should.containEql({
                paused: true,
                reason: 'tile-hidden',
            });
            decide({ layers: 3, topWidth: 1920, tile: visible, page: { hidden: true } }).should.containEql({
                paused: true,
                reason: 'page-hidden',
            });
        });

        it('keeps watching in picture in picture even if the page is hidden', () => {
            decide({ layers: 3, topWidth: 1920, tile: visible, page: { hidden: true, pictureInPicture: true } }).paused.should.be.false();
        });
    });

    describe('when to change', () => {
        const fresh = () => ({ applied: { paused: false, spatialLayer: 2, temporalLayer: 0 }, candidate: null, lastChange: 0 });
        const layer = (spatialLayer, temporalLayer = 0) => ({ paused: false, spatialLayer, temporalLayer, reason: 'visible' });
        const hidden = (reason) => ({ paused: true, reason });

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
            state.applied.should.deepEqual({ paused: false, spatialLayer: 0, temporalLayer: 0 });
        });

        it('goes up quickly: 0.3 s', () => {
            const state = { applied: { paused: false, spatialLayer: 0, temporalLayer: 0 }, candidate: null, lastChange: 0 };
            (follow(state, layer(2), 10_000) === null).should.be.true();
            follow(state, layer(2), 10_320).should.containEql({ spatialLayer: 2 });
        });

        it('does the same with frame-rate layers: down after 1.5 s, up after 0.3 s', () => {
            const state = { applied: { paused: false, spatialLayer: 0, temporalLayer: 2 }, candidate: null, lastChange: 0 };
            (follow(state, layer(0, 0), 10_000) === null).should.be.true();
            (follow(state, layer(0, 0), 11_400) === null).should.be.true();
            follow(state, layer(0, 0), 11_600).should.containEql({ temporalLayer: 0 });
            (follow(state, layer(0, 2), 20_000) === null).should.be.true();
            (follow(state, layer(0, 2), 20_200) === null).should.be.true();
            follow(state, layer(0, 2), 20_320).should.containEql({ temporalLayer: 2 });
            state.applied.should.deepEqual({ paused: false, spatialLayer: 0, temporalLayer: 2 });
        });

        it('forgets a change that was only wanted for a moment', () => {
            const state = fresh();
            (follow(state, layer(0), 10_000) === null).should.be.true();
            (follow(state, layer(2), 10_700) === null).should.be.true(); // back to what is applied
            (follow(state, layer(0), 10_800) === null).should.be.true(); // the wait starts again
            (follow(state, layer(0), 11_900) === null).should.be.true();
            follow(state, layer(0), 12_400).should.containEql({ spatialLayer: 0 });
        });

        it('waits before pausing: 1.5 s for a hidden tile, 3 s for a hidden page; resumes at once', () => {
            const tile = fresh();
            (follow(tile, hidden('tile-hidden'), 10_000) === null).should.be.true();
            follow(tile, hidden('tile-hidden'), 11_600).should.containEql({ paused: true });

            const page = fresh();
            (follow(page, hidden('page-hidden'), 10_000) === null).should.be.true();
            (follow(page, hidden('page-hidden'), 12_900) === null).should.be.true();
            follow(page, hidden('page-hidden'), 13_100).should.containEql({ paused: true });

            follow(page, layer(1), 13_200).should.containEql({ paused: false, spatialLayer: 1 });
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

        it('sets the layers, the priority and the pause, within the limits', async () => {
            const c = consumer();
            const peer = withConsumer(c);

            const applied = await peer.setConsumerPreferences('c1', { spatialLayer: 1, priority: 255, paused: true });

            applied.should.deepEqual({ spatialLayer: 1, temporalLayer: 2, priority: 255, paused: true });
            c.calls.should.deepEqual([['layers', { spatialLayer: 1, temporalLayer: 2 }], ['priority', 255], ['pause']]);

            const clamped = await peer.setConsumerPreferences('c1', { spatialLayer: 99, temporalLayer: -4, priority: 9999, paused: false });
            clamped.should.deepEqual({ spatialLayer: 2, temporalLayer: 0, priority: 255, paused: false });
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

        it('ignores layers of a consumer that has none, but still pauses it', async () => {
            const c = consumer({ type: 'simple', rtpParameters: { encodings: [{}] } });
            const peer = withConsumer(c);

            const applied = await peer.setConsumerPreferences('c1', { spatialLayer: 0, paused: true });

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
