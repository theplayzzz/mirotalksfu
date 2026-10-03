'use strict';

require('should');

const guard = require('../public/js/SendGuard');
const { assess, initialState, step, rungKbps, LADDER, DOWN_BUSY_MS, DOWN_UPLINK_MS, COOLDOWN_MS, UP_AFTER_MS } = guard;

// What the sender guard decides for the senders of the room, with the numbers the health meter really reported on
// 03/10/2026 (a healthy sender, the owner's PC sharing the whole 2K screen while a game runs, and a sender on a weak uplink).
describe('test-SendGuard (what the sender does about its own screen)', () => {
    const healthy = { fps: 58.4, encMs: 6.7, srcFps: 60, lost: 0, rtt: 191, lim: 'none', limBwMs: 0, retx: 1, w: 1366, h: 768 };
    const slowPc = { fps: 15.8, encMs: 32.4, lost: 0, rtt: 212, lim: 'none', limBwMs: 0, retx: 0, w: 1920, h: 1080 }; // no capture figures yet
    const weakUplink = { fps: 42.7, encMs: 6.7, srcFps: 60, lost: 12.6, rtt: 985, lim: 'bandwidth', limBwMs: 5640, retx: 22, w: 1920, h: 1080 };
    const saturated = { fps: 40, encMs: 24, srcFps: 60, lost: 0, rtt: 200, lim: 'cpu', limBwMs: 0, retx: 0, w: 1920, h: 1080 };

    describe('what the numbers say', () => {
        it('a healthy sender is calm: nothing to do', () => {
            const a = assess(healthy);
            a.calm.should.be.true();
            a.capture.should.be.false();
            a.encoder.should.be.false();
            a.uplink.should.be.false();
        });

        it('the owner\'s 2K screen at 16 fps with the encoder half idle is the capture (or what feeds it), not the encoder', () => {
            const a = assess(slowPc); // 32 ms x 15.8 fps = 51% busy
            a.busy.should.be.approximately(0.51, 0.01);
            a.capture.should.be.true();
            a.encoder.should.be.false();
        });

        it('says the capture is slow when the source itself gives little while the encoder has time', () => {
            assess({ ...slowPc, srcFps: 16 }).capture.should.be.true();
            // the source gives 60 and the encoder only 15.8: frames are lost after the capture: the encoder side
            const a = assess({ ...slowPc, srcFps: 60 });
            a.capture.should.be.false();
            a.encoder.should.be.true();
        });

        it('says the encoder is saturated when it is busy nearly all the time', () => {
            const a = assess(saturated); // 24 ms x 40 fps = 96%
            a.encoder.should.be.true();
            a.capture.should.be.false();
        });

        it('says the uplink is bad for the sender with 12% loss, repeats and a 1 s round trip, and that is not the encoder', () => {
            const a = assess(weakUplink);
            a.uplink.should.be.true();
            a.encoder.should.be.false();
            a.calm.should.be.false();
        });

        it('knows when the browser itself says the estimate is the limit, without loss', () => {
            assess({ ...healthy, lim: 'bandwidth', limBwMs: 6000 }).bandwidth.should.be.true();
            assess({ ...healthy, lim: 'bandwidth', limBwMs: 500 }).bandwidth.should.be.false();
        });

        it('says nothing about a stream it has no numbers for', () => {
            assess(null).calm.should.be.false();
            assess({}).capture.should.be.false();
        });
    });

    describe('the ladder', () => {
        it('goes down in sizes that keep the shape: 1080p, 864p, 720p, 540p, 360p, each with a bitrate that fits it', () => {
            LADDER.map((r) => r.scale).should.deepEqual([1, 1.25, 1.5, 2, 3]);
            LADDER.map((r) => r.kbps).should.deepEqual([12000, 9000, 6500, 4000, 2200]);
        });

        it('gives a smaller capture a bitrate in proportion to its pixels, never below 1.5 Mbps', () => {
            rungKbps(0, 1920, 1080).should.equal(12000);
            rungKbps(0, 1280, 720).should.equal(5333); // a window of 720p
            rungKbps(4, 1280, 720).should.equal(1500);
            rungKbps(0, 0, 0).should.equal(12000); // size not known: as for a 1080p screen
        });
    });

    describe('what it does', () => {
        // Feeds one row every 2 s for `seconds`, returns the actions it took
        function run(state, row, from, seconds, size = { width: 1920, height: 1080 }) {
            const actions = [];
            for (let t = from; t < from + seconds * 1000; t += 2000) {
                const { action } = step(state, row, t, size);
                if (action) actions.push({ at: t, ...action });
            }
            return actions;
        }

        it('does nothing for a healthy sender, however long', () => {
            const state = initialState(0);
            run(state, healthy, 2000, 300).should.deepEqual([]);
            state.rung.should.equal(0);
        });

        it('does nothing about a slow capture: a smaller picture would not give frames the capture does not have', () => {
            const state = initialState(0);
            run(state, slowPc, 2000, 120).should.deepEqual([]);
            state.rung.should.equal(0);
            state.why.should.equal('capture');
        });

        it('lowers the picture one step after 6 s of a saturated encoder, and keeps the frame rate target', () => {
            const state = initialState(0);
            const actions = run(state, saturated, 2000, 30);
            actions.length.should.be.above(0);
            actions[0].should.containEql({ rung: 1, scale: 1.25, kbps: 9000, why: 'encoder' });
            actions[0].at.should.be.aboveOrEqual(2000 + DOWN_BUSY_MS - 2000);
        });

        it('lowers the picture of a sender with a weak uplink after 4 s, and the bitrate goes down with it', () => {
            const state = initialState(0);
            const actions = run(state, weakUplink, 2000, 20);
            actions[0].should.containEql({ rung: 1, why: 'uplink', kbps: 9000 });
            // not before the first 10 s of a share (its bandwidth estimate is still settling), and then at once
            actions[0].at.should.be.within(COOLDOWN_MS, COOLDOWN_MS + 2000);
        });

        it('waits 10 s between steps, so the numbers can show the effect of the last one', () => {
            const state = initialState(0);
            const actions = run(state, saturated, 2000, 60);
            for (let i = 1; i < actions.length; i++) (actions[i].at - actions[i - 1].at).should.be.aboveOrEqual(COOLDOWN_MS);
            state.rung.should.be.within(1, LADDER.length - 1);
        });

        it('never goes past the last step', () => {
            const state = initialState(0);
            run(state, saturated, 2000, 600);
            state.rung.should.equal(LADDER.length - 1);
        });

        it('goes back up one step after a long quiet stretch, only if the encoder has room at the bigger size', () => {
            const state = initialState(0);
            state.rung = 1;
            state.changedAt = 0;
            // calm and the encoder at 20% at the lower size: at the bigger one ~31%: room
            const roomy = { ...healthy, encMs: 3.4, fps: 59 };
            const actions = run(state, roomy, 2000, 70);
            actions.length.should.equal(1);
            actions[0].should.containEql({ rung: 0, why: 'room' });
            actions[0].at.should.be.aboveOrEqual(UP_AFTER_MS);
        });

        it('does not go up when the bigger size would need more than the encoder has', () => {
            const state = initialState(0);
            state.rung = 1;
            // 55% busy now at 864p: at 1080p it would be 86%
            const tight = { ...healthy, encMs: 9.3, fps: 59, srcFps: 60 };
            run(state, tight, 2000, 200).should.deepEqual([]);
            state.rung.should.equal(1);
        });

        it('doubles the wait for the next rise when a rise had to be taken back at once', () => {
            const state = initialState(0);
            state.rung = 1;
            state.changedAt = 0;
            const roomy = { ...healthy, encMs: 3.4, fps: 59 };
            const up = run(state, roomy, 2000, 60);
            up.length.should.equal(1);
            // the encoder saturates right after the rise
            const down = run(state, saturated, up[0].at + 2000, 40);
            down[0].should.containEql({ rung: 1 });
            state.upAfterMs.should.equal(UP_AFTER_MS * 2);
        });
    });
});
