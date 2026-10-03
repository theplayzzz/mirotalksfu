'use strict';

/*
 * Screen quality: what each viewer really needs of every shared screen.
 *
 * A screen is sent in one size with 3 frame-rate layers (VP8 L1T3: 1/4, 1/2 and all of the frames, which cost 40%,
 * 60% and 100% of the bits). With the server setting SELECTIVE_RECEPTION the browser can ask the server for fewer of
 * them, in one of two ways (SELECTIVE_MODE):
 *   - 'adaptive' (the default): everything, always, until THIS viewer is struggling (the browser drops frames before
 *     showing them, the decoder is busy, the picture freezes without any packet lost). Then the least important screen
 *     (not pinned, smallest tile) goes one layer down, and after 30 quiet seconds the most important one comes back
 *     up. Smoothness first: people want every screen at the frame rate its sender gives, and only a viewer that cannot
 *     keep up loses frames, and only as many as it must.
 *   - 'tile': the layer follows the size of the tile (15 fps for a thumbnail, 30 for a medium tile). This was the
 *     first version and it assumed a 60 fps sender: a sender at 16 fps (a loaded PC) became 4 fps in a small tile, and
 *     "some saw it perfect and others stuttering". Now it never takes a screen below 24 fps, whatever the tile.
 * In both the frame rate of the SENDER is estimated from what arrives and the layer it is on, and no layer that would
 * leave less than the floor (24 fps for a tile, 12 for a viewer that is struggling) is ever chosen. The biggest tile
 * also gets priority when the network is short. With SCREEN_SIMULCAST_LAYERS the screen can be sent in up to 3 sizes
 * too (off by default: Chrome does not hold the bandwidth estimate of a layered sender up, see docs/MEASUREMENTS.md).
 *
 * Nothing is paused and nothing is lowered because the window is hidden or a tile is out of sight: it was, in the first
 * version, and the people of the room did not want it (a paused video can only start again at a new full picture from
 * the sender, which takes from 1 to 10 seconds). Changing the frame-rate layer needs no full picture.
 *
 * The rules are pure functions, loaded also by the unit tests (tests/test-ScreenQuality.js).
 */
