'use strict';

require('should');

const fs = require('node:fs');
const path = require('node:path');
const { recorderCapabilities } = require('../../app/src/replay/ReplayBridge');

// These tests use the real mediasoup, so they need its worker binary: it is in the Docker image and wherever the
// package was installed with its build scripts. Without it (npm ci --ignore-scripts) they are skipped, not failed.
function workerBinary() {
    if (process.env.MEDIASOUP_WORKER_BIN) return process.env.MEDIASOUP_WORKER_BIN;
    const release = path.join(__dirname, '../../node_modules/mediasoup/worker/out/Release');
    for (const name of ['mediasoup-worker', 'mediasoup-worker.exe']) {
        if (fs.existsSync(path.join(release, name))) return path.join(release, name);
    }
    return null;
}

(workerBinary() ? describe : describe.skip)('test-sfu-mediasoup (the real mediasoup)', function () {
    this.timeout(30000);
    const mediasoup = require('mediasoup');
    let worker;
    let router;
    let producer;
    let source;

    before(async () => {
        worker = await mediasoup.createWorker({ logLevel: 'warn' });
        router = await worker.createRouter({
            mediaCodecs: [
                { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
                { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
            ],
        });
        // a screen as the room's senders make it: VP8 with three frame-rate layers, asking for bandwidth estimation
        source = await router.createPlainTransport({ listenInfo: { protocol: 'udp', ip: '127.0.0.1' }, rtcpMux: true, comedia: true });
        producer = await source.produce({
            kind: 'video',
            rtpParameters: {
                codecs: [
                    {
                        mimeType: 'video/VP8',
                        payloadType: 96,
                        clockRate: 90000,
                        parameters: {},
                        rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'goog-remb' }, { type: 'transport-cc' }],
                    },
                ],
                headerExtensions: [{ uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', id: 5 }],
                encodings: [{ ssrc: 111111, scalabilityMode: 'L1T3' }],
            },
        });
    });

    after(() => {
        worker?.close();
    });

    async function consumeWith(capabilities) {
        const transport = await router.createPlainTransport({ listenInfo: { protocol: 'udp', ip: '127.0.0.1' }, rtcpMux: true, comedia: false });
        await transport.connect({ ip: '127.0.0.1', port: 9 });
        const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: capabilities, paused: true });
        const [stats] = await transport.getStats();
        transport.close();
        return { consumer, stats };
    }

    // This is what happened to the recorder: with the router's own capabilities mediasoup believes the consumer takes
    // part in bandwidth estimation, starts the transport at an estimate of 600 kbps that nothing ever raises (the
    // recorder sends no feedback) and throttles the consumer to it, so a screen with motion (5-12 Mbps) reached the
    // recorder for a few seconds and then only as probing packets.
    it('gives a plain consumer a bandwidth estimate of 600 kbps when it is made with the router\'s capabilities', async () => {
        const { consumer, stats } = await consumeWith(router.rtpCapabilities);
        consumer.rtpParameters.codecs[0].rtcpFeedback.map((feedback) => feedback.type).should.containEql('transport-cc');
        stats.availableOutgoingBitrate.should.equal(600000);
    });

    it('gives it none when it is made with the recorder\'s capabilities', async () => {
        const { consumer, stats } = await consumeWith(recorderCapabilities(router.rtpCapabilities));
        consumer.rtpParameters.codecs[0].rtcpFeedback.map((feedback) => feedback.type).should.deepEqual(['nack', 'nack', 'ccm']);
        consumer.rtpParameters.headerExtensions.should.deepEqual([]);
        (stats.availableOutgoingBitrate === undefined).should.be.true();
    });

    it('still receives a consumer for a screen with sound: the audio is made the same way', async () => {
        const audioSource = await router.createPlainTransport({ listenInfo: { protocol: 'udp', ip: '127.0.0.1' }, rtcpMux: true, comedia: true });
        const audio = await audioSource.produce({
            kind: 'audio',
            rtpParameters: {
                codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [{ type: 'transport-cc' }] }],
                headerExtensions: [{ uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', id: 5 }],
                encodings: [{ ssrc: 222222 }],
            },
        });
        const transport = await router.createPlainTransport({ listenInfo: { protocol: 'udp', ip: '127.0.0.1' }, rtcpMux: true, comedia: false });
        await transport.connect({ ip: '127.0.0.1', port: 9 });
        const consumer = await transport.consume({ producerId: audio.id, rtpCapabilities: recorderCapabilities(router.rtpCapabilities), paused: true });
        const [stats] = await transport.getStats();
        consumer.rtpParameters.codecs[0].mimeType.should.equal('audio/opus');
        consumer.rtpParameters.encodings[0].ssrc.should.be.a.Number();
        (stats.availableOutgoingBitrate === undefined).should.be.true();
        transport.close();
        audioSource.close();
    });
});
