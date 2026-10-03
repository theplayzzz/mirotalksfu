'use strict';

/*
 * Screen quality: what each viewer really needs of every shared screen.
 *
 * Without it every viewer downloads every screen in full quality (4 screens of 12 Mbps = ~47 Mbps each), even
 * screens shown as small tiles. With the server setting SELECTIVE_RECEPTION the browser looks at its own screen and
 * asks the server for:
 *   - the layer that fits the tile. A screen is sent in one size with 3 frame-rate layers (VP8 L1T3: 60, 30 and 15
 *     fps, which cost 100%, 60% and 40% of the bits), so a thumbnail gets 15 fps and a medium tile 30 fps. With
 *     SCREEN_SIMULCAST_LAYERS the screen can also be sent in up to 3 sizes (1/4, 1/2 and full), and then the size
 *     is chosen instead (off by default: Chrome does not hold the bandwidth estimate of a layered sender up, see
 *     docs/MEASUREMENTS.md),
 *   - priority for the biggest tile when the network is short.
 * Nothing is paused and nothing is lowered because the window is hidden or a tile is out of sight. It was, in the
 * first version, and the people of the room did not want it: coming back to a window found the screens stopped, and
 * a paused video can only start again at a new full picture from the sender, which takes from 1 to 10 seconds.
 * Changing the frame-rate layer instead needs no full picture, but the rule is simply "what is on screen counts".
 * Quality goes up quickly and down slowly, so resizing or unpinning does not make it flap.
 *
 * The rules at the top are pure functions, loaded also by the unit tests (tests/test-ScreenQuality.js).
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

    // What one screen should get now. tile: { visible, width (device pixels), cssWidth }, temporalLayers: how many
    // frame-rate layers the screen has (1 = none). A tile that is not on screen (focus mode, scrolled away, a hidden
    // window) keeps everything: the best layers are what a new consumer gets, so nothing has to be asked for, and
    // when the person looks again the picture is there, already moving.
    function decide({ layers, topWidth, tile, temporalLayers = 1 }) {
        const bestTemporal = Math.max(0, temporalLayers - 1);
        if (!tile.visible) return { spatialLayer: Math.max(0, layers - 1), temporalLayer: bestTemporal, reason: 'out-of-sight' };
        // A screen sent in several sizes already has light small ones; frame-rate layers are for the one-size screen
        const temporalLayer = layers > 1 ? bestTemporal : pickTemporal(temporalLayers, tile.cssWidth ?? tile.width);
        return { spatialLayer: pickLayer(layers, topWidth, tile.width), temporalLayer, reason: 'visible' };
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

    // H.264 entry of the browser's codec list to send the screen with: the level has to cover 1920x1080 at 60 fps
    // (4.2 or more; 3.1 is 720p30), and among those the simplest profile (Constrained Baseline, then Main, then High),
    // which every hardware encoder handles.
    function h264Level(codec) {
        const id = String((codec.parameters && codec.parameters['profile-level-id']) || '');
        return id.length === 6 ? parseInt(id.slice(4), 16) : 0;
    }
    function h264Profile(codec) {
        const id = String((codec.parameters && codec.parameters['profile-level-id']) || '');
        return id.length === 6 ? parseInt(id.slice(0, 2), 16) : 0;
    }
    function pickH264(codecs) {
        const all = (codecs || []).filter(
            (c) => /^video\/h264$/i.test(c.mimeType) && Number(c.parameters && c.parameters['packetization-mode']) === 1
        );
        if (!all.length) return null;
        const fits = all.filter((c) => h264Level(c) >= 0x2a);
        const rank = (c) => ({ 0x42: 0, 0x4d: 1, 0x64: 2 })[h264Profile(c)] ?? 3;
        return (fits.length ? fits : all).slice().sort((a, b) => rank(a) - rank(b) || h264Level(a) - h264Level(b))[0];
    }

    // The codec for the screen of this browser: the server setting, and for 'auto' what the browser says it can do.
    function chooseCodec(setting, capability) {
        if (setting === 'h264') return 'h264';
        if (setting === 'auto' && capability && capability.supported && capability.powerEfficient && capability.smooth) {
            return 'h264';
        }
        return 'vp8';
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
        decide,
        differs,
        follow,
        pickH264,
        chooseCodec,
        HOLD_UP_MS,
        HOLD_DOWN_MS,
    };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = rules;
        return;
    }

    // ---- in the browser --------------------------------------------------------------------------------------

    const state = {
        layers: 1,
        selective: false,
        codec: 'vp8',
        entries: new Map(),
        timer: null,
        listening: false,
        loaded: null,
    };

    function loadConfig() {
        if (!state.loaded) {
            state.loaded = fetch('/config', { cache: 'no-store' })
                .then((response) => response.json())
                .then((config) => {
                    const screen = (config && config.screen) || {};
                    state.layers = Math.min(3, Math.max(1, Number(screen.layers) || 1));
                    state.selective = screen.selectiveReception === true;
                    return probeCodec(screen.codec);
                })
                .catch(() => {});
        }
        return state.loaded;
    }

    // What the browser says about encoding 1080p60 H.264 at 12 Mbps (only asked when the server says 'auto')
    async function probeCodec(setting) {
        let capability = null;
        if (setting === 'auto') {
            try {
                capability = await navigator.mediaCapabilities.encodingInfo({
                    type: 'webrtc',
                    video: {
                        contentType: 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e02a',
                        width: 1920,
                        height: 1080,
                        bitrate: 12000000,
                        framerate: 60,
                    },
                });
            } catch (error) {
                capability = null;
            }
        }
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
        if (!state.selective || consumer.kind !== 'video') return;
        if (typeof RoomClient === 'undefined' || type !== RoomClient.mediaType.screen) return;

        const temporalLayers = temporalLayersOf(consumer.rtpParameters && consumer.rtpParameters.encodings && consumer.rtpParameters.encodings[0] && consumer.rtpParameters.encodings[0].scalabilityMode);
        const entry = {
            room,
            consumer,
            temporalLayers,
            // what the server gives a new consumer: the best it has
            applied: { spatialLayer: state.layers - 1, temporalLayer: temporalLayers - 1 },
            candidate: null,
            lastChange: 0,
            priority: 1,
            activeLayer: null,
            topWidth: DEFAULT_TOP_WIDTH,
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

        // Start at the right layer when the tile already has its size
        const tile = measureTile(consumer.id);
        if (tile.visible && (state.layers > 1 || temporalLayers > 1)) {
            const wanted = decide({ layers: state.layers, topWidth: entry.topWidth, tile, temporalLayers });
            if (differs(entry.applied, wanted)) {
                const answer = await request(entry, { spatialLayer: wanted.spatialLayer, temporalLayer: wanted.temporalLayer });
                if (answer && answer.ok) entry.applied = { spatialLayer: wanted.spatialLayer, temporalLayer: wanted.temporalLayer };
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
            if (tile.visible && (!biggest || tile.pinned > biggest.pinned || (tile.pinned === biggest.pinned && tile.area > biggest.area))) {
                biggest = { id, pinned: tile.pinned, area: tile.area };
            }
        }
        if (!state.entries.size) {
            clearInterval(state.timer);
            state.timer = null;
            return;
        }

        for (const [id, entry] of state.entries) {
            const tile = tiles.get(id);

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

            const wanted = decide({ layers: state.layers, topWidth: entry.topWidth, tile, temporalLayers: entry.temporalLayers });
            const change = follow(entry, wanted, now);
            const priority = biggest && biggest.id === id ? 255 : 1;

            if (change) {
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

    // The health meter asks (it leaves paused screens out of its numbers). Nothing is paused by the page any more.
    function isPaused() {
        return false;
    }

    root.ScreenQuality = { screenLayers, screenCodec, pickH264, onConsumerCreated, isPaused, state, rules };
    loadConfig();
})(typeof window !== 'undefined' ? window : globalThis);
