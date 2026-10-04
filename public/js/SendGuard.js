'use strict';

/*
 * Sender guard: keeps the screen this browser SENDS at the frame rate people want (60 fps), whatever the monitor, the
 * PC or the internet of the sender, by lowering the size of the picture (and the bitrate that goes with it) before it
 * lets the frame rate go, and by raising it back, slowly, when there is room.
 *
 * Why. A game screen is only watchable at its full frame rate, and the pictures people lose first are the ones sent from
 * a PC that also runs the game (the encoder gets the leftovers: 28-32 ms per frame at 1080p instead of 7) or over a
 * weak uplink (a sender at 7 Mbps on a 5 Mbps line: every viewer sees 40% loss at 3 fps, and the repeats of lost packets
 * make it worse). A smaller picture at 60 fps is better than a large one at 16, and the viewers' SFU can do nothing
 * about either: only the sender can.
 *
 * What it looks at, every 2 seconds (StreamStats.senderRow, from the same statistics as the health meter):
 *   - the capture (media-source): frames per second the screen capture gives. Low while the encoder is idle = the
 *     CAPTURE is slow (a whole 1440p screen with a game using the GPU): the encoder's size will not fix it, so the
 *     ladder is left alone; a smaller capture is tried instead (below) and it is reported (health meter, field gWhy);
 *   - the encoder: milliseconds per frame x frames per second = how busy it is (1 = busy all the time). Saturated
 *     (85%+) for 6 s: the picture goes one rung down the ladder (the encoder has less to do and keeps 60 fps). A
 *     hardware encoder is not measured this way (its "time per frame" is the delay of the pipeline, not a load): for
 *     it only frames that never come out, or the browser saying the processor limits it, count;
 *   - the uplink: what the server reports back (loss, round trip), the share of what was sent that was a repeat,
 *     and whether the browser says it is limited by bandwidth. Bad for 4 s: down the ladder, which also lowers the
 *     bitrate ceiling to what that rung needs, so a line that cannot carry 12 Mbps stops being offered them. It goes
 *     straight to the rung that fits what the line is seen to carry (80% of what was sent minus what was lost), not
 *     one rung at a time: a sender on a 5 Mbps line is at 4 Mbps in one step instead of three.
 * And it goes back up one rung after a long quiet stretch (45 s, doubling up to 5 min each time a rise had to be
 * taken back at once), only when the encoder would still have room at the bigger size and, for a sender that had to come
 * down because of its line, only to a rung the line is known to carry (what it carried is remembered for 30 minutes):
 * going back up to a rung that needs more than the line has would put the viewers through the same loss again every few
 * minutes.
 *
 * A slow CAPTURE (the screen gives few frames while the encoder is idle and the picture is moving) cannot be helped by
 * the encoder's size: Chrome converts and scales every captured frame on the processor and may use at most half of the
 * time for it, so a smaller capture can be the only thing that gives frames back. It is not known in advance whether it
 * will on a given PC, so it is TRIED: after 8 s of a slow capture the capture itself is asked for a smaller size
 * (track.applyConstraints), and if the capture does not give at least 20% more frames in the next 11 s it goes back and
 * that size is left alone for 5 minutes (10, 20 ... if it fails again). A screen that hardly moves is not a slow capture
 * (the capture gives frames only when the screen changes), and is never touched. Much later, after 3 minutes of calm, the
 * bigger size is tried again the same way. When the capture stays slow and there is nothing left to try (every smaller size was
 * tried or the smallest is reached), the sender is told once, in a small notice of its own, what usually fixes it (the size
 * of the game and of the screen, the game's own frame rate, the power cable) and where the capture test is.
 *
 * Modes (the server's SEND_GUARD): 'observe' decides and reports but changes nothing; 'apply' also does it.
 * The decision logic is pure (below) and loaded by the unit tests (tests/test-SendGuard.js).
 */
