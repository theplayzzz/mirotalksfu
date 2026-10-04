'use strict';

require('should');

const guard = require('../public/js/SendGuard');
const { assess, isHardware, capacityKbps, captureSize, captureFailed, initialState, step, rungKbps, LADDER, CAPTURE_SCALES, MOVING_KBPS, CAPTURE_EVAL_MS, CAPTURE_BLOCK_MS, CAPTURE_UP_AFTER_MS, DOWN_BUSY_MS, DOWN_UPLINK_MS, COOLDOWN_MS, UP_AFTER_MS } = guard;

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
            assess({ ...healthy, lim: 'bandwidth', limBwMs: 1600 }).bandwidth.should.be.true(); // 80% of a 2 s sample
            assess({ ...healthy, lim: 'bandwidth', limBwMs: 500 }).bandwidth.should.be.false();
        });

        it('does not take the first seconds of a share (the bitrate estimate growing) for a saturated encoder', () => {
            // 31 fps of the 60 the capture gives, a quarter of the encoder busy, the target at 4.9 Mbps of a 12 Mbps ceiling
            const ramp = { fps: 31, srcFps: 60, encMs: 3.4, kbps: 2900, tgtKbps: 4900, maxKbps: 12000, lim: 'bandwidth', limBwMs: 2000, lost: 0, rtt: 200, retx: 0 };
            const a = assess(ramp);
            a.encoder.should.be.false();
            a.capture.should.be.false(); // the source gives 60
            a.bandwidth.should.be.true();
            // the same frames lost with the browser saying nothing about the bitrate: the encoder
            assess({ ...ramp, lim: 'none', limBwMs: 0 }).encoder.should.be.true();
        });

        it('does count frames lost at the ceiling the guard set: a picture that needs more bits than it may have', () => {
            // a hardware encoder at 11.9 Mbps of a 12 Mbps ceiling, 43 of the 60 frames come out
            const capped = { fps: 43, srcFps: 60, encMs: 9, hw: true, enc: 'MediaFoundationVideoEncodeAccelerator', kbps: 11800, tgtKbps: 11940, maxKbps: 12000, lim: 'bandwidth', limBwMs: 2000, lost: 0, rtt: 190, retx: 0 };
            assess(capped).encoder.should.be.true();
        });

        it('says nothing about a stream it has no numbers for', () => {
            assess(null).calm.should.be.false();
            assess({}).capture.should.be.false();
        });

        it('does not read the time per frame of a hardware encoder as a load: it is the delay of the pipeline', () => {
            const hardware = { fps: 59, encMs: 15, srcFps: 60, lost: 0, rtt: 100, lim: 'none', retx: 0, hw: true, enc: 'ExternalEncoder' };
            const a = assess(hardware); // 15 ms x 59 fps would be 89% busy for a software encoder
            a.hardware.should.be.true();
            a.busy.should.equal(0);
            a.encoder.should.be.false();
            a.calm.should.be.true();
            assess({ ...hardware, hw: false, enc: 'libvpx' }).encoder.should.be.true();
            // frames that never come out of a hardware encoder still count, and so does the browser blaming the processor
            assess({ ...hardware, fps: 30 }).encoder.should.be.true();
            assess({ ...hardware, limCpuMs: 1500 }).encoder.should.be.true();
        });

        it('knows a hardware encoder by its own word, and by its name when the browser does not say', () => {
            isHardware({ hw: true }).should.be.true();
            isHardware({ hw: false, enc: 'ExternalEncoder' }).should.be.false();
            isHardware({ enc: 'ExternalEncoder' }).should.be.true();
            isHardware({ enc: 'D3D11VideoEncoder' }).should.be.true();
            isHardware({ enc: 'libvpx, fallback from D3D11VideoEncoder' }).should.be.false();
            isHardware({ enc: 'libvpx' }).should.be.false();
            isHardware({ enc: 'OpenH264' }).should.be.false();
            isHardware({}).should.be.false();
            isHardware(null).should.be.false();
        });

        it('sees what a line carries: what was sent minus what was lost', () => {
            capacityKbps({ kbps: 7000, lost: 20 }).should.equal(5600);
            capacityKbps({ kbps: 7000 }).should.equal(7000);
            capacityKbps({ kbps: 0, lost: 5 }).should.equal(0);
            capacityKbps(null).should.equal(0);
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

        it('does nothing about a slow capture when it does not know the capture rate: a smaller picture would not give frames the capture does not have', () => {
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

        it('goes straight to the rung a weak line can carry, not one rung at a time', () => {
            // 7 Mbps sent, 20% lost: the line carries about 5.6 Mbps, a rung may ask for 80% of it: 4.0 Mbps (540p)
            const line = { fps: 40, kbps: 7000, lost: 20, retx: 23, rtt: 600, lim: 'bandwidth', limBwMs: 2000, srcFps: 60, encMs: 5 };
            const state = initialState(0);
            const actions = run(state, line, 2000, 20);
            actions[0].should.containEql({ rung: 3, scale: 2, kbps: 4000, why: 'uplink' });
            // a smaller capture needs less: a 720p window on the same line only goes one rung down
            const window = initialState(0);
            run(window, line, 2000, 20, { width: 1280, height: 720 })[0].should.containEql({ rung: 1, why: 'uplink' });
            // and a line that carries almost nothing goes to the last rung, never past it
            const nothing = initialState(0);
            run(nothing, { ...line, kbps: 1200, lost: 40 }, 2000, 20)[0].rung.should.equal(LADDER.length - 1);
        });

        it('does not go back up to a rung the line is known not to carry, for 30 minutes', () => {
            const line = { fps: 40, kbps: 7000, lost: 20, retx: 23, rtt: 600, lim: 'bandwidth', limBwMs: 2000, srcFps: 60, encMs: 5 };
            const state = initialState(0);
            run(state, line, 2000, 12)[0].should.containEql({ rung: 3, kbps: 4000 }); // the line carries ~5.6 Mbps
            state.lineKbps.should.equal(5600);
            // the picture is fine now (4 Mbps), and calm for a very long time: the next rung (6.5 Mbps) is more than the line carried
            const calmAt4 = { fps: 59.5, kbps: 4000, lost: 0, rtt: 200, lim: 'none', limBwMs: 0, srcFps: 60, encMs: 3, retx: 0 };
            run(state, calmAt4, 22000, 1500).should.deepEqual([]);
            state.rung.should.equal(3);
            // after 30 minutes the memory is gone and one rise is tried
            const later = run(state, calmAt4, 22000 + 1500000, 400);
            later[0].should.containEql({ rung: 2, why: 'room' });
        });

        it('goes back up as before when it did not come down because of the line', () => {
            const state = initialState(0);
            state.rung = 1;
            state.changedAt = 0;
            state.lineKbps = 0;
            const roomy = { ...healthy, encMs: 3.4, fps: 59 };
            run(state, roomy, 2000, 70)[0].should.containEql({ rung: 0, why: 'room' });
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
    describe('the capture ladder (a slow capture is tried at a smaller size, and taken back if it does not help)', () => {
        const base = { width: 1920, height: 1080 };
        const slow = (srcFps) => ({ fps: srcFps, srcFps, encMs: 6, kbps: 8000, lost: 0, rtt: 150, lim: 'none', limBwMs: 0, retx: 0 });
        const calm = { fps: 59.5, srcFps: 59.8, encMs: 5, kbps: 9000, lost: 0, rtt: 150, lim: 'none', limBwMs: 0, retx: 0 };

        // One row every 2 s from `from` for `seconds`; `rows(t)` gives the row for the moment t
        function runWith(state, rows, from, seconds, options = {}, size = base) {
            const actions = [];
            for (let t = from; t < from + seconds * 1000; t += 2000) {
                const { action } = step(state, typeof rows === 'function' ? rows(t) : rows, t, size, options);
                if (action) actions.push({ at: t, ...action });
            }
            return actions;
        }

        it('asks the capture for 80% of its size after 8 s of a slow capture of a moving picture, and leaves the bitrate ceiling alone', () => {
            const state = initialState(0);
            const actions = runWith(state, slow(32), 2000, 12); // the trial starts at 10 s and has not ended yet
            actions[0].should.containEql({ kind: 'capture', capRung: 1, width: 1536, height: 864, why: 'capture' });
            (actions[0].kbps === undefined).should.be.true();
            actions[0].at.should.be.within(10000, 12000);
            state.capTrial.should.containEql({ from: 0, to: 1, before: 32 });
        });

        it('knows the sizes of the capture ladder: 100%, 80%, 67%, 50% of the size it started at, in even numbers', () => {
            CAPTURE_SCALES.should.deepEqual([1, 1.25, 1.5, 2]);
            [0, 1, 2, 3].map((rung) => captureSize(base, rung)).should.deepEqual([
                { width: 1920, height: 1080 },
                { width: 1536, height: 864 },
                { width: 1280, height: 720 },
                { width: 960, height: 540 },
            ]);
            captureSize({ width: 1366, height: 768 }, 1).should.deepEqual({ width: 1092, height: 614 });
        });

        it('keeps a smaller capture that gives at least 20% more frames', () => {
            const state = initialState(0);
            // the capture gives 32 fps until the smaller size is asked for (at 10 s), 57 after it
            const first = runWith(state, (t) => slow(t <= 10000 ? 32 : 57), 2000, 40);
            first.length.should.equal(1); // only the trial: no verdict that undoes it
            state.capRung.should.equal(1);
            (state.capTrial === null).should.be.true();
            state.why.should.not.equal('capture-undo');
        });

        it('takes a smaller capture back when it does not give more frames, and leaves that size alone for 5 minutes', () => {
            const state = initialState(0);
            const actions = runWith(state, slow(31), 2000, 60);
            actions.length.should.equal(2);
            actions[0].should.containEql({ kind: 'capture', capRung: 1 });
            actions[1].should.containEql({ kind: 'capture', capRung: 0, width: 1920, height: 1080, why: 'capture-undo' });
            (actions[1].at - actions[0].at).should.be.within(CAPTURE_EVAL_MS, CAPTURE_EVAL_MS + 2000);
            state.capRung.should.equal(0);
            state.capFails.should.equal(1);
            // five minutes of the same slow capture: no new try before the block ends
            const later = runWith(state, slow(31), 62000, 230);
            later.should.deepEqual([]);
            // and then it tries again
            const again = runWith(state, slow(31), 292000, 40);
            again[0].should.containEql({ kind: 'capture', capRung: 1 });
        });

        it('waits twice as long after a second failure, up to an hour', () => {
            const state = initialState(0);
            runWith(state, slow(31), 2000, 60); // try, undo (block 5 min)
            runWith(state, slow(31), 62000, 260); // nothing
            const retry = runWith(state, slow(31), 322000, 60); // try again at ~5 min after the first undo, and undo
            retry.map((a) => a.why).should.deepEqual(['capture', 'capture-undo']);
            state.capFails.should.equal(2);
            // now the block is 10 minutes (from the second undo, at about 333 s)
            runWith(state, slow(31), 382000, 540).should.deepEqual([]);
            runWith(state, slow(31), 922000, 40)[0].should.containEql({ kind: 'capture', capRung: 1 });
            CAPTURE_BLOCK_MS.should.equal(300000);
        });

        it('never touches the size of a screen that hardly moves (few frames is the content, not the capture): only its bitrate ceiling goes down, once', () => {
            const still = { fps: 3, srcFps: 3, encMs: 2, kbps: 300, lost: 0, rtt: 150, lim: 'none', limBwMs: 0, retx: 0 };
            assess(still).capture.should.be.false();
            assess(still).still.should.be.true();
            const actions = runWith(initialState(0), still, 2000, 600);
            actions.should.have.length(1);
            actions[0].should.containEql({ kind: 'cap', kbps: 1500, why: 'still' });
            actions[0].at.should.be.within(6000, 10000);
            // between a still screen and a moving one: few bits are the content for a software encoder, many bits are a moving picture
            assess({ ...still, srcFps: 12, fps: 12, kbps: 300 }).capture.should.be.false();
            assess({ ...still, srcFps: 12, fps: 12, kbps: MOVING_KBPS }).capture.should.be.true();
        });

        it('knows a still screen sent by a hardware encoder, whatever bits it spends on it (7.7 Mbps for a frame a second)', () => {
            const hardwareStill = { fps: 1, srcFps: 1, encMs: 9.7, kbps: 7700, hw: true, enc: 'MediaFoundationVideoEncodeAccelerator', lost: 0, rtt: 150, lim: 'none', limBwMs: 0, retx: 0 };
            const a = assess(hardwareStill);
            a.still.should.be.true();
            a.capture.should.be.false(); // not "a slow capture": no capture trial, no notice
            const state = initialState(0);
            const actions = runWith(state, hardwareStill, 2000, 300);
            actions.map((x) => x.kind + ':' + x.why).should.deepEqual(['cap:still']);
            state.rung.should.equal(0);
            state.capRung.should.equal(0);
        });

        it('gives the ceiling of the ladder back when the screen moves again (10+ frames a second for 4 s), not before', () => {
            const still = { fps: 1, srcFps: 1, encMs: 2, kbps: 100, lost: 0, rtt: 150, lim: 'none', limBwMs: 0, retx: 0 };
            const state = initialState(0);
            runWith(state, still, 2000, 20).should.have.length(1);
            state.stillCapped.should.be.true();
            // 8 frames a second is not enough to be called moving
            runWith(state, { ...calm, fps: 8, srcFps: 8, kbps: 800 }, 22000, 30).filter((x) => x.kind === 'cap').should.deepEqual([]);
            state.stillCapped.should.be.true();
            const back = runWith(state, calm, 52000, 20).filter((x) => x.kind === 'cap');
            back.should.have.length(1);
            back[0].should.containEql({ kind: 'cap', kbps: 12000, why: 'moving' });
            back[0].at.should.be.within(56000, 60000);
            state.stillCapped.should.be.false();
        });

        it('keeps the ceiling of a still screen when the ladder acts, and does nothing of it when only observing', () => {
            const state = initialState(0);
            state.stillCapped = true;
            // 8 frames a second (neither still nor moving) out of an encoder that is busy all the time
            const slowAndBusy = { fps: 8, encMs: 115, srcFps: 8, kbps: 3000, lost: 0, rtt: 200, lim: 'none', limBwMs: 0, retx: 0 };
            const actions = runWith(state, slowAndBusy, 2000, 30).filter((x) => x.kind === 'ladder');
            actions[0].kbps.should.equal(1500);
            const stillRow = { fps: 1, srcFps: 1, encMs: 2, kbps: 100, lost: 0, rtt: 150, lim: 'none', limBwMs: 0, retx: 0 };
            runWith(initialState(0), stillRow, 2000, 120, { trials: false }).should.deepEqual([]);
        });

        it('does not try anything in observe mode (the capture is not changed, so a trial would mean nothing)', () => {
            const state = initialState(0);
            runWith(state, slow(32), 2000, 120, { trials: false }).should.deepEqual([]);
            state.why.should.equal('capture');
        });

        it('does not go below the last size of the ladder', () => {
            const state = initialState(0);
            // every trial "helps": the capture gets a little faster each time but never reaches 60
            let fps = 24;
            const actions = [];
            for (let t = 2000; t < 400000; t += 2000) {
                const { action } = step(state, slow(fps), t, base);
                if (action && action.kind === 'capture') {
                    actions.push(action);
                    fps = Math.min(50, fps * 1.4);
                }
            }
            state.capRung.should.be.belowOrEqual(CAPTURE_SCALES.length - 1);
            actions.every((a) => a.capRung <= CAPTURE_SCALES.length - 1).should.be.true();
            actions.map((a) => a.capRung).should.containEql(3);
        });

        it('tries the bigger capture again after 3 minutes of calm, keeps it if it holds 60 fps, takes it back if not', () => {
            const kept = initialState(0);
            kept.base = base;
            kept.capRung = 1;
            const tryUp = runWith(kept, calm, 2000, CAPTURE_UP_AFTER_MS / 1000 + 20, {}, { width: 1536, height: 864 });
            tryUp[0].should.containEql({ kind: 'capture', capRung: 0, width: 1920, height: 1080, why: 'capture-up-try' });
            tryUp.length.should.equal(1);
            (kept.capTrial === null || kept.capTrial.up === true).should.be.true();
            // the same try, but the bigger capture is slow again: taken back, and blocked
            const undone = initialState(0);
            undone.base = base;
            undone.capRung = 1;
            let tried = null;
            const seen = [];
            for (let t = 2000; t < CAPTURE_UP_AFTER_MS + 60000; t += 2000) {
                // the bigger capture is slow again from the moment it is asked for until it is taken back
                const row = tried !== null && t >= tried && t < tried + CAPTURE_EVAL_MS + 1000 ? slow(35) : calm;
                const { action } = step(undone, row, t, { width: 1536, height: 864 });
                if (action) {
                    seen.push(action.why);
                    if (action.why === 'capture-up-try') tried = t;
                }
            }
            seen.should.deepEqual(['capture-up-try', 'capture-undo']);
            undone.capRung.should.equal(1);
        });

        it('tells the sender once, after 90 s, when the capture stays slow and there is nothing left to try', () => {
            const state = initialState(0);
            // every size is tried and does not help: the capture is 30 fps whatever the size (4 sizes, 3 trials, blocks growing)
            let tips = [];
            for (let t = 2000; t < 1500000; t += 2000) {
                const { action } = step(state, slow(33), t, base);
                if (action && action.kind === 'tip') tips.push({ at: t, ...action });
            }
            tips.length.should.equal(1);
            tips[0].should.containEql({ kind: 'tip', cause: 'capture', fps: 33 });
            // it did not come before the first try had its verdict: blocked sizes, 90 s of slowness
            tips[0].at.should.be.aboveOrEqual(90000);
        });

        it('does not tell a sender whose capture is fine, whose screen hardly moves, or when only observing', () => {
            const none = [];
            const still = { fps: 3, srcFps: 3, encMs: 2, kbps: 300, lost: 0, rtt: 150, lim: 'none', limBwMs: 0, retx: 0 };
            // (a capture of 24, 25 or 30 fps is most likely a film: no tip either)
            for (const [rows, options] of [[calm, {}], [still, {}], [slow(33), { trials: false }], [slow(30), {}], [slow(24.5), {}]]) {
                const state = initialState(0);
                for (let t = 2000; t < 1500000; t += 2000) {
                    const { action } = step(state, rows, t, base, options);
                    if (action && action.kind === 'tip') none.push(action);
                }
            }
            none.should.deepEqual([]);
        });

        it('forgets a trial the browser could not carry out and leaves that size alone for an hour', () => {
            const state = initialState(0);
            runWith(state, slow(32), 2000, 12);
            state.capTrial.should.be.ok();
            captureFailed(state, 12000);
            (state.capTrial === null).should.be.true();
            state.capRung.should.equal(0);
            state.capBlocked[1].should.equal(12000 + 3600000);
            runWith(state, slow(32), 14000, 600).filter((a) => a.kind !== 'tip').should.deepEqual([]);
        });

        it('lets nothing else change the picture while a trial is running', () => {
            const state = initialState(0);
            runWith(state, slow(32), 2000, 12); // the trial starts
            state.capTrial.should.be.ok();
            // the encoder is saturated during the trial: the trial's verdict comes first
            const busy = { fps: 40, srcFps: 60, encMs: 24, kbps: 9000, lost: 0, rtt: 150, lim: 'cpu', limBwMs: 0, retx: 0 };
            runWith(state, busy, 14000, 6).should.deepEqual([]);
        });
    });
});