(function (root) {
    // ---- rules ---------------------------------------------------------------------------------------------

    const HOLD_UP_MS = 300; // a bigger layer is asked for after the need has lasted this long
    const HOLD_DOWN_MS = 1500; // a smaller one after this long
    const POLL_MS = 250;
    const DEFAULT_TOP_WIDTH = 1920;

    // Size of every layer as a fraction of the full size, smallest first.
    function layerScales(layers) {
        if (layers >= 3) return [0.25, 0.5, 1];
        if (layers === 2) return [0.5, 1];
        return [1];
    }

    // The smallest layer that shows a tile of `neededWidth` device pixels without enlarging it much.
    function pickLayer(layers, topWidth, neededWidth, slack = 0.9) {
        const scales = layerScales(layers);
        for (let i = 0; i < scales.length; i++) {
            if (topWidth * scales[i] >= neededWidth * slack) return i;
        }
        return scales.length - 1;
    }

    // Frame-rate layer for a tile `cssWidth` pixels wide (what the eye sees, not the device pixels) of a screen that
    // has `temporalLayers` of them (3 = 60, 30 and 15 fps): a thumbnail gets the lowest, a medium tile the middle one
    // and everything bigger all frames, so a 2x2 grid on a 1080p window keeps every frame.
    const THUMBNAIL_MAX_CSS_PX = 450;
    const MEDIUM_MAX_CSS_PX = 720;
    function pickTemporal(temporalLayers, cssWidth) {
        const top = Math.max(0, temporalLayers - 1);
        if (top === 0 || !(cssWidth > 0)) return top;
        if (cssWidth <= THUMBNAIL_MAX_CSS_PX) return 0;
        if (cssWidth <= MEDIUM_MAX_CSS_PX) return Math.min(1, top);
        return top;
    }

    // ---- the frame rate that is left ------------------------------------------------------------------------

    const FLOOR_TILE_FPS = 24; // 'tile' mode: a screen is never taken below this many frames per second
    const FLOOR_STRUGGLE_FPS = 12; // a viewer that cannot keep up: smooth at 12 is better than frozen at 60
    const STRUGGLE_DROP_RATE = 0.08; // 8% of the frames dropped by the browser before they were shown
    const STRUGGLE_BUSY = 0.65; // the decoder busy more than 65% of the time (decode ms x frames per second)
    const CALM_MS = 30000; // a viewer that has not struggled for this long gets a screen back up one layer
    const COOLDOWN_MS = 8000; // after a change, wait before the next one: the numbers need time to show its effect

    // The share of the frames that temporal layer `layer` carries when the screen has layers 0..top: each layer doubles
    // them (L1T3: 1/4, 1/2, all)
    const fractionOf = (layer, top) => 2 ** (Math.max(0, layer) - Math.max(0, top));

    // The lowest layer that still gives `floorFps` when the sender sends `senderFps` in all of them. Unknown sender rate:
    // nothing is taken away.
    function lowestAllowed(senderFps, top, floorFps) {
        if (!(senderFps > 0) || top <= 0) return Math.max(0, top);
        for (let layer = 0; layer <= top; layer++) {
            if (senderFps * fractionOf(layer, top) >= floorFps) return layer;
        }
        return top;
    }

    // What one screen should get now. tile: { visible, width (device pixels), cssWidth }, temporalLayers: how many
    // frame-rate layers the screen has (1 = none), senderFps: the estimated frame rate of the sender (0 = not known).
    // A tile that is not on screen (focus mode, scrolled away, a hidden window) keeps everything: the best layers are
    // what a new consumer gets, so nothing has to be asked for, and when the person looks again the picture is there,
    // already moving. This is the 'tile' mode: the layer follows the size of the tile, but never below the floor.
    function decide({ layers, topWidth, tile, temporalLayers = 1, senderFps = 0 }) {
        const bestTemporal = Math.max(0, temporalLayers - 1);
        if (!tile.visible) return { spatialLayer: Math.max(0, layers - 1), temporalLayer: bestTemporal, reason: 'out-of-sight' };
        // A screen sent in several sizes already has light small ones; frame-rate layers are for the one-size screen
        if (layers > 1) return { spatialLayer: pickLayer(layers, topWidth, tile.width), temporalLayer: bestTemporal, reason: 'visible' };
        const wished = pickTemporal(temporalLayers, tile.cssWidth ?? tile.width);
        const floor = lowestAllowed(senderFps, bestTemporal, FLOOR_TILE_FPS);
        return { spatialLayer: pickLayer(layers, topWidth, tile.width), temporalLayer: Math.max(wished, floor), reason: wished < floor ? 'floor' : 'visible' };
    }

    // Is this browser struggling with one screen? `row` is what StreamStats.receiverRow made of the last seconds.
    // The first guesses of the limits; the decode time per frame (decMs) that the health meter now reports is what
    // will tell where they should really be.
    function struggling(row) {
        if (!row || !(row.seconds > 0)) return false;
        const shown = (row.fps || 0) * row.seconds;
        const dropRate = (row.drop || 0) / Math.max(1, shown + (row.drop || 0));
        const busy = row.decMs && row.fps ? (row.decMs * row.fps) / 1000 : 0;
        // a picture that froze while (almost) no packet was lost is not the network
        const froze = (row.frz || 0) >= 1 && (row.loss || 0) < 2 && dropRate > 0.02;
        return dropRate > STRUGGLE_DROP_RATE || busy > STRUGGLE_BUSY || froze;
    }

    // The 'adaptive' mode: at most one change at a time. `entries`: [{ id, top, layer, senderFps, importance }] with the
    // layer each screen is on now; `struggle`: this viewer is struggling now; `calmSince`: since when it is not (ms, or 0).
    // Returns { id, layer, why } or null.
    function adapt({ entries, now, lastChangeAt = 0, struggle, calmSince = 0 }) {
        if (now - lastChangeAt < COOLDOWN_MS) return null;
        if (struggle) {
            const down = entries
                .filter((e) => e.layer > lowestAllowed(e.senderFps, e.top, FLOOR_STRUGGLE_FPS))
                .sort((a, b) => a.importance - b.importance)[0];
            return down ? { id: down.id, layer: down.layer - 1, why: 'struggle' } : null;
        }
        if (calmSince && now - calmSince >= CALM_MS) {
            const up = entries.filter((e) => e.layer < e.top).sort((a, b) => b.importance - a.importance)[0];
            return up ? { id: up.id, layer: up.layer + 1, why: 'full' } : null;
        }
        return null;
    }

    // Does `wanted` ask for something different from what is applied?
    function differs(applied, wanted) {
        return wanted.spatialLayer !== applied.spatialLayer || wanted.temporalLayer !== applied.temporalLayer;
    }

    // How much picture a layer pair carries, to tell a sharper request from a lighter one
    const level = (layer) => (layer.spatialLayer || 0) * 10 + (layer.temporalLayer || 0);

    // Tells when a change should be sent. `state` is { applied, candidate, lastChange } and is updated.
    // Returns the change to send or null.
    function follow(state, wanted, now) {
        if (!differs(state.applied, wanted)) {
            state.candidate = null;
            return null;
        }
        const key = `layer:${wanted.spatialLayer}/${wanted.temporalLayer}`;
        if (!state.candidate || state.candidate.key !== key) {
            state.candidate = { key, since: now };
        }

        const hold = level(wanted) > level(state.applied) ? HOLD_UP_MS : HOLD_DOWN_MS;
        if (now - state.candidate.since < hold) return null;

        state.applied = { spatialLayer: wanted.spatialLayer, temporalLayer: wanted.temporalLayer };
        state.candidate = null;
        state.lastChange = now;
        return wanted;
    }

    // H.264 entry of the browser's codec list to send the screen with. The level has to cover 1920x1080 at 60 fps (4.2 or
    // more; 3.1 is 720p30). And Chrome on Windows gives its hardware encoders (NVENC, AMF, Quick Sync) to the Baseline,
    // Main and High profiles and keeps the software one (OpenH264) for the Constrained Baseline (42e0xx) that rooms
    // usually offer: so Main comes first, then High, then the plain Baseline, and the Constrained Baseline last.
    function h264Level(codec) {
        const id = String((codec.parameters && codec.parameters['profile-level-id']) || '');
        return id.length === 6 ? parseInt(id.slice(4), 16) : 0;
    }
    // 0 Main, 1 High, 2 Baseline, 3 Constrained Baseline (the software encoder on Windows), 4 anything else
    function h264Rank(codec) {
        const id = String((codec.parameters && codec.parameters['profile-level-id']) || '');
        if (id.length !== 6) return 4;
        const profile = parseInt(id.slice(0, 2), 16);
        const constraints = parseInt(id.slice(2, 4), 16);
        if (profile === 0x4d) return 0;
        if (profile === 0x64) return 1;
        if (profile === 0x42) return constraints & 0x40 ? 3 : 2;
        return 4;
    }
    function pickH264(codecs) {
        const all = (codecs || []).filter(
            (c) => /^video\/h264$/i.test(c.mimeType) && Number(c.parameters && c.parameters['packetization-mode']) === 1
        );
        if (!all.length) return null;
        const fits = all.filter((c) => h264Level(c) >= 0x2a);
        return (fits.length ? fits : all).slice().sort((a, b) => h264Rank(a) - h264Rank(b) || h264Level(a) - h264Level(b))[0];
    }

    // The codec for the screen of this browser: the server setting, and for 'auto' what the browser says it can do.
    function chooseCodec(setting, capability) {
        if (setting === 'h264') return 'h264';
        if (setting === 'auto' && capability && capability.supported && capability.powerEfficient && capability.smooth) {
            return 'h264';
        }
        return 'vp8';
    }

    // The entry of the codec list to send the screen with, or null to leave it to the browser (VP8, the first in the
    // list). For 'auto' the question was whether the browser encodes the Main profile in hardware: an entry that is
    // not one of the profiles it gives to the hardware (a room that offers only the Constrained Baseline) is no answer.
    function pickScreenCodec(setting, capability, codecs) {
        if (chooseCodec(setting, capability) !== 'h264') return null;
        const picked = pickH264(codecs);
        if (picked && setting === 'auto' && h264Rank(picked) > 2) return null;
        return picked;
    }

    // How many frame-rate layers a scalability mode has: 'L1T3' = 3, 'L3T3' = 3, 'S1T2' = 2, none = 1
    function temporalLayersOf(scalabilityMode) {
        const found = /T(\d+)/.exec(String(scalabilityMode || ''));
        return found ? Math.max(1, Number(found[1])) : 1;
    }

    const rules = {
        layerScales,
        pickLayer,
        pickTemporal,
        THUMBNAIL_MAX_CSS_PX,
        MEDIUM_MAX_CSS_PX,
        temporalLayersOf,
        fractionOf,
        lowestAllowed,
        decide,
        struggling,
        adapt,
        differs,
        follow,
        pickH264,
        h264Rank,
        chooseCodec,
        pickScreenCodec,
        HOLD_UP_MS,
        HOLD_DOWN_MS,
        FLOOR_TILE_FPS,
        FLOOR_STRUGGLE_FPS,
        STRUGGLE_DROP_RATE,
        STRUGGLE_BUSY,
        CALM_MS,
        COOLDOWN_MS,
    };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = rules;
        return;
    }

    // ---- in the browser --------------------------------------------------------------------------------------

    const HEALTH_MS = 2000; // how often the statistics of every screen are read to see whether this viewer is struggling

    const state = {
        layers: 1,
        selective: false,
        mode: 'off', // 'off' | 'tile' | 'adaptive' (the server's SELECTIVE_MODE)
        codec: 'vp8',
        codecSetting: 'vp8', // the server's SCREEN_CODEC
        capability: null, // what the browser said about encoding H.264 (only asked for 'auto')
        entries: new Map(),
        timer: null,
        healthTimer: null,
        listening: false,
        loaded: null,
        lastChangeAt: 0,
        calmSince: 0,
    };

    function loadConfig() {
        if (!state.loaded) {
            state.loaded = fetch('/config', { cache: 'no-store' })
                .then((response) => response.json())
                .then((config) => {
                    const screen = (config && config.screen) || {};
                    state.layers = Math.min(3, Math.max(1, Number(screen.layers) || 1));
                    state.selective = screen.selectiveReception === true;
                    // a server that does not say how: the first version, by the size of the tile
                    state.mode = state.selective ? (['tile', 'adaptive'].includes(screen.selectiveMode) ? screen.selectiveMode : 'tile') : 'off';
                    return probeCodec(screen.codec);
                })
                .catch(() => {});
        }
        return state.loaded;
    }

    // What the browser says about encoding 1080p60 H.264 at 12 Mbps in the Main profile, the one the room offers that the
    // hardware encoders take (only asked when the server says 'auto')
    const H264_MAIN = 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d0032';
    async function probeCodec(setting) {
        let capability = null;
        if (setting === 'auto') {
            try {
                capability = await navigator.mediaCapabilities.encodingInfo({
                    type: 'webrtc',
                    video: { contentType: H264_MAIN, width: 1920, height: 1080, bitrate: 12000000, framerate: 60 },
                });
            } catch (error) {
                capability = null;
            }
        }
        state.codecSetting = setting;
        state.capability = capability;
        state.codec = chooseCodec(setting, capability);
    }

    // How many simulcast layers this browser sends its screen in (RoomClient.getScreenEncoding).
    function screenLayers() {
        return state.layers;
    }

    // 'h264' or 'vp8': the codec this browser sends its screen with (RoomClient.getScreenEncoding).
    function screenCodec() {
        return state.codec;
    }

    // The entry of the codec list this browser sends its screen with, or null for the browser's own first choice (VP8)
    function screenCodecEntry(codecs) {
        return pickScreenCodec(state.codecSetting, state.capability, codecs);
    }

    function measureTile(consumerId) {
        const none = { visible: false, width: 0, cssWidth: 0, area: 0, pinned: false };
        const video = document.getElementById(consumerId);
        if (!video || !video.getClientRects().length) return none;

        const style = getComputedStyle(video);
        const wrapper = video.closest('.Camera');
        if (style.display === 'none' || style.visibility === 'hidden') return none;
        if (wrapper && getComputedStyle(wrapper).display === 'none') return none;

        const rect = video.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return none;
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
        if (!inViewport) return none;

        const ratio = window.devicePixelRatio || 1;
        const fullscreen = document.fullscreenElement && (document.fullscreenElement === video || document.fullscreenElement.contains(video));
        const cssWidth = fullscreen ? window.screen.width : rect.width;
        const pinned = (typeof rc !== 'undefined' && rc && rc.pinnedVideoPlayerId === consumerId) || !!video.closest('#videoPinMediaContainer');
        return { visible: true, width: cssWidth * ratio, cssWidth, area: rect.width * rect.height, pinned: pinned || !!fullscreen, video };
    }

    function request(entry, preferences) {
        const room = entry.room;
        if (!room || !room.socket || !room.socket.connected) return Promise.resolve(null);
        return room.socket.request('setConsumerPreferences', { consumer_id: entry.consumer.id, ...preferences }).catch(() => null);
    }

    // Called by RoomClient.consume() for every new consumer, after its tile exists and before it is resumed.
    async function onConsumerCreated(room, consumer, type) {
        await loadConfig();
        if (state.mode === 'off' || consumer.kind !== 'video') return;
        if (typeof RoomClient === 'undefined' || type !== RoomClient.mediaType.screen) return;

        const temporalLayers = temporalLayersOf(consumer.rtpParameters && consumer.rtpParameters.encodings && consumer.rtpParameters.encodings[0] && consumer.rtpParameters.encodings[0].scalabilityMode);
        const entry = {
            room,
            consumer,
            temporalLayers,
            top: Math.max(0, temporalLayers - 1),
            // what the server gives a new consumer: the best it has
            applied: { spatialLayer: state.layers - 1, temporalLayer: temporalLayers - 1 },
            why: 'full',
            changedAt: 0,
            candidate: null,
            lastChange: 0,
            priority: 1,
            activeLayer: null,
            topWidth: DEFAULT_TOP_WIDTH,
            // what is known of it: the frame rate of its sender (estimated from what arrives), the last statistics, its tile
            senderFps: 0,
            prev: null,
            row: null,
            struggle: false,
            tileWidth: 0,
            area: 0,
            pinned: false,
        };
        state.entries.set(consumer.id, entry);

        if (!state.listening && room.socket) {
            state.listening = true;
            room.socket.on('consumerLayers', ({ consumer_id, spatialLayer }) => {
                const known = state.entries.get(consumer_id);
                if (known) known.activeLayer = Number.isInteger(spatialLayer) ? spatialLayer : null;
            });
        }
        if (!state.timer) state.timer = setInterval(poll, POLL_MS);
        if (!state.healthTimer) state.healthTimer = setInterval(() => health().catch(() => {}), HEALTH_MS);

        // 'tile' mode: start at the right layer when the tile already has its size ('adaptive' starts with everything)
        const tile = measureTile(consumer.id);
        if (state.mode === 'tile' && tile.visible && (state.layers > 1 || temporalLayers > 1)) {
            const wanted = decide({ layers: state.layers, topWidth: entry.topWidth, tile, temporalLayers });
            if (differs(entry.applied, wanted)) {
                const answer = await request(entry, { spatialLayer: wanted.spatialLayer, temporalLayer: wanted.temporalLayer });
                if (answer && answer.ok) {
                    entry.applied = { spatialLayer: wanted.spatialLayer, temporalLayer: wanted.temporalLayer };
                    entry.why = 'tile';
                    entry.changedAt = Date.now();
                }
            }
        }
    }

    function poll() {
        const now = Date.now();
        const tiles = new Map();
        let biggest = null;

        for (const [id, entry] of state.entries) {
            if (entry.consumer.closed || !entry.room.consumers || !entry.room.consumers.has(id)) {
                state.entries.delete(id);
                continue;
            }
            const tile = measureTile(id);
            tiles.set(id, tile);
            entry.tileWidth = tile.cssWidth;
            entry.area = tile.area;
            entry.pinned = tile.pinned;
            if (tile.visible && (!biggest || tile.pinned > biggest.pinned || (tile.pinned === biggest.pinned && tile.area > biggest.area))) {
                biggest = { id, pinned: tile.pinned, area: tile.area };
            }
        }
        if (!state.entries.size) {
            clearInterval(state.timer);
            clearInterval(state.healthTimer);
            state.timer = null;
            state.healthTimer = null;
            return;
        }

        for (const [id, entry] of state.entries) {
            const tile = tiles.get(id);
            const priority = biggest && biggest.id === id ? 255 : 1;

            // The size of the full picture: with several sizes it is learned from what the server says it sends
            // (consumerLayers); with one size it is the picture itself
            const video = tile.video;
            if (video && video.videoWidth > 0) {
                if (state.layers === 1) entry.topWidth = video.videoWidth;
                else if (Number.isInteger(entry.activeLayer)) {
                    const scale = layerScales(state.layers)[entry.activeLayer];
                    if (scale) entry.topWidth = video.videoWidth / scale;
                }
            }

            // 'adaptive' mode never follows the tile: only the priority of the biggest one is kept
            if (state.mode !== 'tile') {
                if (priority !== entry.priority) {
                    entry.priority = priority;
                    request(entry, { priority });
                }
                continue;
            }

            const wanted = decide({ layers: state.layers, topWidth: entry.topWidth, tile, temporalLayers: entry.temporalLayers, senderFps: entry.senderFps });
            const change = follow(entry, wanted, now);

            if (change) {
                entry.why = wanted.reason === 'floor' ? 'floor' : 'tile';
                entry.changedAt = now;
                const preferences = { spatialLayer: change.spatialLayer, temporalLayer: change.temporalLayer };
                if (priority !== entry.priority) preferences.priority = priority;
                request(entry, preferences).then((answer) => {
                    if (answer && answer.ok && preferences.priority) entry.priority = preferences.priority;
                    if (!answer || !answer.ok) {
                        // not applied (reconnecting, consumer gone): try again from the real state
                        entry.applied = { spatialLayer: state.layers - 1, temporalLayer: entry.temporalLayers - 1 };
                    }
                });
            } else if (priority !== entry.priority) {
                entry.priority = priority;
                request(entry, { priority });
            }
        }
    }

    // Every few seconds: read the statistics of every screen, estimate the frame rate of its sender and, in 'adaptive'
    // mode, take one layer off the least important screen when this viewer struggles (and give it back when it is calm).
    async function health() {
        if (!state.entries.size || !window.StreamStats) return;
        // a page nobody sees drops frames on purpose: it says nothing about whether the viewer can keep up
        if (document.visibilityState === 'hidden') {
            state.calmSince = 0;
            return;
        }
        const now = Date.now();
        let any = false;
        for (const entry of state.entries.values()) {
            if (entry.consumer.closed) continue;
            let report;
            try {
                report = await entry.consumer.getStats();
            } catch (error) {
                continue;
            }
            let inbound = null;
            report.forEach((r) => {
                if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
            });
            if (!inbound) continue;
            const row = window.StreamStats.receiverRow({ s: inbound, before: entry.prev });
            entry.prev = inbound;
            if (!row) continue;
            entry.row = row;
            // The frame rate of the sender: what arrives divided by the share of the frames of the layer it is on (a
            // few seconds after a change of layer the picture still shows the old one)
            if (now - entry.changedAt > 6000 && row.fps > 0) {
                const estimate = row.fps / fractionOf(entry.applied.temporalLayer, entry.top);
                entry.senderFps = entry.senderFps ? entry.senderFps * 0.5 + estimate * 0.5 : estimate;
            }
            entry.struggle = struggling(row);
            if (entry.struggle) any = true;
        }
        if (any) state.calmSince = 0;
        else if (!state.calmSince) state.calmSince = now;
        if (state.mode !== 'adaptive') return;

        const entries = [...state.entries.values()].map((e) => ({
            id: e.consumer.id,
            top: e.top,
            layer: e.applied.temporalLayer,
            senderFps: e.senderFps,
            importance: (e.pinned ? 1e9 : 0) + (e.area || 0),
        }));
        const action = adapt({ entries, now, lastChangeAt: state.lastChangeAt, struggle: any, calmSince: state.calmSince });
        if (!action) return;
        const entry = state.entries.get(action.id);
        if (!entry) return;
        const answer = await request(entry, { spatialLayer: state.layers - 1, temporalLayer: action.layer });
        if (answer && answer.ok) {
            entry.applied = { spatialLayer: state.layers - 1, temporalLayer: action.layer };
            entry.why = action.why === 'full' && action.layer >= entry.top ? 'full' : action.why;
            entry.changedAt = now;
            state.lastChangeAt = now;
            // after a step up wait for another quiet stretch before the next one
            state.calmSince = action.why === 'full' ? now : 0;
        }
    }

    // What this viewer asked of the server for a screen: the temporal layer, why, and the width of its tile (the health meter reports it)
    function layerInfo(consumerId) {
        const entry = state.entries.get(consumerId);
        return entry ? { tl: entry.applied.temporalLayer, why: entry.why, tw: Math.round(entry.tileWidth || 0) } : null;
    }

    // The health meter asks (it leaves paused screens out of its numbers). Nothing is paused by the page any more.
    function isPaused() {
        return false;
    }

    root.ScreenQuality = { screenLayers, screenCodec, screenCodecEntry, pickH264, onConsumerCreated, isPaused, layerInfo, state, rules };
    loadConfig();
})(typeof window !== 'undefined' ? window : globalThis);
