'use strict';

/*
 * Screen quality: what each viewer really needs of every shared screen.
 *
 * Without it every viewer downloads every screen in full quality (4 screens of 12 Mbps = ~47 Mbps each), even
 * screens shown as small tiles, hidden by the focus mode or in a window nobody is looking at. With the server
 * setting SELECTIVE_RECEPTION the browser looks at its own screen and asks the server for:
 *   - the layer that fits the tile (screens are sent in up to 3 sizes: 1/4, 1/2 and full, see SCREEN_SIMULCAST_LAYERS),
 *   - priority for the biggest tile when the network is short,
 *   - a pause of the video of a tile that is hidden (or of all of them while the page itself is hidden).
 * Audio is never paused. Quality goes up quickly and down slowly, so resizing or unpinning does not make it flap.
 *
 * The rules at the top are pure functions, loaded also by the unit tests (tests/test-ScreenQuality.js).
 */
(function (root) {
    // ---- rules ---------------------------------------------------------------------------------------------

    const HOLD_UP_MS = 300; // a bigger layer is asked for after the need has lasted this long
    const HOLD_DOWN_MS = 1500; // a smaller one after this long
    const HOLD_TILE_HIDDEN_MS = 1500;
    const HOLD_PAGE_HIDDEN_MS = 3000;
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

    // What one screen should get now. tile: { visible, width (device pixels) }, page: { hidden, pictureInPicture }.
    function decide({ layers, topWidth, tile, page }) {
        if (page.hidden && !page.pictureInPicture) return { paused: true, reason: 'page-hidden' };
        if (!tile.visible) return { paused: true, reason: 'tile-hidden' };
        return { paused: false, spatialLayer: pickLayer(layers, topWidth, tile.width), reason: 'visible' };
    }

    // Does `wanted` ask for something different from what is applied?
    function differs(applied, wanted) {
        if (wanted.paused !== applied.paused) return true;
        return !wanted.paused && wanted.spatialLayer !== applied.spatialLayer;
    }

    // Tells when a change should be sent. `state` is { applied, candidate, lastChange } and is updated.
    // Returns the change to send or null.
    function follow(state, wanted, now) {
        if (!differs(state.applied, wanted)) {
            state.candidate = null;
            return null;
        }
        const key = wanted.paused ? `paused:${wanted.reason}` : `layer:${wanted.spatialLayer}`;
        if (!state.candidate || state.candidate.key !== key) {
            state.candidate = { key, since: now };
        }

        const resuming = state.applied.paused && !wanted.paused;
        const sharper = !wanted.paused && !state.applied.paused && wanted.spatialLayer > state.applied.spatialLayer;
        let hold;
        if (resuming) hold = 0;
        else if (wanted.paused) hold = wanted.reason === 'page-hidden' ? HOLD_PAGE_HIDDEN_MS : HOLD_TILE_HIDDEN_MS;
        else hold = sharper ? HOLD_UP_MS : HOLD_DOWN_MS;

        if (now - state.candidate.since < hold) return null;

        state.applied = wanted.paused ? { paused: true } : { paused: false, spatialLayer: wanted.spatialLayer };
        state.candidate = null;
        state.lastChange = now;
        return wanted;
    }

    const rules = { layerScales, pickLayer, decide, differs, follow, HOLD_UP_MS, HOLD_DOWN_MS };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = rules;
        return;
    }

    // ---- in the browser --------------------------------------------------------------------------------------

    const state = { layers: 1, selective: false, entries: new Map(), timer: null, listening: false, loaded: null };

    function loadConfig() {
        if (!state.loaded) {
            state.loaded = fetch('/config', { cache: 'no-store' })
                .then((response) => response.json())
                .then((config) => {
                    const screen = (config && config.screen) || {};
                    state.layers = Math.min(3, Math.max(1, Number(screen.layers) || 1));
                    state.selective = screen.selectiveReception === true;
                })
                .catch(() => {});
        }
        return state.loaded;
    }

    // How many simulcast layers this browser sends its screen in (RoomClient.getScreenEncoding).
    function screenLayers() {
        return state.layers;
    }

    function pageState() {
        return {
            hidden: document.visibilityState === 'hidden',
            pictureInPicture: !!document.pictureInPictureElement || !!(window.documentPictureInPicture && window.documentPictureInPicture.window),
        };
    }

    function measureTile(consumerId) {
        const none = { visible: false, width: 0, area: 0, pinned: false };
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
        const width = (fullscreen ? window.screen.width : rect.width) * ratio;
        const pinned = (typeof rc !== 'undefined' && rc && rc.pinnedVideoPlayerId === consumerId) || !!video.closest('#videoPinMediaContainer');
        return { visible: true, width, area: rect.width * rect.height, pinned: pinned || !!fullscreen, video };
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

        const entry = {
            room,
            consumer,
            applied: { paused: false, spatialLayer: state.layers - 1 }, // what the server gives a new consumer
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
        if (tile.visible && state.layers > 1) {
            const layer = pickLayer(state.layers, entry.topWidth, tile.width);
            if (layer !== entry.applied.spatialLayer) {
                const answer = await request(entry, { spatialLayer: layer });
                if (answer && answer.ok) entry.applied = { paused: false, spatialLayer: layer };
            }
        }
    }

    function poll() {
        const now = Date.now();
        const page = pageState();
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

            // The size of the full picture is learned from what the server says it sends (consumerLayers)
            const video = tile.video;
            if (video && video.videoWidth > 0 && Number.isInteger(entry.activeLayer)) {
                const scale = layerScales(state.layers)[entry.activeLayer];
                if (scale) entry.topWidth = video.videoWidth / scale;
            }

            const wanted = decide({ layers: state.layers, topWidth: entry.topWidth, tile, page });
            const change = follow(entry, wanted, now);
            const priority = biggest && biggest.id === id ? 255 : 1;

            if (change) {
                const preferences = change.paused ? { paused: true } : { paused: false, spatialLayer: change.spatialLayer };
                if (priority !== entry.priority) preferences.priority = priority;
                request(entry, preferences).then((answer) => {
                    if (answer && answer.ok && preferences.priority) entry.priority = preferences.priority;
                    if (!answer || !answer.ok) {
                        // not applied (reconnecting, consumer gone): try again from the real state
                        entry.applied = { paused: !change.paused, spatialLayer: state.layers - 1 };
                    }
                });
            } else if (priority !== entry.priority && !wanted.paused) {
                entry.priority = priority;
                request(entry, { priority });
            }
        }
    }

    function isPaused(consumerId) {
        const entry = state.entries.get(consumerId);
        return !!entry && entry.applied.paused === true;
    }

    root.ScreenQuality = { screenLayers, onConsumerCreated, isPaused, state, rules };
    loadConfig();
})(typeof window !== 'undefined' ? window : globalThis);
