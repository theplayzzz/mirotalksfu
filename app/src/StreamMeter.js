'use strict';

/*
 * What the SERVER sees of every stream, next to what the browsers report (HealthMeter.js).
 *
 * Every few seconds, for each screen that is being shared: how it arrives at the server (bitrate, loss, round trip,
 * mediasoup's own score of the stream), and for every person receiving it what the server sends them (bitrate, the
 * layer, the score, whether it is paused); and the load of every mediasoup worker. The records go into the same daily
 * file as the browsers' reports, with kind "srv". Read together they tell where a bad stream goes bad:
 *   - the screen already arrives badly at the server (producer score low): the sender's capture, CPU or uplink;
 *   - it arrives well and goes badly to some people only (consumer score low): their downlink or their PC;
 *   - everything is bad at once while a worker is busy: the server.
 * Names are the ones the health meter already keeps. mediasoup is asked for statistics only, so this costs a few
 * messages to the workers every interval, and never touches the media.
 */

const Logger = require('./Logger');
const log = new Logger('StreamMeter');

const round = (v, d = 0) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

// The one statistics entry of a producer or consumer that describes the media (not the retransmission stream)
function mainStat(stats) {
    if (!Array.isArray(stats)) return null;
    return stats.find((s) => s && (s.type === 'inbound-rtp' || s.type === 'outbound-rtp') && !s.isRtx) || stats[0] || null;
}

class StreamMeter {
    /**
     * @param {object} options
     * @param {object} options.meter        the HealthMeter (write, enabled, intervalS)
     * @param {() => Map} options.rooms     the rooms of the server (a Map of Room)
     * @param {() => Array} options.workers the mediasoup workers
     */
    constructor({ meter, rooms, workers }) {
        this.meter = meter;
        this.rooms = rooms;
        this.workers = workers;
        this.timer = null;
        this.busy = false;
        this.lastUsage = new Map(); // worker pid -> { at, cpuMs }
    }

    start() {
        if (this.timer || !this.meter || !this.meter.enabled) return;
        this.timer = setInterval(() => this.tick().catch(() => {}), this.meter.intervalS * 1000);
        this.timer.unref();
        log.info('Stream meter enabled', { intervalS: this.meter.intervalS });
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    // The load of each mediasoup worker over the last interval, as a share of one core
    async workerLoad(now) {
        const out = [];
        for (const worker of this.workers() || []) {
            try {
                const usage = await worker.getResourceUsage();
                // ru_utime and ru_stime are in milliseconds of CPU time since the worker started
                const cpuMs = (usage.ru_utime || 0) + (usage.ru_stime || 0);
                const before = this.lastUsage.get(worker.pid);
                this.lastUsage.set(worker.pid, { at: now, cpuMs });
                if (before && now > before.at) out.push({ pid: worker.pid, cpu: round(((cpuMs - before.cpuMs) / (now - before.at)) * 100, 1) });
            } catch (error) {
                // a worker that is gone
            }
        }
        return out;
    }

    async tick(now = Date.now()) {
        if (this.busy || !this.meter.enabled) return;
        this.busy = true;
        try {
            const workers = await this.workerLoad(now);
            const producers = [];
            const consumers = [];
            for (const [roomId, room] of this.rooms()) {
                for (const peer of room.peers.values()) {
                    const peerName = peer.peer_name ?? peer.peer_info?.peer_name;
                    // the screens this person sends
                    for (const [id, producer] of peer.producers) {
                        if (producer.kind !== 'video' || producer.closed) continue;
                        const stat = mainStat(await producer.getStats().catch(() => null));
                        producers.push({
                            room: roomId,
                            peer: peerName,
                            id: String(id).slice(0, 8),
                            type: producer.appData?.mediaType || undefined,
                            codec: producer.rtpParameters?.codecs?.[0]?.mimeType?.replace('video/', ''),
                            score: round(stat?.score, 0),
                            kbps: round((stat?.bitrate || 0) / 1000),
                            loss: round((stat?.fractionLost || 0) / 2.56, 1), // fractionLost is 0-255
                            rtt: round(stat?.roundTripTime, 0),
                            jit: round((stat?.jitter || 0) / 90, 1), // in ms: video jitter is counted in 90 kHz ticks
                            nack: stat?.nackCount,
                            pli: stat?.pliCount,
                            paused: producer.paused || undefined,
                        });
                    }
                    // what is sent to this person
                    for (const [, consumer] of peer.consumers) {
                        if (consumer.kind !== 'video' || consumer.closed) continue;
                        const stat = mainStat(await consumer.getStats().catch(() => null));
                        const layers = consumer.currentLayers;
                        consumers.push({
                            room: roomId,
                            to: peerName,
                            of: String(consumer.producerId).slice(0, 8),
                            score: round(consumer.score?.score, 0),
                            pscore: round(consumer.score?.producerScore, 0),
                            kbps: round((stat?.bitrate || 0) / 1000),
                            lay: layers ? `${layers.spatialLayer ?? 0}/${layers.temporalLayer ?? 0}` : undefined,
                            paused: consumer.paused || undefined,
                            loss: round((stat?.fractionLost || 0) / 2.56, 1),
                        });
                    }
                }
            }
            if (producers.length || consumers.length) {
                this.meter.write({ kind: 'srv', workers, producers, consumers }, now);
            }
        } finally {
            this.busy = false;
        }
    }
}

module.exports = StreamMeter;
module.exports.mainStat = mainStat;
