'use strict';

/**
 * Maps the RTP timestamps of one stream to a wall clock (Unix milliseconds), so the video and the audio of a share
 * land on one common timeline.
 *
 * The map is `wall = rtpMs + offset`, where rtpMs is the unwrapped RTP timestamp in milliseconds. The offset comes
 * from the RTCP Sender Reports (NTP time <-> RTP timestamp pairs). Until the first report there is no way to know it
 * and the offset is estimated from the arrival time of the frames instead.
 *
 * Both sources are noisy in one direction only: a packet never arrives early, so `arrival - rtpMs` is the true offset
 * plus a delay that is zero at best. The Sender Reports of mediasoup are built the same way (they pair the arrival
 * time of the latest packet with its RTP timestamp). The estimate is therefore the MINIMUM of the recent samples,
 * which discards the jittery ones; a window of a few reports follows a drifting sender clock closely enough.
 *
 * The offset in use moves toward the estimate at a limited speed (maxSlew, 2% by default), which guarantees that
 * the converted timestamps of one stream keep increasing: two frames 20 ms apart can never be turned around by a
 * change of the estimate.
 */

const MAX_NTP_DISTANCE_MS = 24 * 3600 * 1000;

class ClockMap {
    /**
     * @param {object} options
     * @param {number} options.clockRate RTP clock rate (90000 video, 48000 opus)
     * @param {number} [options.maxSlew] fraction of elapsed time the offset may move per second (0.02 = 20 ms/s)
     * @param {number} [options.srWindow] number of Sender Reports the minimum is taken over
     * @param {number} [options.arrivalWindowMs] time window of the arrival-based estimate
     */
    constructor(options) {
        this.clockRate = options.clockRate;
        this.maxSlew = options.maxSlew ?? 0.02;
        this.srWindow = options.srWindow ?? 8;
        this.arrivalWindowMs = options.arrivalWindowMs ?? 5000;
        this.mode = 'none'; // 'none' | 'arrival' | 'sr'
        this.srOffsets = [];
        this.srCount = 0;
        this.srRejected = 0;
        this.arrivalTimes = [];
        this.arrivalValues = [];
        this.arrivalHead = 0;
        this.applied = null;
        this.appliedAt = 0;
    }

    /** RTP timestamp (unwrapped) to milliseconds on the RTP clock. */
    rtpMs(rtpExt) {
        return (rtpExt * 1000) / this.clockRate;
    }

    get ready() {
        return this.mode !== 'none';
    }

    /**
     * Records a Sender Report: at NTP time ntpMs the stream was at RTP timestamp rtpExt.
     * @returns {boolean} false when the report was refused (its clock is nowhere near the local one)
     */
    observeSenderReport(rtpExt, ntpMs, nowMs) {
        if (ntpMs === null || !Number.isFinite(ntpMs) || Math.abs(ntpMs - nowMs) > MAX_NTP_DISTANCE_MS) {
            this.srRejected++;
            return false;
        }
        this.srOffsets.push(ntpMs - this.rtpMs(rtpExt));
        if (this.srOffsets.length > this.srWindow) this.srOffsets.shift();
        this.srCount++;
        this.mode = 'sr';
        return true;
    }

    /** Records that the frame with RTP timestamp rtpExt arrived (its first packet) at arrivalMs. */
    observeArrival(rtpExt, arrivalMs) {
        const value = arrivalMs - this.rtpMs(rtpExt);
        const times = this.arrivalTimes;
        const values = this.arrivalValues;
        // Monotonic queue: an older sample that is not smaller than this one can never be the minimum again.
        while (values.length > this.arrivalHead && values[values.length - 1] >= value) {
            values.pop();
            times.pop();
        }
        times.push(arrivalMs);
        values.push(value);
        while (this.arrivalHead < times.length && times[this.arrivalHead] < arrivalMs - this.arrivalWindowMs) {
            this.arrivalHead++;
        }
        if (this.arrivalHead > 1024) {
            times.splice(0, this.arrivalHead);
            values.splice(0, this.arrivalHead);
            this.arrivalHead = 0;
        }
    }

    /**
     * Gives up waiting for a Sender Report and falls back to the arrival times seen so far.
     * @returns {boolean} false when there is nothing to estimate from
     */
    useArrival() {
        if (this.mode === 'sr') return true;
        if (this.arrivalValues.length <= this.arrivalHead) return false;
        this.mode = 'arrival';
        return true;
    }

    _target() {
        if (this.mode === 'sr') return Math.min(...this.srOffsets);
        return this.arrivalValues[this.arrivalHead];
    }

    /**
     * Wall clock time (ms) of an RTP timestamp. Must be called with a non-decreasing nowMs.
     * @param {number} rtpExt unwrapped RTP timestamp
     * @param {number} nowMs local clock, used to limit the speed at which the offset changes
     */
    toWallMs(rtpExt, nowMs) {
        const target = this._target();
        if (this.applied === null) {
            this.applied = target;
        } else {
            const maxStep = Math.max(0, nowMs - this.appliedAt) * this.maxSlew;
            const diff = target - this.applied;
            this.applied += Math.abs(diff) <= maxStep ? diff : Math.sign(diff) * maxStep;
        }
        this.appliedAt = nowMs;
        return this.rtpMs(rtpExt) + this.applied;
    }
}

module.exports = { ClockMap };
