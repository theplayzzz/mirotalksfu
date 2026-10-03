'use strict';

/*
 * Room health meter (browser side). See app/src/HealthMeter.js on the server.
 *
 * Every few seconds this reads the WebRTC statistics of the screens this browser sends and receives and
 * reports numbers computed over the last interval: frames per second, freezes, what limits the encoder,
 * which encoder or decoder is used, and so on. It starts only when the server turns it on (/config) and it
 * never gets in the way: every error is swallowed and a report is skipped while the previous one runs.
 */
(function () {
    const state = { enabled: false, intervalMs: 10000, timer: null, busy: false, previous: new Map(), envSent: false, build: undefined };

    const round = (value, decimals = 0) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
        const factor = 10 ** decimals;
        return Math.round(value * factor) / factor;
    };

    // Difference between two cumulative counters, never negative (counters restart when a stream restarts).
    const delta = (now, before, key) => Math.max(0, (now[key] || 0) - ((before && before[key]) || 0));

    function reports(report, type, kind) {
        const found = [];
        report.forEach((entry) => {
            if (entry.type === type && (!kind || entry.kind === kind || entry.mediaType === kind)) found.push(entry);
        });
        return found;
    }

    function hasRoom() {
        return typeof rc !== 'undefined' && rc && rc.socket && rc.socket.connected;
    }

    // ---- what this browser can do (sent once per page load) --------------------------------------------

    function capabilityLabel(info) {
        if (!info) return undefined;
        if (!info.supported) return 'no';
        return `${info.powerEfficient ? 'hw' : 'sw'}${info.smooth ? '' : '!smooth'}`;
    }

    async function capability(method, contentType) {
        try {
            const video = { contentType, width: 1920, height: 1080, bitrate: 12000000, framerate: 60 };
            return capabilityLabel(await navigator.mediaCapabilities[method]({ type: 'webrtc', video }));
        } catch (error) {
            return undefined;
        }
    }

    // The graphics card as the browser names it ("ANGLE (AMD, AMD Radeon RX 9060 XT (0x00007590) Direct3D11 ...)" -> the card)
    function graphicsCard() {
        try {
            const gl = document.createElement('canvas').getContext('webgl');
            const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
            let name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : '';
            if (name.startsWith('ANGLE (')) {
                name = name.slice(7, -1);
                const comma = name.indexOf(', ');
                if (comma >= 0) name = name.slice(comma + 2);
            }
            name = name.replace(/ \(0x[0-9a-fA-F]+\)/, '').replace(/ (Direct3D|OpenGL|Vulkan|Metal).*$/, '');
            return name.replace(/[^\w .,:+\-/()@]/g, '').slice(0, 70) || undefined;
        } catch (error) {
            return undefined;
        }
    }

    async function environment() {
        const brands = navigator.userAgentData?.brands?.filter((b) => !/not.?a.?brand/i.test(b.brand)) || [];
        const browser = brands.length ? brands.map((b) => `${b.brand} ${b.version}`).join(', ') : undefined;
        const h264 = 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
        return {
            browser: browser ? browser.slice(0, 60) : undefined,
            os: (navigator.userAgentData?.platform || navigator.platform || '').slice(0, 60) || undefined,
            cores: navigator.hardwareConcurrency,
            mem: navigator.deviceMemory,
            gpu: graphicsCard(),
            scr: `${screen.width}x${screen.height}@${round(window.devicePixelRatio || 1, 2)}`,
            caps: {
                vp8e: await capability('encodingInfo', 'video/VP8'),
                h264e: await capability('encodingInfo', h264),
                vp9e: await capability('encodingInfo', 'video/VP9'),
                av1e: await capability('encodingInfo', 'video/AV1'),
                vp8d: await capability('decodingInfo', 'video/VP8'),
                h264d: await capability('decodingInfo', h264),
                vp9d: await capability('decodingInfo', 'video/VP9'),
                av1d: await capability('decodingInfo', 'video/AV1'),
            },
        };
    }

    // ---- screens this browser receives ---------------------------------------------------------------------

    function isScreen(consumerId) {
        // Remote screen tiles have no name attribute, camera tiles have the peer id (RoomClient.handleConsumer).
        const element = document.getElementById(consumerId);
        return element && element.tagName === 'VIDEO' && !element.hasAttribute('name');
    }

    // What this viewer asked of the server for a screen (the temporal layer and why) and the size of its tile
    function layerOf(consumerId) {
        try {
            const info = window.ScreenQuality && window.ScreenQuality.layerInfo ? window.ScreenQuality.layerInfo(consumerId) : null;
            return info ? { tl: info.tl, lw: info.why, tw: info.tw } : {};
        } catch (error) {
            return {};
        }
    }

    async function readReceived() {
        const rx = [];
        for (const [id, consumer] of rc.consumers) {
            if (consumer.kind !== 'video' || consumer.closed) continue;
            // A screen paused on purpose (nobody looks at it) would count as frozen
            if (window.ScreenQuality && window.ScreenQuality.isPaused(id)) {
                state.previous.delete(id);
                continue;
            }
            const report = await consumer.getStats();
            const s = reports(report, 'inbound-rtp', 'video')[0];
            if (!s) continue;

            const before = state.previous.get(id);
            state.previous.set(id, s);
            const row = window.StreamStats.receiverRow({ s, before });
            if (!row) continue;
            delete row.seconds;
            rx.push({
                id: String(id).slice(0, 36),
                pid: String(consumer.producerId || '').slice(0, 8),
                from: consumer.appData && consumer.appData.from ? String(consumer.appData.from).slice(0, 40) : undefined,
                type: isScreen(id) ? 'screen' : 'camera',
                ...row,
                ...layerOf(id),
            });
        }
        return rx;
    }

    // ---- screens this browser sends ------------------------------------------------------------------------

    function producerType(id) {
        try {
            return rc.producerLabel.get(RoomClient.mediaType.screen) === id ? 'screen' : 'camera';
        } catch (error) {
            return 'camera';
        }
    }

    async function readSent() {
        const tx = [];
        for (const [id, producer] of rc.producers) {
            if (producer.kind !== 'video' || producer.closed) continue;
            const report = await producer.getStats();
            const remote = reports(report, 'remote-inbound-rtp')[0];
            const source = reports(report, 'media-source', 'video')[0];
            const sourceBefore = state.previous.get(`${id}:source`);
            if (source) state.previous.set(`${id}:source`, source);
            const track = producer.track;
            let settings;
            let parameters;
            try {
                settings = track && track.getSettings ? track.getSettings() : undefined;
                parameters = producer.rtpSender && producer.rtpSender.getParameters ? producer.rtpSender.getParameters() : undefined;
            } catch (error) {
                // a track that just ended
            }
            const guard = window.SendGuard && window.SendGuard.snapshot ? window.SendGuard.snapshot(id) : null;
            for (const s of reports(report, 'outbound-rtp', 'video')) {
                const key = `${id}:${s.ssrc}`;
                const before = state.previous.get(key);
                state.previous.set(key, s);
                const row = window.StreamStats.senderRow({
                    s,
                    before,
                    source,
                    sourceBefore,
                    remote,
                    settings,
                    parameters,
                    hint: track && track.contentHint,
                    mime: producer.rtpParameters && producer.rtpParameters.codecs && producer.rtpParameters.codecs[0] && producer.rtpParameters.codecs[0].mimeType,
                });
                if (!row) continue;
                tx.push({ pid: String(id).slice(0, 8), type: producerType(id), ...row, ...(guard ? { gRung: guard.rung, gWhy: guard.why, gMode: guard.mode } : {}) });
            }
        }
        return tx;
    }

    // ---- the network path (estimates made by the browser for the two transports) -------------------------------

    async function pairOf(transport) {
        if (!transport || transport.closed) return null;
        const report = await transport.getStats();
        return reports(report, 'candidate-pair').find((p) => p.nominated && p.state === 'succeeded') || null;
    }

    async function readNetwork() {
        const net = {};
        try {
            const up = await pairOf(rc.producerTransport);
            if (up) {
                net.rtt = round((up.currentRoundTripTime || 0) * 1000);
                net.aout = round((up.availableOutgoingBitrate || 0) / 1000);
            }
        } catch (error) {
            // no send transport yet
        }
        try {
            const down = await pairOf(rc.consumerTransport);
            if (down) {
                if (net.rtt === undefined) net.rtt = round((down.currentRoundTripTime || 0) * 1000);
                net.ain = round((down.availableIncomingBitrate || 0) / 1000);
            }
        } catch (error) {
            // no receive transport yet
        }
        return Object.keys(net).length ? net : undefined;
    }

    // ---- one report ----------------------------------------------------------------------------------------

    async function tick() {
        if (state.busy || !hasRoom()) return;
        state.busy = true;
        try {
            const rx = await readReceived();
            const tx = await readSent();
            const report = { dt: state.intervalMs, cb: state.build, vis: document.visibilityState === 'visible', rx, tx, net: await readNetwork() };
            if (!state.envSent) {
                state.envSent = true;
                report.env = await environment();
            }
            // Forget counters of streams that are gone.
            const live = new Set([...rc.consumers.keys(), ...rc.producers.keys()]);
            for (const key of state.previous.keys()) if (!live.has(String(key).split(':')[0])) state.previous.delete(key);

            if (rx.length || tx.length || report.env || report.net) rc.socket.emit('healthReport', report);
        } catch (error) {
            // never get in the way of the room
        } finally {
            state.busy = false;
        }
    }

    async function start() {
        try {
            const response = await fetch('/config', { cache: 'no-store' });
            const config = await response.json();
            if (!config || !config.healthMeter || !config.healthMeter.enabled) return;
            state.enabled = true;
            state.build = typeof config.build === 'string' ? config.build.slice(0, 12) : undefined;
            state.intervalMs = Math.min(60, Math.max(5, Number(config.healthMeter.intervalS) || 10)) * 1000;
        } catch (error) {
            return;
        }
        state.timer = setInterval(tick, state.intervalMs);
    }

    window.HealthMeter = { start, tick, state };
    start();
})();
