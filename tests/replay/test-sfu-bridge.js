'use strict';

require('should');

const EventEmitter = require('node:events');
const { ReplayBridge, decideAvailability, describeStream, recorderCapabilities, DEFAULTS } = require('../../app/src/replay/ReplayBridge');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

// A mediasoup that records what is done to it
function fakes({ failRegister = false } = {}) {
    const calls = [];
    const log = (...entry) => calls.push(entry);

    const consumerFor = (producerId, kind) => {
        const media =
            kind === 'video'
                ? { mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, parameters: {} }
                : { mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2, parameters: { minptime: 10, useinbandfec: 1 } };
        const codecs = kind === 'video' ? [media, { mimeType: 'video/rtx', payloadType: 97, clockRate: 90000, parameters: { apt: 96 } }] : [media];
        return {
            id: `consumer-${producerId}`,
            kind,
            closed: false,
            paused: true,
            rtpParameters: { codecs, encodings: [kind === 'video' ? { ssrc: 1111, rtx: { ssrc: 2222 } } : { ssrc: 3333 }] },
            async resume() {
                this.paused = false;
                log('resume', producerId);
            },
            async pause() {
                this.paused = true;
                log('pause', producerId);
            },
            async requestKeyFrame() {
                log('keyframe', producerId);
            },
        };
    };

    const consumeCapabilities = [];
    const recorderRouter = {
        // like a real router's: every video codec asks for bandwidth estimation, and there are header extensions
        rtpCapabilities: {
            codecs: [
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    preferredPayloadType: 96,
                    parameters: {},
                    rtcpFeedback: [
                        { type: 'nack' },
                        { type: 'nack', parameter: 'pli' },
                        { type: 'ccm', parameter: 'fir' },
                        { type: 'goog-remb' },
                        { type: 'transport-cc' },
                    ],
                },
                { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: 100, parameters: {}, rtcpFeedback: [{ type: 'transport-cc' }] },
            ],
            headerExtensions: [{ kind: 'video', uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', preferredId: 5 }],
        },
        transports: [],
        async createPlainTransport(options) {
            log('createPlainTransport', options);
            const transport = {
                closed: false,
                observer: new EventEmitter(),
                consumers: [],
                async consume(consumeOptions) {
                    consumeCapabilities.push(consumeOptions.rtpCapabilities);
                    log('consume', consumeOptions.producerId, { paused: consumeOptions.paused });
                    const kind = consumeOptions.producerId.startsWith('audio') ? 'audio' : 'video';
                    const consumer = consumerFor(consumeOptions.producerId, kind);
                    transport.consumers.push(consumer);
                    return consumer;
                },
                async connect(parameters) {
                    log('connect', parameters);
                },
                close() {
                    if (transport.closed) return;
                    transport.closed = true;
                    log('transport closed');
                    transport.observer.emit('close');
                },
            };
            recorderRouter.transports.push(transport);
            return transport;
        },
    };

    const worker = {
        pid: 4242,
        closed: false,
        died: new EventEmitter(),
        once(event, handler) {
            this.died.once(event, handler);
        },
        async createRouter(options) {
            log('createRouter', options.mediaCodecs.length);
            return recorderRouter;
        },
        close() {
            this.closed = true;
        },
    };
    const mediasoup = {
        async createWorker() {
            log('createWorker');
            return worker;
        },
    };

    const knows = [];
    let registrations = 0;
    const client = {
        host: 'recorder.test',
        async registerShare(body) {
            log('registerShare', body);
            if (failRegister) throw new Error('recorder says no');
            if (!knows.includes(body.shareId)) knows.push(body.shareId);
            return { port: 41000 + registrations++ };
        },
        async listShares() {
            if (client.listFails) throw new Error('no answer');
            return { shares: knows.map((shareId) => ({ shareId, ended: false })) };
        },
        async patchShare(id, body) {
            log('patchShare', id, body);
            return { ok: true };
        },
        async deleteShare(id) {
            log('deleteShare', id);
            return { ok: true };
        },
        async health() {
            log('health');
            return { ok: true, diskFreeGb: 80 };
        },
    };

    const roomRouter = {
        async pipeToRouter(options) {
            log('pipeToRouter', options.producerId, options.listenInfo);
            return {};
        },
    };
    const producer = (id) => ({ id, observer: new EventEmitter() });

    return { calls, mediasoup, client, roomRouter, producer, recorderRouter, worker, consumeCapabilities, knows };
}

const names = (calls) => calls.map((entry) => entry[0]);

describe('test-sfu-bridge (the SFU side of the replay recorder)', () => {
    const make = (f, options = {}, extra = {}) =>
        new ReplayBridge({
            mediasoup: f.mediasoup,
            mediaCodecs: [{ mimeType: 'video/VP8' }, { mimeType: 'audio/opus' }],
            client: f.client,
            log: silent,
            resolve: async (host) => (host === 'recorder.test' ? '10.9.0.5' : '0.0.0.0'),
            options,
            ...extra,
        });

    describe('decideAvailability (when the recorder must stand aside)', () => {
        const fresh = () => ({ available: true, reason: null, highSince: 0, lowSince: 0, failures: 0 });
        const calm = { cpuPercent: 40, diskFreeGb: 80, recorderOk: true };
        const step = (state, sample, seconds) => decideAvailability(state, { ...calm, ...sample }, DEFAULTS, seconds * 1000);

        it('stays available while everything is fine', () => {
            let state = fresh();
            for (let t = 0; t < 120; t += 5) state = step(state, {}, t);
            state.available.should.be.true();
        });

        it('stops after the room worker is above 85% for 10 seconds, not before', () => {
            let state = fresh();
            state = step(state, { cpuPercent: 90 }, 100);
            state = step(state, { cpuPercent: 90 }, 105);
            state.available.should.be.true();
            state = step(state, { cpuPercent: 90 }, 110);
            state.available.should.be.false();
            state.reason.should.equal('load');
        });

        it('forgets a spike that went down in between', () => {
            let state = fresh();
            state = step(state, { cpuPercent: 95 }, 100);
            state = step(state, { cpuPercent: 80 }, 105); // under 85: the count starts again
            state = step(state, { cpuPercent: 95 }, 110);
            state = step(state, { cpuPercent: 95 }, 115);
            state.available.should.be.true();
            state = step(state, { cpuPercent: 95 }, 120);
            state.available.should.be.false();
        });

        it('comes back after 20 seconds under 70%, and 75% is not calm enough', () => {
            let state = { ...fresh(), available: false, reason: 'load' };
            state = step(state, { cpuPercent: 60 }, 100);
            state = step(state, { cpuPercent: 75 }, 110); // not under 70: the wait starts again
            state = step(state, { cpuPercent: 60 }, 115);
            state = step(state, { cpuPercent: 60 }, 130);
            state.available.should.be.false();
            state = step(state, { cpuPercent: 60 }, 135);
            state.available.should.be.true();
            (state.reason === null).should.be.true();
        });

        it('stops on a full disk and comes back only with a margin', () => {
            let state = fresh();
            state = step(state, { diskFreeGb: 9 }, 100);
            state.available.should.be.false();
            state.reason.should.equal('disk');
            state = step(state, { diskFreeGb: 10.5 }, 105); // 10 is the minimum, not enough yet
            state.available.should.be.false();
            state = step(state, { diskFreeGb: 11.5 }, 110);
            state.available.should.be.true();
        });

        it('stops when the recorder does not answer 3 times in a row, comes back when it does', () => {
            let state = fresh();
            state = step(state, { recorderOk: false, diskFreeGb: null }, 100);
            state = step(state, { recorderOk: false, diskFreeGb: null }, 105);
            state.available.should.be.true();
            state = step(state, { recorderOk: false, diskFreeGb: null }, 110);
            state.available.should.be.false();
            state.reason.should.equal('recorder');
            state = step(state, {}, 115);
            state.available.should.be.true();
        });

        it('does not count a sample without a measurement against anybody', () => {
            let state = fresh();
            for (let t = 0; t < 60; t += 5) state = step(state, { cpuPercent: null, diskFreeGb: null }, t);
            state.available.should.be.true();
        });
    });

    describe('recorderCapabilities (what the recorder asks mediasoup to send)', () => {
        const router = {
            codecs: [
                { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 96, parameters: { a: 1 }, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'goog-remb' }, { type: 'transport-cc' }] },
                { kind: 'video', mimeType: 'video/rtx', clockRate: 90000, preferredPayloadType: 97, parameters: { apt: 96 }, rtcpFeedback: [] },
                { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: 100, parameters: {}, rtcpFeedback: [{ type: 'transport-cc' }] },
            ],
            headerExtensions: [{ kind: 'video', uri: 'abs-send-time', preferredId: 4 }, { kind: 'video', uri: 'transport-wide-cc', preferredId: 5 }],
        };

        it('takes bandwidth estimation out of every codec: without it mediasoup throttles the recorder to 600 kbps', () => {
            const caps = recorderCapabilities(router);
            for (const codec of caps.codecs) {
                codec.rtcpFeedback.map((feedback) => feedback.type).should.not.containEql('transport-cc');
                codec.rtcpFeedback.map((feedback) => feedback.type).should.not.containEql('goog-remb');
            }
        });

        it('keeps what the recorder uses: nack, PLI and FIR', () => {
            recorderCapabilities(router).codecs[0].rtcpFeedback.should.deepEqual([{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }]);
        });

        it('has no header extensions, so there is nothing for a bandwidth estimator to read', () => {
            recorderCapabilities(router).headerExtensions.should.deepEqual([]);
        });

        it('keeps everything else of every codec, RTX included', () => {
            const caps = recorderCapabilities(router);
            caps.codecs.should.have.length(3);
            caps.codecs[0].should.containEql({ kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 96 });
            caps.codecs[0].parameters.should.deepEqual({ a: 1 });
            caps.codecs[1].should.containEql({ mimeType: 'video/rtx', preferredPayloadType: 97 });
            caps.codecs[2].should.containEql({ mimeType: 'audio/opus', channels: 2 });
        });

        it("does not change the router's own capabilities", () => {
            const before = JSON.stringify(router);
            recorderCapabilities(router);
            JSON.stringify(router).should.equal(before);
        });

        it('copes with capabilities that have no codecs or no feedback', () => {
            recorderCapabilities({}).should.deepEqual({ codecs: [], headerExtensions: [] });
            recorderCapabilities({ codecs: [{ mimeType: 'video/VP8' }] }).codecs[0].rtcpFeedback.should.deepEqual([]);
        });
    });

    describe('describeStream (what the recorder is told)', () => {
        it('describes VP8 with RTX and Opus with its parameters', async () => {
            const f = fakes();
            const bridge = make(f);
            await bridge.start();
            const transport = await bridge.router.createPlainTransport({});
            const video = await transport.consume({ producerId: 'video-1' });
            const audio = await transport.consume({ producerId: 'audio-1' });

            describeStream(video).should.deepEqual({
                codec: 'video/VP8',
                payloadType: 96,
                ssrc: 1111,
                clockRate: 90000,
                rtx: { ssrc: 2222, payloadType: 97 },
            });
            describeStream(audio).should.deepEqual({
                codec: 'audio/opus',
                payloadType: 100,
                ssrc: 3333,
                clockRate: 48000,
                channels: 2,
                fmtp: 'minptime=10;useinbandfec=1',
            });
            await bridge.stop();
        });

        it('refuses a consumer without an SSRC', () => {
            (() => describeStream({ rtpParameters: { codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }], encodings: [{}] } })).should.throw();
        });
    });

    describe('a screen', () => {
        it('is copied to the recorder router, offered to the recorder paused, and only resumed once it is connected', async () => {
            const f = fakes();
            const bridge = make(f);
            await bridge.start();

            await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'Beltrano', peerUuid: 'u1', producer: f.producer('video-1') });

            const order = names(f.calls);
            order.slice(order.indexOf('pipeToRouter')).should.deepEqual([
                'pipeToRouter',
                'createPlainTransport',
                'consume',
                'registerShare',
                'connect',
                'resume',
            ]);

            const byName = (name) => f.calls.find((entry) => entry[0] === name);
            byName('pipeToRouter')[2].should.containEql({ protocol: 'udp', ip: '127.0.0.1' });
            const transportOptions = byName('createPlainTransport')[1];
            transportOptions.should.containEql({ rtcpMux: true, comedia: false, enableSrtp: false });
            transportOptions.listenInfo.portRange.should.deepEqual({ min: 52000, max: 52999 });
            byName('consume')[2].should.deepEqual({ paused: true });
            // both consumers are made with capabilities that leave out bandwidth estimation
            f.consumeCapabilities.should.have.length(1);
            JSON.stringify(f.consumeCapabilities[0]).should.not.match(/transport-cc|goog-remb|abs-send-time|transport-wide-cc/);
            f.consumeCapabilities[0].codecs[0].rtcpFeedback.map((feedback) => feedback.type).should.containEql('nack');
            byName('registerShare')[1].should.deepEqual({
                shareId: 'video-1',
                roomId: 'link',
                peerName: 'Beltrano',
                video: { codec: 'video/VP8', payloadType: 96, ssrc: 1111, clockRate: 90000, rtx: { ssrc: 2222, payloadType: 97 } },
            });
            byName('connect')[1].should.deepEqual({ ip: '10.9.0.5', port: 41000 });

            bridge.list().should.deepEqual([
                { shareId: 'video-1', roomId: 'link', peerName: 'Beltrano', peerUuid: 'u1', codec: 'vp8', hasAudio: false, startedAt: bridge.getShare('video-1').startedAt },
            ]);
            await bridge.stop();
        });

        it('takes the audio of the screen along, after the video is registered', async () => {
            const f = fakes();
            const bridge = make(f);
            await bridge.start();

            // the audio arrives while the video is still being set up: it waits its turn
            const video = bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'B', peerUuid: 'u1', producer: f.producer('video-1') });
            const audio = bridge.addScreenAudio({ shareId: 'video-1', router: f.roomRouter, producer: f.producer('audio-1') });
            await Promise.all([video, audio]);

            const order = names(f.calls);
            order.indexOf('patchShare').should.be.above(order.indexOf('registerShare'));
            const patch = f.calls.find((entry) => entry[0] === 'patchShare');
            patch[1].should.equal('video-1');
            patch[2].audio.should.containEql({ codec: 'audio/opus', ssrc: 3333, channels: 2 });
            // the audio of the screen is made like the video: the transport must not learn about bandwidth estimation from it either
            f.consumeCapabilities.should.have.length(2);
            for (const caps of f.consumeCapabilities) JSON.stringify(caps).should.not.match(/transport-cc|goog-remb|abs-send-time|transport-wide-cc/);
            bridge.list()[0].hasAudio.should.be.true();
            await bridge.stop();
        });

        it('ignores the audio of a screen that is not being kept', async () => {
            const f = fakes();
            const bridge = make(f);
            await bridge.start();
            await bridge.addScreenAudio({ shareId: 'nope', router: f.roomRouter, producer: f.producer('audio-1') });
            names(f.calls).should.not.containEql('patchShare');
            await bridge.stop();
        });

        it('is dropped from the recorder when the sharer stops', async () => {
            const f = fakes();
            const bridge = make(f);
            await bridge.start();
            const producer = f.producer('video-1');
            await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'B', peerUuid: 'u1', producer });

            producer.observer.emit('close');
            await new Promise((resolve) => setImmediate(resolve));

            f.recorderRouter.transports[0].closed.should.be.true();
            f.calls.should.containEql(['deleteShare', 'video-1']);
            bridge.list().should.deepEqual([]);
            await bridge.stop();
        });

        it('is cleaned up, and never throws into the caller, when the recorder refuses it', async () => {
            const f = fakes({ failRegister: true });
            const bridge = make(f);
            await bridge.start();

            await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'B', peerUuid: 'u1', producer: f.producer('video-1') });

            f.recorderRouter.transports[0].closed.should.be.true();
            names(f.calls).should.not.containEql('connect');
            names(f.calls).should.not.containEql('deleteShare'); // it never got a port
            bridge.list().should.deepEqual([]);
            (bridge.getShare('video-1') === null).should.be.true();
            await bridge.stop();
        });

        it('is only started once, however many times it is announced', async () => {
            const f = fakes();
            const bridge = make(f);
            await bridge.start();
            const producer = f.producer('video-1');
            await Promise.all([
                bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'B', peerUuid: 'u1', producer }),
                bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'B', peerUuid: 'u1', producer }),
            ]);
            names(f.calls).filter((name) => name === 'registerShare').should.have.length(1);
            await bridge.stop();
        });

        it('closeRoom stops the screens of that room only', async () => {
            const f = fakes();
            const bridge = make(f);
            await bridge.start();
            await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'A', peerUuid: 'u1', producer: f.producer('video-1') });
            await bridge.addScreen({ roomId: 'teste', router: f.roomRouter, peerName: 'B', peerUuid: 'u2', producer: f.producer('video-2') });

            bridge.closeRoom('link');
            await new Promise((resolve) => setImmediate(resolve));

            bridge.list().map((share) => share.shareId).should.deepEqual(['video-2']);
            await bridge.stop();
        });

        it('asks the sender for a key frame every N seconds when told to (H.264 in hardware)', async () => {
            const f = fakes();
            const bridge = make(f, { keyFrameSafetyS: 0.02 });
            await bridge.start();
            await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'A', peerUuid: 'u1', producer: f.producer('video-1') });
            await new Promise((resolve) => setTimeout(resolve, 70));
            names(f.calls).filter((name) => name === 'keyframe').length.should.be.aboveOrEqual(2);
            await bridge.stop();
        });
    });

    describe('standing aside', () => {
        it('pauses every consumer and tells the recorder, then resumes them', async () => {
            const f = fakes();
            const bridge = make(f);
            await bridge.start();
            await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'A', peerUuid: 'u1', producer: f.producer('video-1') });
            await bridge.addScreenAudio({ shareId: 'video-1', router: f.roomRouter, producer: f.producer('audio-1') });
            const events = [];
            bridge.on('availability', (event) => events.push(event));

            f.calls.length = 0;
            await bridge.setAvailability({ available: false, reason: 'load' });
            f.calls.filter((entry) => entry[0] === 'pause').should.have.length(2);
            f.calls.should.containEql(['patchShare', 'video-1', { paused: true }]);
            bridge.available.should.be.false();
            events.should.deepEqual([{ available: false, reason: 'load' }]);

            f.calls.length = 0;
            await bridge.setAvailability({ available: true });
            f.calls.filter((entry) => entry[0] === 'resume').should.have.length(2);
            f.calls.should.containEql(['patchShare', 'video-1', { paused: false }]);
            await bridge.stop();
        });

        it('starts a screen paused when it is not available at that moment', async () => {
            const f = fakes();
            const bridge = make(f);
            await bridge.start();
            await bridge.setAvailability({ available: false, reason: 'load' });
            f.calls.length = 0;

            await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'A', peerUuid: 'u1', producer: f.producer('video-1') });

            names(f.calls).should.not.containEql('resume');
            f.calls.should.containEql(['patchShare', 'video-1', { paused: true }]);
            await bridge.stop();
        });

        it('measures the busiest room worker and the recorder health on every sample', async () => {
            const f = fakes();
            let time = 1_000_000;
            const usage = { a: 1000, b: 500 };
            const workers = [
                { pid: 1, closed: false, getResourceUsage: async () => ({ ru_utime: usage.a, ru_stime: 0 }) },
                { pid: 2, closed: false, getResourceUsage: async () => ({ ru_utime: usage.b, ru_stime: 100 }) },
            ];
            const bridge = make(f, {}, { roomWorkers: () => workers, now: () => time });
            await bridge.start();

            await bridge.sample(); // the first sample only sets the baseline
            time += 5000;
            usage.a += 4000; // 80% of 5 s
            usage.b += 1000; // 20%
            await bridge.sample();

            Math.round(bridge.cpuPercent).should.equal(80);
            bridge.diskFreeGb.should.equal(80);
            await bridge.stop();
        });

        it('turns itself off on a busy worker after the sustained time, and back on when it is calm', async () => {
            const f = fakes();
            let time = 1_000_000;
            let cpuMs = 0;
            const workers = [{ pid: 1, closed: false, getResourceUsage: async () => ({ ru_utime: cpuMs, ru_stime: 0 }) }];
            const bridge = make(f, {}, { roomWorkers: () => workers, now: () => time });
            await bridge.start();
            await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'A', peerUuid: 'u1', producer: f.producer('video-1') });
            await bridge.sample();

            const tick = async (percent) => {
                time += 5000;
                cpuMs += (percent / 100) * 5000;
                await bridge.sample();
            };
            await tick(95);
            await tick(95);
            bridge.available.should.be.true();
            await tick(95);
            bridge.available.should.be.false();
            bridge.reason.should.equal('load');
            bridge.getShare('video-1').consumers.video.paused.should.be.true();

            for (let i = 0; i < 4; i++) await tick(40);
            bridge.available.should.be.false();
            await tick(40);
            bridge.available.should.be.true();
            bridge.getShare('video-1').consumers.video.paused.should.be.false();
            await bridge.stop();
        });
    });

    describe('a recorder that restarted', () => {
        const setup = async (f) => {
            let time = 1_000_000;
            const bridge = make(f, {}, { now: () => time });
            await bridge.start();
            const video = f.producer('video-1');
            const audio = f.producer('audio-1');
            await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'A', peerUuid: 'u1', producer: video });
            await bridge.addScreenAudio({ shareId: 'video-1', router: f.roomRouter, producer: audio });
            return { bridge, video, audio, advance: (ms) => (time += ms) };
        };

        it('forgets its shares: the screen and its audio are connected to it again, on the new port', async () => {
            const f = fakes();
            const { bridge, advance } = await setup(f);
            advance(20000);

            f.knows.length = 0; // the recorder restarted: it lists nothing
            f.calls.length = 0;
            await bridge.sample();
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));

            f.recorderRouter.transports[0].closed.should.be.true();
            f.recorderRouter.transports.should.have.length(2);
            const registered = f.calls.find((entry) => entry[0] === 'registerShare');
            registered[1].should.containEql({ shareId: 'video-1', roomId: 'link', peerName: 'A' });
            f.calls.find((entry) => entry[0] === 'connect')[1].should.deepEqual({ ip: '10.9.0.5', port: 41001 }); // the new port
            f.calls.filter((entry) => entry[0] === 'resume').should.have.length(2); // video and audio
            const patch = f.calls.find((entry) => entry[0] === 'patchShare' && entry[2].audio);
            patch[2].audio.should.containEql({ codec: 'audio/opus' });
            bridge.list().should.have.length(1);
            bridge.list()[0].hasAudio.should.be.true();
            bridge.getShare('video-1').closed.should.be.false(); // the old transport closing did not end the share
            await bridge.stop();
        });

        it('is not told about a share the recorder still knows', async () => {
            const f = fakes();
            const { bridge, advance } = await setup(f);
            advance(20000);
            f.calls.length = 0;

            await bridge.sample();
            await new Promise((resolve) => setImmediate(resolve));

            names(f.calls).should.not.containEql('registerShare');
            f.recorderRouter.transports.should.have.length(1);
            await bridge.stop();
        });

        it('does not mistake a share that was registered a moment ago for a forgotten one', async () => {
            const f = fakes();
            const { bridge, advance } = await setup(f);
            advance(3000); // the list of the recorder could have been made before the registration finished
            f.knows.length = 0;
            f.calls.length = 0;

            await bridge.sample();
            await new Promise((resolve) => setImmediate(resolve));

            names(f.calls).should.not.containEql('registerShare');
            await bridge.stop();
        });

        it('does not act on a recorder that does not answer the list', async () => {
            const f = fakes();
            const { bridge, advance } = await setup(f);
            advance(20000);
            f.client.listFails = true;
            f.knows.length = 0;
            f.calls.length = 0;

            await bridge.sample();
            await new Promise((resolve) => setImmediate(resolve));

            names(f.calls).should.not.containEql('registerShare');
            await bridge.stop();
        });

        it('connects a share again only once while the first attempt is under way', async () => {
            const f = fakes();
            const { bridge, advance } = await setup(f);
            advance(20000);
            f.knows.length = 0;
            f.calls.length = 0;

            await Promise.all([bridge.sample(), bridge.sample()]);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));

            names(f.calls).filter((name) => name === 'registerShare').should.have.length(1);
            await bridge.stop();
        });
    });

    it('stays off, quietly, when its worker dies', async () => {
        const f = fakes();
        const bridge = make(f);
        await bridge.start();
        await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'A', peerUuid: 'u1', producer: f.producer('video-1') });

        f.worker.died.emit('died');
        await new Promise((resolve) => setImmediate(resolve));

        bridge.available.should.be.false();
        bridge.reason.should.equal('worker');
        bridge.list().should.deepEqual([]);
        // and nothing new is started
        await bridge.addScreen({ roomId: 'link', router: f.roomRouter, peerName: 'A', peerUuid: 'u1', producer: f.producer('video-2') });
        bridge.list().should.deepEqual([]);
        await bridge.stop();
    });
});
