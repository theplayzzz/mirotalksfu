'use strict';

require('should');

const EventEmitter = require('node:events');
const { ReplayHub } = require('../../app/src/replay/ReplayHub');
const { ReplayAccess } = require('../../app/src/replay/ReplayAccess');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function fakes() {
    const emitted = [];
    const io = {
        to(target) {
            return {
                emit(event, data) {
                    emitted.push({ target, event, data });
                },
            };
        },
    };

    const access = new ReplayAccess({
        secret: 'a-secret-that-is-not-default',
        roomPassword: 'pass',
    });

    const client = {
        created: [],
        async createClip(req) {
            client.created.push(req);
            return {
                id: 'clip-123',
                shareId: req.shareId,
                seconds: req.seconds,
                durationS: req.seconds + 2,
                startOffsetS: 2,
                requestedByHash: req.requestedByHash,
                sharerHash: req.sharerHash,
                files: { original: { name: 'clip.webm' }, mp4: null },
            };
        },
    };

    const bridge = new EventEmitter();
    bridge.available = true;
    bridge.shares = [];
    bridge.list = () => bridge.shares;

    const peers = new Map();
    const room = {
        id: 'room-1',
        router: {},
        getPeers: () => [...peers.entries()],
    };

    return { io, access, client, bridge, room, peers, emitted };
}