(function (root) {
    // The ladder: divisor of the size of the picture and the bitrate that fits it, for a 1920x1080 picture. A smaller
    // capture (a window) uses less of the bitrate in proportion to its pixels.
    const LADDER = [
        { scale: 1, kbps: 12000 },
        { scale: 1.25, kbps: 9000 },
        { scale: 1.5, kbps: 6500 },
        { scale: 2, kbps: 4000 },
        { scale: 3, kbps: 2200 },
    ];
    const FULL_HD_PIXELS = 1920 * 1080;
    const MIN_KBPS = 1500;

    const TARGET_FPS = 60;
    const POLL_MS = 2000;
    const BUSY_LIMIT = 0.85; // the encoder is the bottleneck above this share of the time
    const BUSY_ROOM = 0.6; // a bigger picture is only tried when the encoder would still be below this at that size
    const UPLINK_FILL = 0.8; // the share of what the line carries that a rung may ask for
    const LINE_MEMORY_MS = 1800000; // what a line was seen to carry is remembered this long: no rise above it meanwhile
    const LINE_RISE_FILL = 0.95; // a rise is only tried to a rung that asks for no more than this share of what the line carried

    // The capture ladder: the size asked of the capture itself is the size it started at divided by these
    const CAPTURE_SCALES = [1, 1.25, 1.5, 2];
    const MOVING_KBPS = 1500; // a picture that sends less than this hardly moves: the low frame rate is the content's
    const CAPTURE_TRIAL_AFTER_MS = 8000; // slow this long before a smaller capture is tried
    const CAPTURE_SETTLE_MS = 3000; // the first seconds after a change are not counted
    const CAPTURE_EVAL_MS = 11000; // how long a trial lasts
    const CAPTURE_GAIN = 1.2; // a trial that does not give this much more (and 4 fps more) is taken back
    const CAPTURE_BLOCK_MS = 300000; // a size that did not help is left alone this long, doubling each time, up to an hour
    const CAPTURE_UP_AFTER_MS = 180000; // calm this long before the bigger capture is tried again
    const CAPTURE_TIP_AFTER_MS = 90000; // slow this long, with nothing left to try, and the sender is told what usually helps
    const DOWN_BUSY_MS = 6000;
    const DOWN_UPLINK_MS = 4000;
    const COOLDOWN_MS = 10000;
    const UP_AFTER_MS = 45000;
    const UP_AFTER_MAX_MS = 300000;
    const TOOK_BACK_MS = 60000; // a rise that has to be undone within this long doubles the wait for the next

    // The bitrate ceiling for a rung, for the picture that is really being captured
    function rungKbps(rung, width, height) {
        const pixels = width > 0 && height > 0 ? width * height : FULL_HD_PIXELS;
        const share = Math.min(1, pixels / FULL_HD_PIXELS);
        return Math.round(Math.max(MIN_KBPS, LADDER[rung].kbps * share));
    }

    // How busy the encoder is, from a StreamStats.senderRow
    const busy = (row) => (row && row.encMs && row.fps ? (row.encMs * row.fps) / 1000 : 0);

    // Is this a hardware encoder? `hw` is the browser's own word (powerEfficientEncoder: only said to a page that has a capture
    // open, which a sender has); the name is the fallback ("ExternalEncoder", "D3D11VideoEncoder"; "libvpx, fallback from ..." is software)
    function isHardware(row) {
        if (!row) return false;
        if (row.hw === true) return true;
        if (row.hw === false) return false;
        const name = String(row.enc || '');
        if (!name || /fallback|libvpx|openh264|libaom|dav1d|software/i.test(name)) return false;
        return /external|d3d11|mediafoundation|nvenc|amf|qsv|videotoolbox|vaapi|v4l2/i.test(name);
    }

    // What the line is seen to carry, in kbps: what was sent minus what the server says was lost on the way
    function capacityKbps(row) {
        if (!row || !(row.kbps > 0)) return 0;
        return row.kbps * (1 - Math.min(100, Math.max(0, row.lost || 0)) / 100);
    }

    // What the numbers of the last seconds say. Returns { busy, capture, encoder, uplink, bandwidth, calm, hardware }.
    function assess(row, targetFps = TARGET_FPS) {
        if (!row) return { busy: 0, capture: false, encoder: false, uplink: false, bandwidth: false, calm: false, hardware: false };
        const hardware = isHardware(row);
        // the time per frame of a hardware encoder is a delay, not a load: it says nothing about how busy it is
        const util = hardware ? 0 : busy(row);
        const source = row.srcFps > 0 ? row.srcFps : null;
        // the uplink: the server says packets are lost on the way in, or repeats are a big share of what is sent, or the
        // round trip is long while the browser says its estimate is the limit
        const uplink = (row.lost || 0) >= 4 || (row.retx || 0) >= 15 || ((row.rtt || 0) >= 450 && row.lim === 'bandwidth');
        // the capture gives little (or, where it is not reported, the encoder produces little while idle)
        const given = source !== null ? source : row.fps;
        // a still screen gives frames only when it changes: few frames and few bits is the content, not a slow capture
        const moving = row.kbps === undefined || row.kbps >= MOVING_KBPS;
        const capture = given > 0 && given < targetFps * 0.8 && util < 0.7 && !uplink && moving;
        // the browser itself says the processor is what limits the picture (for at least half of the last interval)
        const cpuLimited = (row.limCpuMs || 0) >= POLL_MS / 2;
        // the encoder: busy nearly all the time, or the source gave frames that never came out of it
        const encoder = (util >= BUSY_LIMIT || cpuLimited || (source !== null && (row.fps || 0) < source * 0.75)) && !capture && !uplink;
        const bandwidth = row.lim === 'bandwidth' && (row.limBwMs || 0) >= 3000 && !uplink;
        const calm = !uplink && !encoder && !capture && (row.lost || 0) < 1.5 && (row.retx || 0) < 5 && util < BUSY_ROOM + 0.1 && (row.fps || 0) >= targetFps * 0.92;
        return { busy: util, capture, encoder, uplink, bandwidth, calm, hardware };
    }

    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    // The size to ask of the capture at a rung of the capture ladder, for a capture that started at `base`
    function captureSize(base, rung) {
        const scale = CAPTURE_SCALES[rung] || 1;
        return { width: even(base.width / scale), height: even(base.height / scale) };
    }

    // The browser would not make the capture the size that was tried: forget the trial and leave that size alone for an hour
    function captureFailed(state, now) {
        const trial = state.capTrial;
        if (!trial) return state;
        state.capRung = trial.from;
        state.capTrial = null;
        state.capBlocked[trial.to] = now + 3600000;
        return state;
    }

    function initialState(now = 0) {
        return {
            rung: 0,
            changedAt: now,
            busySince: 0,
            uplinkSince: 0,
            calmSince: 0,
            upAfterMs: UP_AFTER_MS,
            lastUpAt: 0,
            why: 'start',
            // what the line of the sender was seen to carry when it had to come down because of it (kbps) and when
            lineKbps: 0,
            lineAt: 0,
            // the capture ladder: the size the capture started at, where it is now, the trial in progress, when it began
            // to be slow, which sizes are left alone until when and how many trials did not help
            base: null,
            capRung: 0,
            capTrial: null,
            capSince: 0,
            capBlocked: {},
            capFails: 0,
            slowSince: 0, // since when the capture is slow, whatever the trials do (the tip is about this)
            tipShown: false,
        };
    }

    // One step. `state` is changed and returned with `action` (what to apply, or null). `row`: StreamStats.senderRow.
    // `size`: the size of the picture being captured { width, height }.
    function step(state, row, now, size = {}, options = {}) {
        const a = assess(row);
        const next = state;
        const trials = options.trials !== false;
        if (!next.base && size.width > 0 && size.height > 0) next.base = { width: size.width, height: size.height };
        if (a.capture) next.capSince = next.capSince || now;
        else next.capSince = 0;
        if (a.capture) next.slowSince = next.slowSince || now;
        else next.slowSince = 0;
        if (a.encoder) next.busySince = next.busySince || now;
        else next.busySince = 0;
        if (a.uplink) next.uplinkSince = next.uplinkSince || now;
        else next.uplinkSince = 0;
        if (a.calm) next.calmSince = next.calmSince || now;
        else next.calmSince = 0;

        // a trial of another capture size is running: its verdict comes first, and nothing else changes meanwhile
        if (next.capTrial) {
            const trial = next.capTrial;
            if (now - trial.since >= CAPTURE_SETTLE_MS && row && row.srcFps > 0) trial.samples.push(row.srcFps);
            if (now - trial.since < CAPTURE_EVAL_MS) {
                next.why = 'capture-trial';
                return { state: next, action: null };
            }
            const mean = trial.samples.length ? trial.samples.reduce((sum, v) => sum + v, 0) / trial.samples.length : 0;
            const better = trial.up ? mean >= TARGET_FPS * 0.9 : mean >= trial.before * CAPTURE_GAIN && mean >= trial.before + 4;
            next.capTrial = null;
            next.capSince = 0;
            if (better) {
                next.changedAt = now;
                next.why = trial.up ? 'capture-up' : 'capture-kept';
                return { state: next, action: null };
            }
            // it did not help: back to the size that was, and that size is left alone for longer each time
            next.capRung = trial.from;
            next.capFails += 1;
            next.capBlocked[trial.to] = now + Math.min(3600000, CAPTURE_BLOCK_MS * 2 ** (next.capFails - 1));
            next.changedAt = now;
            next.why = 'capture-undo';
            const back = captureSize(next.base, next.capRung);
            return { state: next, action: { kind: 'capture', capRung: next.capRung, from: trial.to, width: back.width, height: back.height, why: 'capture-undo' } };
        }

        let action = null;
        const cooled = now - next.changedAt >= COOLDOWN_MS;
        const last = LADDER.length - 1;

        // the capture has been slow for a long time and nothing is left to try: the sender is told, once
        if (trials && !next.tipShown && next.slowSince && now - next.slowSince >= CAPTURE_TIP_AFTER_MS) {
            const exhausted = next.capRung >= CAPTURE_SCALES.length - 1 || now < (next.capBlocked[next.capRung + 1] || 0);
            // a screen that gives 24, 25 or 30 frames a second is most likely a film or a video, not a slow capture
            const fps = row && row.srcFps > 0 ? row.srcFps : row && row.fps;
            const content = [24, 25, 30].some((rate) => Math.abs(fps - rate) <= 1.2);
            if (exhausted && !content) {
                next.tipShown = true;
                return { state: next, action: { kind: 'tip', cause: 'capture', fps: row && row.srcFps > 0 ? row.srcFps : row && row.fps, why: 'tip' } };
            }
        }

        // a slow capture: ask the capture itself for a smaller size, and see whether it gives more frames
        if (trials && next.base && cooled && row && row.srcFps > 0) {
            const blocked = (rung) => now < (next.capBlocked[rung] || 0);
            let to = null;
            let up = false;
            if (a.capture && next.capSince && now - next.capSince >= CAPTURE_TRIAL_AFTER_MS && next.capRung < CAPTURE_SCALES.length - 1 && !blocked(next.capRung + 1)) {
                to = next.capRung + 1;
            } else if (next.capRung > 0 && next.calmSince && now - next.calmSince >= CAPTURE_UP_AFTER_MS && !blocked(next.capRung - 1)) {
                to = next.capRung - 1;
                up = true;
            }
            if (to !== null) {
                const target = captureSize(next.base, to);
                next.capTrial = { from: next.capRung, to, before: row.srcFps, since: now, samples: [], up };
                next.capRung = to;
                next.changedAt = now;
                next.capSince = 0;
                next.calmSince = 0;
                next.why = 'capture-trial';
                // (the bitrate ceiling is left as it is: a smaller picture does not need less of it, and a ceiling that is too low
                // for the motion makes the encoder drop the very frames this is trying to give back)
                return { state: next, action: { kind: 'capture', capRung: to, width: target.width, height: target.height, why: up ? 'capture-up-try' : 'capture' } };
            }
        }
        const why = a.capture ? 'capture' : a.uplink ? 'uplink' : a.encoder ? 'encoder' : a.bandwidth ? 'bandwidth' : a.calm ? 'ok' : next.why === 'start' ? 'start' : 'steady';

        if (cooled && next.rung < last && ((next.busySince && now - next.busySince >= DOWN_BUSY_MS) || (next.uplinkSince && now - next.uplinkSince >= DOWN_UPLINK_MS))) {
            const reason = next.uplinkSince && now - next.uplinkSince >= DOWN_UPLINK_MS ? 'uplink' : 'encoder';
            // a rise that did not hold: wait longer before the next one
            if (next.lastUpAt && now - next.lastUpAt < TOOK_BACK_MS) {
                next.upAfterMs = Math.min(UP_AFTER_MAX_MS, next.upAfterMs * 2);
                next.lastUpAt = 0; // counted once: the steps that follow are the same fall, not more rises taken back
            }
            let target = next.rung + 1;
            // an uplink that cannot carry what is sent: the rung that fits what it carries, not the next one
            const capacity = capacityKbps(row);
            if (reason === 'uplink' && capacity > 0) {
                while (target < last && rungKbps(target, size.width, size.height) > capacity * UPLINK_FILL) target += 1;
            }
            next.rung = target;
            if (reason === 'uplink' && capacity > 0) {
                next.lineKbps = capacity;
                next.lineAt = now;
            }
            next.changedAt = now;
            next.busySince = 0;
            next.uplinkSince = 0;
            next.calmSince = 0;
            action = { kind: 'ladder', rung: next.rung, scale: LADDER[next.rung].scale, kbps: rungKbps(next.rung, size.width, size.height), why: reason };
            next.why = reason;
        } else if (cooled && next.rung > 0 && next.calmSince && now - next.calmSince >= next.upAfterMs) {
            // would the encoder still have room at the bigger size? (its work grows with the number of pixels) and would the
            // line carry it, if it is known not to carry much? (the bitrate the bigger rung asks for, against what it carried)
            const grow = (LADDER[next.rung].scale / LADDER[next.rung - 1].scale) ** 2;
            const lineKnown = next.lineKbps > 0 && now - next.lineAt < LINE_MEMORY_MS;
            const lineFits = !lineKnown || rungKbps(next.rung - 1, size.width, size.height) <= next.lineKbps * LINE_RISE_FILL;
            if (a.busy * grow < BUSY_ROOM && lineFits) {
                next.rung -= 1;
                next.changedAt = now;
                next.lastUpAt = now;
                next.calmSince = 0;
                action = { kind: 'ladder', rung: next.rung, scale: LADDER[next.rung].scale, kbps: rungKbps(next.rung, size.width, size.height), why: 'room' };
                next.why = 'room';
            }
        } else {
            next.why = why;
        }
        return { state: next, action };
    }

    const rules = { LADDER, CAPTURE_SCALES, captureSize, captureFailed, rungKbps, busy, isHardware, capacityKbps, assess, initialState, step, TARGET_FPS, POLL_MS, COOLDOWN_MS, UP_AFTER_MS, DOWN_BUSY_MS, DOWN_UPLINK_MS, MOVING_KBPS, CAPTURE_TRIAL_AFTER_MS, CAPTURE_EVAL_MS, CAPTURE_BLOCK_MS, CAPTURE_UP_AFTER_MS };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = rules;
        return;
    }

    // ---- in the browser --------------------------------------------------------------------------------------

    const guards = new Map(); // producer id -> { producer, state, prevOut, prevSource, timer, size }
    let mode = 'off';
    let loaded = null;

    function loadConfig() {
        if (!loaded) {
            loaded = fetch('/config', { cache: 'no-store' })
                .then((response) => response.json())
                .then((config) => {
                    const guard = config && config.screen && config.screen.guard;
                    mode = guard === 'apply' || guard === 'observe' ? guard : 'off';
                })
                .catch(() => {});
        }
        return loaded;
    }

    async function sample(entry, now) {
        const producer = entry.producer;
        const report = await producer.getStats();
        let out = null;
        let source = null;
        let remote = null;
        report.forEach((r) => {
            if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
            else if (r.type === 'media-source' && r.kind === 'video') source = r;
            else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remote = r;
        });
        if (!out || !window.StreamStats) return;
        let settings;
        let parameters;
        try {
            settings = producer.track && producer.track.getSettings ? producer.track.getSettings() : undefined;
            parameters = producer.rtpSender && producer.rtpSender.getParameters ? producer.rtpSender.getParameters() : undefined;
        } catch (error) {
            // a track that just ended
        }
        const row = window.StreamStats.senderRow({ s: out, before: entry.prevOut, source, sourceBefore: entry.prevSource, remote, settings, parameters, hint: producer.track && producer.track.contentHint });
        entry.prevOut = out;
        entry.prevSource = source;
        if (!row) return;
        const size = { width: (source && source.width) || (settings && settings.width) || 0, height: (source && source.height) || (settings && settings.height) || 0 };
        const rungBefore = entry.state.rung;
        // only 'apply' tries other sizes of the capture: a trial needs the capture to really change to mean anything
        const { action } = step(entry.state, row, now, size, { trials: mode === 'apply' });
        const state = entry.state;
        entry.last = { rung: state.rung, cap: state.capRung, why: state.why, mode };
        if (!action) return;
        entry.last = { rung: action.kind === 'capture' ? state.rung : action.rung, cap: state.capRung, why: action.why, mode };
        // 'observe' only says what it would do: the picture is left alone and the ladder goes on as if nothing changed
        if (mode !== 'apply') {
            state.rung = rungBefore;
            return;
        }
        if (action.kind === 'tip') {
            showTip(action);
            return;
        }
        try {
            if (action.kind === 'capture') {
                // the capture itself is asked for another size; the encoder keeps its own size and its bitrate ceiling
                await producer.track.applyConstraints({
                    width: { ideal: action.width, max: action.width },
                    height: { ideal: action.height, max: action.height },
                    frameRate: { ideal: TARGET_FPS, max: TARGET_FPS },
                });
            } else {
                await producer.setRtpEncodingParameters({ scaleResolutionDownBy: action.scale, maxBitrate: action.kbps * 1000 });
            }
        } catch (error) {
            if (action.kind === 'capture') {
                if (state.capTrial) captureFailed(state, now);
                else if (action.why === 'capture-undo') {
                    // the way back was refused: the capture is still at the smaller size, and bigger ones are left alone
                    state.capRung = action.from;
                    state.capBlocked[action.from - 1] = now + 3600000;
                }
            }
            entry.last = { rung: state.rung, cap: state.capRung, why: 'failed', mode };
        }
    }

    // A small notice of its own (not a pop-up of the room's library, which holds only one at a time): what usually fixes a capture
    // that stays slow. Once per share, gone by itself after a while.
    function showTip(action) {
        try {
            if (typeof document === 'undefined' || document.getElementById('sendGuardTip')) return;
            const box = document.createElement('div');
            box.id = 'sendGuardTip';
            box.setAttribute('role', 'status');
            // the text is already Portuguese: the room's machine translation (Google widget) would mangle it
            box.setAttribute('translate', 'no');
            box.className = 'notranslate';
            box.style.cssText =
                'position:fixed;left:16px;bottom:16px;max-width:380px;z-index:2147483000;background:#22111a;color:#f3e8ec;border:1px solid #e0546f;border-radius:10px;padding:12px 36px 12px 14px;font:14px/1.45 system-ui,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)';
            const title = document.createElement('div');
            title.style.cssText = 'font-weight:700;margin-bottom:4px';
            const fps = action.fps > 0 ? ` (${Math.round(action.fps)} fps)` : '';
            title.textContent = `A captura da sua tela está lenta${fps}`;
            const text = document.createElement('div');
            text.textContent =
                'O navegador gasta tempo demais para ler a tela e não consegue mandar 60 fps. Costuma ajudar: jogar/compartilhar em 1920x1080 (tela cheia em monitor 2K/4K é o mais pesado), limitar os fps do jogo a 60-90, ligar o PC na tomada e deixar a aceleração por hardware do navegador ligada.';
            const link = document.createElement('a');
            link.href = '/capture-test';
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = 'Medir a captura deste PC';
            link.style.cssText = 'display:inline-block;margin-top:6px;color:#e0546f';
            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = '\u00d7';
            close.setAttribute('aria-label', 'Fechar');
            close.style.cssText = 'position:absolute;top:6px;right:10px;background:none;border:0;color:#f3e8ec;font-size:20px;line-height:1;cursor:pointer';
            close.addEventListener('click', () => box.remove());
            box.append(title, text, link, close);
            document.body.appendChild(box);
            setTimeout(() => box.remove(), 45000);
        } catch (error) {
            // a notice must never get in the way
        }
    }

    // Called by RoomClient after a screen is produced.
    async function attach(room, producer) {
        await loadConfig();
        if (mode === 'off' || !producer || producer.kind !== 'video') return;
        // a screen sent in several sizes (SCREEN_SIMULCAST_LAYERS) has no single size to lower
        if (producer.rtpParameters && producer.rtpParameters.encodings && producer.rtpParameters.encodings.length > 1) return;
        if (guards.has(producer.id)) return;
        // Game screens are motion: keep the frame rate, shrink the picture when something has to give (a saved setting
        // of "text and detail" would tell Chrome to do the opposite and drop frames instead). Only when it applies.
        try {
            if (mode === 'apply' && producer.track && 'contentHint' in producer.track) producer.track.contentHint = 'motion';
            if (mode === 'apply' && producer.rtpSender && producer.rtpSender.getParameters) {
                const parameters = producer.rtpSender.getParameters();
                parameters.degradationPreference = 'maintain-framerate';
                await producer.rtpSender.setParameters(parameters).catch(() => {});
            }
        } catch (error) {
            // not supported here
        }
        const entry = { producer, state: initialState(Date.now()), prevOut: null, prevSource: null, last: { rung: 0, why: 'start', mode }, timer: null };
        guards.set(producer.id, entry);
        entry.timer = setInterval(() => {
            if (producer.closed || (producer.track && producer.track.readyState === 'ended')) return detach(producer.id);
            // a change of the capture can take longer than a poll: one sample at a time
            if (entry.busy) return;
            entry.busy = true;
            sample(entry, Date.now())
                .catch(() => {})
                .finally(() => {
                    entry.busy = false;
                });
        }, POLL_MS);
    }

    function detach(id) {
        const entry = guards.get(id);
        if (!entry) return;
        clearInterval(entry.timer);
        guards.delete(id);
    }

    // What the health meter reports about the guard of a producer
    function snapshot(id) {
        const entry = guards.get(id);
        return entry ? entry.last : null;
    }

    root.SendGuard = { attach, detach, snapshot, rules, state: { guards } };
    loadConfig();
})(typeof window !== 'undefined' ? window : globalThis);
