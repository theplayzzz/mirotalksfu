'use strict';

require('should');

const { ClockMap } = require('../../app/src/replay/ClockMap');

const T0 = 1791036902000; // some wall clock time in ms

describe('replay: ClockMap (RTP timestamp to wall clock)', () => {
    it('maps with one Sender Report: wall = NTP + (rtp - rtpAtReport) / rate', () => {
        const clock = new ClockMap({ clockRate: 90000 });
        clock.ready.should.be.false();
        clock.observeSenderReport(1000000, T0, T0).should.be.true();
        clock.ready.should.be.true();
        clock.mode.should.equal('sr');
        clock.toWallMs(1000000, T0).should.be.approximately(T0, 1e-6);
        clock.toWallMs(1000000 + 90000, T0).should.be.approximately(T0 + 1000, 1e-6);
        clock.toWallMs(1000000 - 4500, T0).should.be.approximately(T0 - 50, 1e-6);
    });

    it('puts audio and video of the same instant on the same time', () => {
        const video = new ClockMap({ clockRate: 90000 });
        const audio = new ClockMap({ clockRate: 48000 });
        // Both reports describe the same wall instant, with unrelated RTP timestamp bases.
        video.observeSenderReport(3000000000, T0 + 500, T0 + 500);
        audio.observeSenderReport(777000, T0 + 500, T0 + 500);
        // The event "T0 + 1500" is at 90 kHz and 48 kHz ticks from the respective reports:
        const v = video.toWallMs(3000000000 + 90000, T0 + 1500);
        const a = audio.toWallMs(777000 + 48000, T0 + 1500);
        Math.abs(v - a).should.be.below(0.001);
        v.should.be.approximately(T0 + 1500, 1e-6);
    });

    it('works with unwrapped timestamps beyond 2^32', () => {
        const clock = new ClockMap({ clockRate: 90000 });
        const base = 4294967296 * 3 + 12345;
        clock.observeSenderReport(base, T0, T0);
        clock.toWallMs(base + 900, T0).should.be.approximately(T0 + 10, 1e-6);
    });

    it('takes the minimum offset of the recent reports, which drops the jittery ones', () => {
        const clock = new ClockMap({ clockRate: 90000, srWindow: 4, maxSlew: 1 });
        // The report of each second says the stream was at rtp = 90000 * s. A late packet makes its report
        // look 40 ms or 15 ms later on the wall clock; the true mapping is the smallest offset.
        const jitter = [40, 0, 15, 30, 25, 20];
        jitter.forEach((j, s) => clock.observeSenderReport(90000 * s, T0 + s * 1000 + j, T0 + s * 1000 + j));
        // Window of the last four: jitters 15, 30, 25, 20 -> offset +15
        clock.toWallMs(90000 * 6, T0 + 6000).should.be.approximately(T0 + 6000 + 15, 1e-6);
    });

    it('changes the offset slowly, so timestamps of one stream never run backwards', () => {
        const clock = new ClockMap({ clockRate: 48000, maxSlew: 0.02, srWindow: 1 });
        clock.observeSenderReport(0, T0 + 100, T0 + 100); // offset +100
        let now = T0 + 100;
        let rtp = 0;
        let last = clock.toWallMs(rtp, now);
        clock.observeSenderReport(48000, T0 + 1000, T0 + 1000); // the estimate drops by 100 ms
        for (let i = 0; i < 200; i++) {
            now += 20;
            rtp += 960;
            const ts = clock.toWallMs(rtp, now);
            ts.should.be.greaterThan(last, `frame ${i}`);
            last = ts;
        }
        // after 4 s of frames the offset moved 4 s * 20 ms/s = 80 ms toward the new estimate
        const drift = last - (T0 + 100 + 200 * 20); // ideal: the old offset, no change
        drift.should.be.approximately(-80, 1);
    });

    it('lands on the estimate once it has slewed all the way', () => {
        const clock = new ClockMap({ clockRate: 90000, maxSlew: 0.5, srWindow: 1 });
        clock.observeSenderReport(0, T0 + 50, T0 + 50);
        clock.toWallMs(0, T0);
        clock.observeSenderReport(90000, T0 + 1000, T0 + 1000);
        clock.toWallMs(90000, T0 + 1000);
        clock.toWallMs(90000 * 3, T0 + 3000).should.be.approximately(T0 + 3000, 1e-6);
    });

    it('refuses reports whose clock is nowhere near the local clock, or without a time', () => {
        const clock = new ClockMap({ clockRate: 90000 });
        clock.observeSenderReport(0, T0 + 30 * 24 * 3600 * 1000, T0).should.be.false();
        clock.observeSenderReport(0, null, T0).should.be.false();
        clock.observeSenderReport(0, NaN, T0).should.be.false();
        clock.ready.should.be.false();
        clock.srRejected.should.equal(3);
    });

    it('falls back to arrival times: the minimum of (arrival - rtp time) over a window', () => {
        const clock = new ClockMap({ clockRate: 90000, arrivalWindowMs: 2000 });
        clock.useArrival().should.be.false(); // nothing to go on yet
        // frame i is at rtp 3000 * i (33.3 ms) and arrives with some delay
        const delays = [30, 12, 40, 5, 22, 9, 60, 18];
        delays.forEach((d, i) => clock.observeArrival(3000 * i, T0 + (i * 1000) / 30 + d));
        clock.useArrival().should.be.true();
        clock.mode.should.equal('arrival');
        // the least delayed frame (5 ms) defines the mapping
        clock.toWallMs(0, T0).should.be.approximately(T0 + 5, 1e-6);
    });

    it('forgets old arrival samples (the window slides)', () => {
        const clock = new ClockMap({ clockRate: 90000, arrivalWindowMs: 1000 });
        clock.observeArrival(0, T0 + 2); // very early sample
        for (let i = 1; i <= 200; i++) clock.observeArrival(i * 3000, T0 + (i * 1000) / 30 + 25);
        clock.useArrival();
        clock.toWallMs(0, T0 + 6000).should.be.approximately(T0 + 25, 1e-6);
    });

    it('prefers Sender Reports once it has one, even after using arrival times', () => {
        const clock = new ClockMap({ clockRate: 90000, maxSlew: 1 });
        clock.observeArrival(0, T0 + 30);
        clock.useArrival();
        clock.mode.should.equal('arrival');
        clock.observeSenderReport(0, T0 + 10, T0 + 10);
        clock.mode.should.equal('sr');
        clock.toWallMs(0, T0 + 5000).should.be.approximately(T0 + 10, 1e-6);
    });
});
