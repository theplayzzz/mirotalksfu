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
    const state = { enabled: false, intervalMs: 10000, timer: null, busy: false, previous: new Map(), envSent: false };

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

    async function environment() {
        const brands = navigator.userAgentData?.brands?.filter((b) => !/not.?a.?brand/i.test(b.brand)) || [];
        const browser = brands.length ? brands.map((b) => `${b.brand} ${b.version}`).join(', ') : undefined;
        const h264 = 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
        return {
            browser: browser ? browser.slice(0, 60) : undefined,
            os: (navigator.userAgentData?.platform || navigator.platform || '').slice(0, 60) || undefined,
            cores: navigator.hardwareConcurrency,
            mem: navigator.deviceMemory,
            caps: {
                vp8e: await capability('encodingInfo', 'video/VP8'),
                h264e: await capability('encodingInfo', h264),
                vp8d: await capability('decodingInfo', 'video/VP8'),
                h264d: await capability('decodingInfo', h264),
            },
        };
    }

    // ---- screens this browser receives ---------------------------------------------------------------------

    function isScreen(consumerId) {
        // Remote screen tiles have no name attribute, camera tiles have the peer id (RoomClient.handleConsumer).
        const element = document.getElementById(consumerId);
        return element && element.tagName === 'VIDEO' && !element.hasAttribute('name');
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
            if (!before) continue;

            const seconds = (s.timestamp - before.timestamp) / 1000;
            if (!(seconds > 0)) continue;
            const received = delta(s, before, 'packetsReceived');
            const lost = delta(s, before, 'packetsLost');
            const buffered = delta(s, before, 'jitterBufferEmittedCount');
            rx.push({
                id: String(id).slice(0, 36),
                type: isScreen(id) ? 'screen' : 'camera',
                fps: round(delta(s, before, 'framesDecoded') / seconds, 1),
                w: s.frameWidth,
                h: s.frameHeight,
                kbps: round((delta(s, before, 'bytesReceived') * 8) / 1000 / seconds),
                loss: received + lost ? round((lost / (received + lost)) * 100, 2) : 0,
                frz: delta(s, before, 'freezeCount'),
                frzMs: round(delta(s, before, 'totalFreezesDuration') * 1000),
                drop: delta(s, before, 'framesDropped'),
                kf: delta(s, before, 'keyFramesDecoded'),
                pli: delta(s, before, 'pliCount'),
                nack: delta(s, before, 'nackCount'),
                jbMs: buffered ? round((delta(s, before, 'jitterBufferDelay') / buffered) * 1000, 1) : undefined,
                dec: typeof s.decoderImplementation === 'string' ? s.decoderImplementation.slice(0, 40) : undefined,
                hw: typeof s.powerEfficientDecoder === 'boolean' ? s.powerEfficientDecoder : undefined,
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
            for (const s of reports(report, 'outbound-rtp', 'video')) {
                const key = `${id}:${s.ssrc}`;
                const before = state.previous.get(key);
                state.previous.set(key, s);
                if (!before) continue;

                const seconds = (s.timestamp - before.timestamp) / 1000;
                if (!(seconds > 0)) continue;
                const frames = delta(s, before, 'framesEncoded');
                const durations = s.qualityLimitationDurations || {};
                const durationsBefore = before.qualityLimitationDurations || {};
                tx.push({
                    type: producerType(id),
                    fps: round(frames / seconds, 1),
                    w: s.frameWidth,
                    h: s.frameHeight,
                    kbps: round((delta(s, before, 'bytesSent') * 8) / 1000 / seconds),
                    tgtKbps: round((s.targetBitrate || 0) / 1000),
                    lim: ['none', 'cpu', 'bandwidth', 'other'].includes(s.qualityLimitationReason) ? s.qualityLimitationReason : undefined,
                    limCpuMs: round(((durations.cpu || 0) - (durationsBefore.cpu || 0)) * 1000),
                    limBwMs: round(((durations.bandwidth || 0) - (durationsBefore.bandwidth || 0)) * 1000),
                    enc: typeof s.encoderImplementation === 'string' ? s.encoderImplementation.slice(0, 40) : undefined,
                    hw: typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : undefined,
                    kf: delta(s, before, 'keyFramesEncoded'),
                    pli: delta(s, before, 'pliCount'),
                    nack: delta(s, before, 'nackCount'),
                    encMs: frames ? round((delta(s, before, 'totalEncodeTime') / frames) * 1000, 2) : undefined,
                    rtt: remote && typeof remote.roundTripTime === 'number' ? round(remote.roundTripTime * 1000) : undefined,
                    lost: remote && typeof remote.fractionLost === 'number' ? round(remote.fractionLost * 100, 2) : undefined,
                });
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
        if (state.busy || !hasRoom() || document.visibilityState === 'hidden') return;
        state.busy = true;
        try {
            const rx = await readReceived();
            const tx = await readSent();
            const report = { dt: state.intervalMs, rx, tx, net: await readNetwork() };
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
            state.intervalMs = Math.min(60, Math.max(5, Number(config.healthMeter.intervalS) || 10)) * 1000;
        } catch (error) {
            return;
        }
        state.timer = setInterval(tick, state.intervalMs);
    }

    window.HealthMeter = { start, tick, state };
    start();
})();
