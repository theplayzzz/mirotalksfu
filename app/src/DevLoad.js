'use strict';

/*
 * Development-only load generator.
 *
 * To know what the room costs the server with many viewers, without ten browsers: for every virtual viewer it
 * makes a plain transport on the room's router (SRTP on, so the encryption cost is paid like for a browser) and
 * consumes the screens that are being shared, a chosen layer for each, sending to a port where nobody listens.
 * It measures the CPU of the room's mediasoup worker (one core, the thing that saturates) and the traffic.
 *
 * Only reachable with APP_ENV=dev and DEV_LOAD_ENABLED=true, with the token of the development test room.
 */

const crypto = require('node:crypto');
const { recorderCapabilities } = require('./replay/ReplayBridge');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function screenProducers(room) {
    const found = [];
    for (const peer of room.getPeers().values()) {
        for (const producer of peer.producers.values()) {
            if (producer.kind === 'video' && producer.appData && producer.appData.mediaType === 'screenType') {
                found.push(producer);
            }
        }
    }
    return found;
}

async function bytesSent(transports) {
    let total = 0;
    for (const transport of transports) {
        for (const stats of await transport.getStats()) total += stats.bytesSent || 0;
    }
    return total;
}

/*
 * viewers: virtual viewers; screens: screens each of them consumes (the shared screens are repeated if there are
 * fewer); layers: spatial layer of each screen of a viewer, for example [2, 0, 0, 0] = one in full size and three
 * small (only for screens sent in several sizes); temporal: frame-rate layer of each screen, [2, 0, 0, 0] = one at
 * the full frame rate and three at the lowest (screens sent in one size with L1T3 have it); paused: screens a
 * viewer does not look at, [false, true, true, true]; seconds: how long to measure.
 */
async function runLoad(room, { viewers = 10, screens = 4, layers = [], temporal = [], paused = [], seconds = 30 } = {}) {
    viewers = Math.min(40, Math.max(1, Math.floor(viewers)));
    screens = Math.min(12, Math.max(1, Math.floor(screens)));
    seconds = Math.min(120, Math.max(5, Math.floor(seconds)));

    const producers = screenProducers(room);
    if (!producers.length) throw new Error('Nobody is sharing a screen in this room');

    const transports = [];
    const consumers = [];
    try {
        for (let v = 0; v < viewers; v++) {
            const transport = await room.router.createPlainTransport({
                listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
                rtcpMux: true,
                comedia: false,
                enableSrtp: true,
            });
            await transport.connect({
                ip: '127.0.0.1',
                port: 9, // the discard port: nothing listens, the packets are dropped by the kernel
                srtpParameters: {
                    cryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
                    keyBase64: crypto.randomBytes(30).toString('base64'),
                },
            });
            transports.push(transport);

            for (let s = 0; s < screens; s++) {
                // Without bandwidth estimation, like the recorder's consumers: a plain transport that is told it takes part in
                // it keeps an estimate of 600 kbps that nothing raises (nobody sends feedback), and a screen of 11 Mbps
                // is then not forwarded at all (no layer fits), which made every number of this tool zero.
                const consumer = await transport.consume({
                    producerId: producers[s % producers.length].id,
                    rtpCapabilities: recorderCapabilities(room.router.rtpCapabilities),
                    paused: false,
                });
                const layer = layers[s];
                const frameRate = temporal[s];
                if (consumer.type === 'simulcast' && (Number.isInteger(layer) || Number.isInteger(frameRate))) {
                    await consumer.setPreferredLayers({
                        spatialLayer: Number.isInteger(layer) ? layer : 2,
                        temporalLayer: Number.isInteger(frameRate) ? frameRate : 2,
                    });
                } else if (consumer.type === 'svc' && Number.isInteger(frameRate)) {
                    await consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: frameRate });
                }
                if (paused[s] === true) await consumer.pause();
                consumers.push(consumer);
            }
        }

        await sleep(3000); // let the layers settle
        const startedAt = Date.now();
        const usageBefore = await room.worker.getResourceUsage();
        const bytesBefore = await bytesSent(transports);

        await sleep(seconds * 1000);

        const usageAfter = await room.worker.getResourceUsage();
        const bytesAfter = await bytesSent(transports);
        const wallMs = Date.now() - startedAt;

        // ru_utime / ru_stime: CPU time of the worker in milliseconds
        const cpuMs = usageAfter.ru_utime - usageBefore.ru_utime + (usageAfter.ru_stime - usageBefore.ru_stime);
        const layerNow = {};
        for (const consumer of consumers) {
            const current = consumer.currentLayers;
            const layer = consumer.paused ? 'paused' : current ? `${current.spatialLayer}/${current.temporalLayer ?? '-'}` : 'none';
            layerNow[layer] = (layerNow[layer] || 0) + 1;
        }

        return {
            viewers,
            screens,
            consumers: consumers.length,
            layersAsked: layers,
            temporalAsked: temporal,
            pausedAsked: paused,
            sharedScreens: producers.length,
            seconds: Math.round(wallMs / 100) / 10,
            workerCpuPercent: Math.round((cpuMs / wallMs) * 1000) / 10,
            sentMbps: Math.round(((bytesAfter - bytesBefore) * 8) / 1e5 / (wallMs / 1000)) / 10,
            sentMbpsPerViewer: Math.round(((bytesAfter - bytesBefore) * 8) / 1e5 / (wallMs / 1000) / viewers) / 10,
            currentLayers: layerNow,
        };
    } finally {
        for (const transport of transports) transport.close();
    }
}

module.exports = { runLoad };
