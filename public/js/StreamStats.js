'use strict';

/*
 * Turns two samples of WebRTC statistics into the numbers the health meter reports and the sender guard decides on.
 * Pure functions (no page, no network): loaded in the browser by HealthMeter.js and SendGuard.js, and in Node by the
 * unit tests (tests/test-StreamStats.js).
 *
 * What each number is for, when a screen looks bad:
 *   srcFps    frames per second the SOURCE (the screen capture) gives; low while the encoder is idle = the capture is slow
 *   fps       frames per second the encoder produced; below srcFps = the encoder (or the size/bitrate limits) dropped frames
 *   encMs     milliseconds per frame in the encoder; encMs * fps / 1000 is how busy the encoder is (1 = a whole core)
 *   lim*      what the browser says limits the picture (cpu or bandwidth) and for how long
 *   retx      the part of what was sent that was a repeat of lost packets
 *   rtt/lost  what the server reports back about the way from this sender to it
 */
(function (root) {
    const round = (value, decimals = 0) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
        const factor = 10 ** decimals;
        return Math.round(value * factor) / factor;
    };

    // Difference between two cumulative counters, never negative (counters restart when a stream restarts).
    const delta = (now, before, key) => Math.max(0, ((now && now[key]) || 0) - ((before && before[key]) || 0));

    const hints = ['motion', 'detail', 'text'];
    const degradations = ['maintain-framerate', 'maintain-resolution', 'balanced', 'disabled'];

    // One row for a stream this browser SENDS. `s`/`before`: outbound-rtp now and at the last sample; `source`/`sourceBefore`:
    // media-source (the capture); `remote`: remote-inbound-rtp; `settings`: track.getSettings(); `parameters`: what
    // RTCRtpSender.getParameters() says; `hint`: track.contentHint; `mime`: 'video/VP8' ...
    function senderRow({ s, before, source, sourceBefore, remote, settings, parameters, hint, mime }) {
        if (!s || !before) return null;
        const seconds = (s.timestamp - before.timestamp) / 1000;
        if (!(seconds > 0)) return null;
        const frames = delta(s, before, 'framesEncoded');
        const durations = s.qualityLimitationDurations || {};
        const durationsBefore = before.qualityLimitationDurations || {};
        const bytes = delta(s, before, 'bytesSent');
        const packets = delta(s, before, 'packetsSent');
        const encoding = (parameters && parameters.encodings && parameters.encodings[0]) || {};
        const sourceSeconds = source && sourceBefore ? (source.timestamp - sourceBefore.timestamp) / 1000 : 0;
        const codec = typeof mime === 'string' ? mime.replace(/^video\//i, '').toUpperCase() : undefined;
        return {
            fps: round(frames / seconds, 1),
            w: s.frameWidth,
            h: s.frameHeight,
            kbps: round((bytes * 8) / 1000 / seconds),
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
            // the capture, and what the browser made of the capture request
            srcFps: sourceSeconds > 0 ? round(delta(source, sourceBefore, 'frames') / sourceSeconds, 1) : undefined,
            srcW: source && source.width,
            srcH: source && source.height,
            setW: settings && settings.width,
            setH: settings && settings.height,
            setFps: settings && round(settings.frameRate, 1),
            // what is being captured: the whole screen, a window or a tab (they cost the browser very different amounts)
            surf: settings && ['monitor', 'window', 'browser'].includes(settings.displaySurface) ? settings.displaySurface : undefined,
            // what the encoder was told
            scale: encoding.scaleResolutionDownBy !== undefined ? round(encoding.scaleResolutionDownBy, 2) : undefined,
            maxKbps: typeof encoding.maxBitrate === 'number' ? round(encoding.maxBitrate / 1000) : undefined,
            maxFps: typeof encoding.maxFramerate === 'number' ? round(encoding.maxFramerate, 1) : undefined,
            degr: degradations.includes(parameters && parameters.degradationPreference) ? parameters.degradationPreference : undefined,
            hint: hints.includes(hint) ? hint : 'none',
            codec,
            // what loss costs and how the picture changed
            retx: bytes ? round((delta(s, before, 'retransmittedBytesSent') / bytes) * 100, 1) : undefined,
            huge: delta(s, before, 'hugeFramesSent'),
            qlr: delta(s, before, 'qualityLimitationResolutionChanges'),
            sendMs: packets ? round((delta(s, before, 'totalPacketSendDelay') / packets) * 1000, 1) : undefined,
        };
    }

    // One row for a stream this browser RECEIVES.
    function receiverRow({ s, before }) {
        if (!s || !before) return null;
        const seconds = (s.timestamp - before.timestamp) / 1000;
        if (!(seconds > 0)) return null;
        const received = delta(s, before, 'packetsReceived');
        const lost = delta(s, before, 'packetsLost');
        const buffered = delta(s, before, 'jitterBufferEmittedCount');
        const decoded = delta(s, before, 'framesDecoded');
        return {
            fps: round(decoded / seconds, 1),
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
            decMs: decoded ? round((delta(s, before, 'totalDecodeTime') / decoded) * 1000, 2) : undefined,
            pause: delta(s, before, 'pauseCount'),
            seconds,
        };
    }

    // How busy the encoder is: 1 = a whole core of encoding time for every second (it cannot go on past ~0.9 per thread)
    const encoderBusy = (row) => (row && row.encMs && row.fps ? (row.encMs * row.fps) / 1000 : 0);

    const stats = { round, delta, senderRow, receiverRow, encoderBusy };
    if (typeof module !== 'undefined' && module.exports) module.exports = stats;
    else root.StreamStats = stats;
})(typeof window !== 'undefined' ? window : globalThis);