describe('test-sfu-hub (room events and replay coordination)', () => {
    it('reports public config based on settings and bridge presence', () => {
        const f = fakes();
        const hub = new ReplayHub({
            io: f.io,
            access: f.access,
            client: f.client,
            getRoom: () => f.room,
            settings: { maxSeconds: 180, options: [60, 120, 180, 300], uiEnabled: true },
            log: silent,
        });

        hub.publicConfig().enabled.should.be.false(); // no bridge yet
        hub.attachBridge(f.bridge);
        hub.publicConfig().should.deepEqual({
            enabled: true,
            maxSeconds: 180,
            options: [60, 120, 180], // 300 filtered out because > 180
        });
    });

    it('issues a ticket and sends buffer status when a socket joins', () => {
        const f = fakes();
        const hub = new ReplayHub({
            io: f.io,
            access: f.access,
            client: f.client,
            getRoom: () => f.room,
            log: silent,
        });
        hub.attachBridge(f.bridge);

        const socketEvents = [];
        const socket = {
            id: 'sock-1',
            emit(event, data) {
                socketEvents.push({ event, data });
            },
            on() {},
        };

        hub.attachSocket(socket, f.room, { peer_name: 'Lucas' });

        socketEvents.map((e) => e.event).should.containDeep(['replayTicket', 'replayBuffers']);
        const ticketPayload = socketEvents.find((e) => e.event === 'replayTicket').data;
        f.access.consumeTicket(ticketPayload.ticket).should.be.true();
    });

    it('does its work once per socket, however many ways in the person came through', () => {
        // Whoever joined a locked room (the single room's way in) or waited in the lobby is attached from a later
        // request, not from the join: both paths call attachSocket, and only the first one counts.
        const f = fakes();
        const hub = new ReplayHub({ io: f.io, access: f.access, client: f.client, getRoom: () => f.room, log: silent });
        hub.attachBridge(f.bridge);

        const socketEvents = [];
        const handlers = [];
        const socket = {
            id: 'sock-2',
            emit(event, data) {
                socketEvents.push({ event, data });
            },
            on(event) {
                handlers.push(event);
            },
        };

        hub.attachSocket(socket, f.room, { peer_name: 'Friend' });
        hub.attachSocket(socket, f.room, { peer_name: 'Friend' });
        hub.attachSocket(socket, f.room, { peer_name: 'Friend' });

        socketEvents.filter((e) => e.event === 'replayTicket').should.have.length(1);
        socketEvents.filter((e) => e.event === 'replayBuffers').should.have.length(1);
        handlers.should.deepEqual(['replayRequest']);

        // another socket of the same person (a reconnection) is a new socket and gets its own
        const again = { id: 'sock-3', emit: (event, data) => socketEvents.push({ event, data }), on() {} };
        hub.attachSocket(again, f.room, { peer_name: 'Friend' });
        socketEvents.filter((e) => e.event === 'replayTicket').should.have.length(2);
    });

    it('rejects clip requests when replay is unavailable', async () => {
        const f = fakes();
        f.bridge.available = false;
        f.bridge.reason = 'busy';

        const hub = new ReplayHub({
            io: f.io,
            access: f.access,
            client: f.client,
            getRoom: () => f.room,
            log: silent,
        });
        hub.attachBridge(f.bridge);

        let err;
        try {
            await hub.requestClip({
                socket: { id: 's1' },
                room: f.room,
                peer: { peer_name: 'User' },
                producerId: 'p1',
                seconds: 60,
            });
        } catch (e) {
            err = e;
        }
        (!!err).should.be.true();
        err.code.should.equal('UNAVAILABLE');
    });

    it('validates clip requests and enforces 3-second rate limit', async () => {
        const f = fakes();
        f.bridge.shares = [{ shareId: 'screen-1', roomId: 'room-1', peerName: 'Sharer', peerUuid: 'u-sharer' }];
        let now = 10000;

        const hub = new ReplayHub({
            io: f.io,
            access: f.access,
            client: f.client,
            getRoom: () => f.room,
            log: silent,
            now: () => now,
        });
        hub.attachBridge(f.bridge);

        const socket = { id: 's1' };
        const peer = { peer_name: 'Lucas', peer_info: { peer_uuid: 'u-lucas' } };

        // Invalid seconds
        let badSec;
        try {
            await hub.requestClip({ socket, room: f.room, peer, producerId: 'screen-1', seconds: 5 });
        } catch (e) {
            badSec = e;
        }
        badSec.code.should.equal('BAD_SECONDS');

        // Valid request
        const res = await hub.requestClip({ socket, room: f.room, peer, producerId: 'screen-1', seconds: 60 });
        res.ok.should.be.true();
        (!!res.requestId).should.be.true();

        // Immediate second request -> rate limited
        let rateLimited;
        try {
            await hub.requestClip({ socket, room: f.room, peer, producerId: 'screen-1', seconds: 60 });
        } catch (e) {
            rateLimited = e;
        }
        rateLimited.code.should.equal('RATE_LIMIT');

        // After 3 seconds -> allowed
        now += 3001;
        const secondRes = await hub.requestClip({ socket, room: f.room, peer, producerId: 'screen-1', seconds: 60 });
        secondRes.ok.should.be.true();
    });

    it('routes incoming screen video and screen audio to the bridge', () => {
        const f = fakes();
        const hub = new ReplayHub({
            io: f.io,
            access: f.access,
            client: f.client,
            getRoom: () => f.room,
            log: silent,
        });

        const added = [];
        f.bridge.addScreen = (item) => added.push({ type: 'screen', ...item });
        f.bridge.addScreenAudio = (item) => added.push({ type: 'audio', ...item });
        hub.attachBridge(f.bridge);

        const videoProd = { id: 'v1', appData: { mediaType: 'screenType' } };
        const audioProd = { id: 'a1', appData: { mediaType: 'audioType', source: 'screen', shareOf: 'v1' } };
        const camProd = { id: 'c1', appData: { mediaType: 'webcamType' } };

        const peer = {
            peer_name: 'Lucas',
            peer_info: { peer_uuid: 'uuid-1' },
            producers: new Map([
                ['v1', videoProd],
                ['a1', audioProd],
                ['c1', camProd],
            ]),
        };

        hub.onProduce({ room: f.room, peer, producerId: 'c1', kind: 'video', appData: camProd.appData });
        added.length.should.equal(0); // webcam ignored

        hub.onProduce({ room: f.room, peer, producerId: 'v1', kind: 'video', appData: videoProd.appData });
        added.length.should.equal(1);
        added[0].type.should.equal('screen');

        hub.onProduce({ room: f.room, peer, producerId: 'a1', kind: 'audio', appData: audioProd.appData });
        added.length.should.equal(2);
        added[1].type.should.equal('audio');
        added[1].shareId.should.equal('v1');
    });
});
