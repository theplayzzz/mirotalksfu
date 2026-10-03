'use strict';

/*
 * Replay on the SFU side, as Server.js uses it: one call that builds everything and returns null when replay is off.
 *
 *   const replay = require('./replay').create({ io, singleRoom, jwtKey, getRoom, pageFile, log });
 *   app.use('/replay', replay.router); app.post('/internal/replay/events', replay.internalEvents);
 *   ... once the workers exist:   await replay.start({ mediasoup, mediaCodecs, workerSettings, roomWorkers });
 *   ... in the room code:         replay.hub.attachSocket(socket, room, peer); replay.hub.onProduce({...});
 *
 * Settings (environment): REPLAY_ENABLED=true, REPLAY_UI_ENABLED (default true), REPLAY_RECORDER_URL,
 * REPLAY_INTERNAL_SECRET (24+ characters), REPLAY_DATA_DIR, REPLAY_MAX_SECONDS, REPLAY_RETENTION_DAYS,
 * REPLAY_PORT_MIN/MAX, REPLAY_PIPE_PORT_MIN/MAX, REPLAY_BIND_IP, REPLAY_MIN_FREE_GB, RECORDER_KEYFRAME_SAFETY_S.
 * It stays off, with a line in the log, when the secrets are missing or are the defaults.
 */

const { ReplayAccess } = require('./ReplayAccess');
const { ReplayClient } = require('./ReplayClient');
const { ReplayBridge } = require('./ReplayBridge');
const { ReplayHub } = require('./ReplayHub');
const { createReplayRouter, createInternalEventsHandler } = require('./ReplayRoutes');

const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

function create({ io, singleRoom, jwtKey, getRoom, pageFile, log = console, env = process.env }) {
    if (env.REPLAY_ENABLED !== 'true') return null;

    // The gallery is open to the people of ONE room, who all know its password: with many rooms there would be no
    // single answer to "who may see these clips"
    if (!singleRoom.enabled) {
        log.error('replay: it needs the single room setup (SINGLE_ROOM_ID and SINGLE_ROOM_PASSWORD). Replay stays off.');
        return null;
    }

    const secret = env.REPLAY_INTERNAL_SECRET || '';
    const url = env.REPLAY_RECORDER_URL || '';
    if (secret.length < 24 || !url) {
        log.error('replay: REPLAY_ENABLED needs REPLAY_RECORDER_URL and a REPLAY_INTERNAL_SECRET of at least 24 characters. Replay stays off.');
        return null;
    }

    let access;
    try {
        access = new ReplayAccess({ secret: jwtKey, roomPassword: singleRoom.password });
    } catch (error) {
        log.error(`replay: ${error.message}. Replay stays off.`);
        return null;
    }

    const maxSeconds = number(env.REPLAY_MAX_SECONDS, 300, 10, 1800);
    const client = new ReplayClient({ baseUrl: url, secret });
    const hub = new ReplayHub({
        io,
        access,
        client,
        getRoom,
        log,
        settings: { maxSeconds, uiEnabled: env.REPLAY_UI_ENABLED !== 'false' },
    });
    const router = createReplayRouter({
        hub,
        access,
        client,
        singleRoom,
        pageFile,
        dataDir: env.REPLAY_DATA_DIR || '/data/replays',
        retentionDays: number(env.REPLAY_RETENTION_DAYS, 7, 1, 365),
        log,
    });
    const internalEvents = createInternalEventsHandler({ hub, secret });

    const service = {
        hub,
        access,
        client,
        router,
        internalEvents,
        bridge: null,
        publicConfig: () => hub.publicConfig(),

        // The bridge needs the mediasoup workers, which exist a moment after the routes were registered
        async start({ mediasoup, mediaCodecs, workerSettings, roomWorkers }) {
            const bridge = new ReplayBridge({
                mediasoup,
                mediaCodecs,
                workerSettings,
                client,
                roomWorkers,
                log,
                options: {
                    bindIp: env.REPLAY_BIND_IP || undefined,
                    portMin: number(env.REPLAY_PORT_MIN, 52000, 1024, 65000),
                    portMax: number(env.REPLAY_PORT_MAX, 52999, 1024, 65535),
                    pipePortMin: number(env.REPLAY_PIPE_PORT_MIN, 51000, 1024, 65000),
                    pipePortMax: number(env.REPLAY_PIPE_PORT_MAX, 51999, 1024, 65535),
                    minFreeGb: number(env.REPLAY_MIN_FREE_GB, 10, 0, 100000),
                    keyFrameSafetyS: number(env.RECORDER_KEYFRAME_SAFETY_S, 0, 0, 600),
                },
            });
            try {
                await bridge.start();
            } catch (error) {
                log.error(`replay: the bridge could not start (${error.message}). Replay stays off.`);
                return;
            }
            service.bridge = bridge;
            hub.attachBridge(bridge);
        },

        async stop() {
            await hub.stop();
            if (service.bridge) await service.bridge.stop();
        },
    };
    return service;
}

module.exports = { create };
