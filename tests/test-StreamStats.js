'use strict';

require('should');

const { senderRow, receiverRow, encoderBusy, delta } = require('../public/js/StreamStats');

// The arithmetic the health meter and the sender guard share: two samples of the browser's statistics in, the numbers of
// the last seconds out.
describe('test-StreamStats', () => {
    const before = {
        timestamp: 1000, framesEncoded: 1000, bytesSent: 10_000_000, packetsSent: 9000, totalEncodeTime: 8.0, keyFramesEncoded: 4, pliCount: 2, nackCount: 10,
        retransmittedBytesSent: 100_000, hugeFramesSent: 3, qualityLimitationResolutionChanges: 1, totalPacketSendDelay: 20,
        qualityLimitationDurations: { cpu: 1, bandwidth: 2, other: 0, none: 40 },
    };
    const after = {
        ...before, timestamp: 11_000, framesEncoded: 1158, bytesSent: 16_000_000, packetsSent: 14_400, totalEncodeTime: 13.12, keyFramesEncoded: 5, pliCount: 5, nackCount: 40,
        retransmittedBytesSent: 1_060_000, hugeFramesSent: 4, qualityLimitationResolutionChanges: 3, totalPacketSendDelay: 44.3,
        qualityLimitationDurations: { cpu: 1, bandwidth: 8.4, other: 0, none: 43.6 },
        frameWidth: 1920, frameHeight: 1080, targetBitrate: 5_700_000, qualityLimitationReason: 'bandwidth', encoderImplementation: 'libvpx', powerEfficientEncoder: false,
    };
    const sourceBefore = { timestamp: 1000, frames: 2000 };
    const source = { timestamp: 11_000, frames: 2160, width: 2560, height: 1440 };
    const remote = { roundTripTime: 0.985, fractionLost: 0.126 };
    const settings = { width: 1920, height: 1080, frameRate: 60 };
    const parameters = { encodings: [{ scaleResolutionDownBy: 1.25, maxBitrate: 9_000_000, maxFramerate: 60 }], degradationPreference: 'maintain-framerate' };

    describe('a stream this browser sends', () => {
        const row = senderRow({ s: after, before, source, sourceBefore, remote, settings, parameters, hint: 'motion', mime: 'video/VP8' });

        it('says how many frames the encoder made and how long each took', () => {
            row.fps.should.equal(15.8);
            row.encMs.should.equal(32.41); // 5.12 s of encoding for 158 frames
            row.w.should.equal(1920);
            row.h.should.equal(1080);
        });

        it('says how many frames the CAPTURE gave and at what size (a 2K screen scaled to 1080p): what tells a slow capture from a slow encoder', () => {
            row.srcFps.should.equal(16);
            row.srcW.should.equal(2560);
            row.srcH.should.equal(1440);
            row.setW.should.equal(1920);
            row.setFps.should.equal(60);
        });

        it('says what is captured: the whole screen, a window or a tab (they cost the browser very different amounts)', () => {
            (row.surf === undefined).should.be.true(); // these settings do not say
            senderRow({ s: after, before, settings: { ...settings, displaySurface: 'window' } }).surf.should.equal('window');
            senderRow({ s: after, before, settings: { ...settings, displaySurface: 'monitor' } }).surf.should.equal('monitor');
            (senderRow({ s: after, before, settings: { ...settings, displaySurface: 'something else' } }).surf === undefined).should.be.true();
        });

        it('says what the encoder was told, by whom, and the content hint and the codec', () => {
            row.scale.should.equal(1.25);
            row.maxKbps.should.equal(9000);
            row.maxFps.should.equal(60);
            row.degr.should.equal('maintain-framerate');
            row.hint.should.equal('motion');
            row.codec.should.equal('VP8');
        });

        it('says what the line costs: the share that was a repeat, the loss and the round trip the server reports, how long the browser was limited', () => {
            row.retx.should.equal(16); // 960 kB of 6 MB
            row.lost.should.equal(12.6);
            row.rtt.should.equal(985);
            row.lim.should.equal('bandwidth');
            row.limBwMs.should.equal(6400);
            row.limCpuMs.should.equal(0);
            row.qlr.should.equal(2);
            row.huge.should.equal(1);
            row.sendMs.should.equal(4.5);
            row.kbps.should.equal(4800);
        });

        it('has no row for a first sample, or when time did not pass, and no figure for what the browser does not report', () => {
            (senderRow({ s: after, before: null }) === null).should.be.true();
            (senderRow({ s: { ...after, timestamp: before.timestamp }, before }) === null).should.be.true();
            const bare = senderRow({ s: after, before });
            (bare.srcFps === undefined).should.be.true();
            bare.hint.should.equal('none');
            (bare.scale === undefined).should.be.true();
        });

        it('knows how busy the encoder is: milliseconds per frame times frames per second', () => {
            encoderBusy(row).should.be.approximately(0.512, 0.001);
            encoderBusy(null).should.equal(0);
            encoderBusy({ encMs: 7, fps: 0 }).should.equal(0);
        });
    });

    describe('a stream this browser receives', () => {
        const rbefore = { timestamp: 0, framesDecoded: 100, framesDropped: 4, bytesReceived: 1_000_000, packetsReceived: 800, packetsLost: 2, freezeCount: 1, totalFreezesDuration: 0.5, keyFramesDecoded: 1, pliCount: 0, nackCount: 5, jitterBufferDelay: 3, jitterBufferEmittedCount: 100, totalDecodeTime: 1.2, pauseCount: 0 };
        const rafter = { ...rbefore, timestamp: 10_000, framesDecoded: 400, framesDropped: 34, bytesReceived: 3_500_000, packetsReceived: 2800, packetsLost: 200, freezeCount: 4, totalFreezesDuration: 3.5, nackCount: 105, jitterBufferDelay: 33, jitterBufferEmittedCount: 400, totalDecodeTime: 4.2, pauseCount: 1, frameWidth: 1920, frameHeight: 1080, decoderImplementation: 'libvpx', powerEfficientDecoder: false };
        const row = receiverRow({ s: rafter, before: rbefore });

        it('says the frame rate, the loss, the freezes and what was dropped before it was shown', () => {
            row.fps.should.equal(30);
            row.loss.should.equal(9.01); // 198 lost of 2198
            row.frz.should.equal(3);
            row.frzMs.should.equal(3000);
            row.drop.should.equal(30);
            row.nack.should.equal(100);
            row.jbMs.should.equal(100);
            row.seconds.should.equal(10);
        });

        it('says how long the decoder takes per frame, whether it is a hardware decoder, and the pauses the browser made', () => {
            row.decMs.should.equal(10); // 3 s of decoding for 300 frames
            row.dec.should.equal('libvpx');
            row.hw.should.be.false();
            row.pause.should.equal(1);
        });

        it('has no row for a first sample', () => {
            (receiverRow({ s: rafter, before: null }) === null).should.be.true();
        });
    });

    it('a counter that restarts (a stream that restarted) gives zero, never a negative number', () => {
        delta({ a: 5 }, { a: 100 }, 'a').should.equal(0);
        delta({ a: 5 }, undefined, 'a').should.equal(5);
        delta(undefined, undefined, 'a').should.equal(0);
    });
});
