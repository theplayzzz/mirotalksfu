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
 *     CAPTURE is slow (a whole 1440p screen with a game using the GPU): a smaller picture will not fix it, so nothing
 *     is lowered, it is only reported (health meter, field gWhy = 'capture');
 *   - the encoder: milliseconds per frame x frames per second = how busy it is (1 = busy all the time). Saturated
 *     (85%+) for 6 s: the picture goes one rung down the ladder (the encoder has less to do and keeps 60 fps);
 *   - the uplink: what the server reports back (loss, round trip), the share of what was sent that was a repeat,
 *     and whether the browser says it is limited by bandwidth. Bad for 4 s: one rung down, which also lowers the
 *     bitrate ceiling to what that rung needs, so a line that cannot carry 12 Mbps stops being offered them.
 * And it goes back up one rung after a long quiet stretch (45 s, doubling up to 5 min each time a rise had to be
 * taken back at once), only when the encoder would still have room at the bigger size.
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

    // What the numbers of the last seconds say. Returns { busy, capture, encoder, uplink, bandwidth, calm }.
    function assess(row, targetFps = TARGET_FPS) {
        if (!row) return { busy: 0, capture: false, encoder: false, uplink: false, bandwidth: false, calm: false };
        const util = busy(row);
        const source = row.srcFps > 0 ? row.srcFps : null;
        // the uplink: the server says packets are lost on the way in, or repeats are a big share of what is sent, or the
        // round trip is long while the browser says its estimate is the limit
        const uplink = (row.lost || 0) >= 4 || (row.retx || 0) >= 15 || ((row.rtt || 0) >= 450 && row.lim === 'bandwidth');
        // the capture gives little (or, where it is not reported, the encoder produces little while idle)
        const given = source !== null ? source : row.fps;
        const capture = given > 0 && given < targetFps * 0.8 && util < 0.7 && !uplink;
        // the encoder: busy nearly all the time, or the source gave frames that never came out of it
        const encoder = (util >= BUSY_LIMIT || (source !== null && (row.fps || 0) < source * 0.75)) && !capture && !uplink;
        const bandwidth = row.lim === 'bandwidth' && (row.limBwMs || 0) >= 3000 && !uplink;
        const calm = !uplink && !encoder && !capture && (row.lost || 0) < 1.5 && (row.retx || 0) < 5 && util < BUSY_ROOM + 0.1 && (row.fps || 0) >= targetFps * 0.92;
        return { busy: util, capture, encoder, uplink, bandwidth, calm };
    }

    function initialState(now = 0) {
        return { rung: 0, changedAt: now, busySince: 0, uplinkSince: 0, calmSince: 0, upAfterMs: UP_AFTER_MS, lastUpAt: 0, why: 'start' };
    }

    // One step. `state` is changed and returned with `action` (what to apply, or null). `row`: StreamStats.senderRow.
    // `size`: the size of the picture being captured { width, height }.
    function step(state, row, now, size = {}) {
        const a = assess(row);
        const next = state;
        if (a.encoder) next.busySince = next.busySince || now;
        else next.busySince = 0;
        if (a.uplink) next.uplinkSince = next.uplinkSince || now;
        else next.uplinkSince = 0;
        if (a.calm) next.calmSince = next.calmSince || now;
        else next.calmSince = 0;

        let action = null;
        const cooled = now - next.changedAt >= COOLDOWN_MS;
        const last = LADDER.length - 1;
        const why = a.capture ? 'capture' : a.uplink ? 'uplink' : a.encoder ? 'encoder' : a.bandwidth ? 'bandwidth' : a.calm ? 'ok' : next.why === 'start' ? 'start' : 'steady';

        if (cooled && next.rung < last && ((next.busySince && now - next.busySince >= DOWN_BUSY_MS) || (next.uplinkSince && now - next.uplinkSince >= DOWN_UPLINK_MS))) {
            const reason = next.uplinkSince && now - next.uplinkSince >= DOWN_UPLINK_MS ? 'uplink' : 'encoder';
            // a rise that did not hold: wait longer before the next one
            if (next.lastUpAt && now - next.lastUpAt < TOOK_BACK_MS) {
                next.upAfterMs = Math.min(UP_AFTER_MAX_MS, next.upAfterMs * 2);
                next.lastUpAt = 0; // counted once: the steps that follow are the same fall, not more rises taken back
            }
            next.rung += 1;
            next.changedAt = now;
            next.busySince = 0;
            next.uplinkSince = 0;
            next.calmSince = 0;
            action = { rung: next.rung, scale: LADDER[next.rung].scale, kbps: rungKbps(next.rung, size.width, size.height), why: reason };
            next.why = reason;
        } else if (cooled && next.rung > 0 && next.calmSince && now - next.calmSince >= next.upAfterMs) {
            // would the encoder still have room at the bigger size? (its work grows with the number of pixels)
            const grow = (LADDER[next.rung].scale / LADDER[next.rung - 1].scale) ** 2;
            if (a.busy * grow < BUSY_ROOM) {
                next.rung -= 1;
                next.changedAt = now;
                next.lastUpAt = now;
                next.calmSince = 0;
                action = { rung: next.rung, scale: LADDER[next.rung].scale, kbps: rungKbps(next.rung, size.width, size.height), why: 'room' };
                next.why = 'room';
            }
        } else {
            next.why = why;
        }
        return { state: next, action };
    }

    const rules = { LADDER, rungKbps, busy, assess, initialState, step, TARGET_FPS, POLL_MS, COOLDOWN_MS, UP_AFTER_MS, DOWN_BUSY_MS, DOWN_UPLINK_MS };
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
        const { action } = step(entry.state, row, now, size);
        entry.last = { rung: entry.state.rung, why: entry.state.why, mode };
        if (!action) return;
        entry.last = { rung: action.rung, why: action.why, mode };
        // 'observe' only says what it would do: the picture is left alone and the ladder goes on as if nothing changed
        if (mode !== 'apply') {
            entry.state.rung = rungBefore;
            return;
        }
        try {
            await producer.setRtpEncodingParameters({ scaleResolutionDownBy: action.scale, maxBitrate: action.kbps * 1000 });
        } catch (error) {
            entry.last = { rung: entry.state.rung, why: 'failed', mode };
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
            sample(entry, Date.now()).catch(() => {});
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
