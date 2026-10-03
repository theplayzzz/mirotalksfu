'use strict';

require('should');

const StreamMeter = require('../app/src/StreamMeter');
const { flagsOf } = require('../app/src/BuildInfo');

// What the server sees of every stream, next to what the browsers report: the records that tell where a bad stream goes bad.
describe('test-StreamMeter (the server\'s own view of the streams)', () => {
    const written = [];
    const meter = { enabled: true, intervalS: 10, write: (record, at) => written.push({ record, at }) };

    const producer = (id, overrides = {}) => ({
        id,
        kind: 'video',
        closed: false,
        paused: false,
        appData: { mediaType: 'screenType' },
        rtpParameters: { codecs: [{ mimeType: 'video/VP8' }] },
        getStats: async () => [{ type: 'inbound-rtp', score: 9, bitrate: 7_100_000, fractionLost: 31, roundTripTime: 980, jitter: 900, nackCount: 120, pliCount: 6 }],
        ...overrides,
    });
    const consumer = (producerId, overrides = {}) => ({
        producerId,
        kind: 'video',
        closed: false,
        paused: false,
        score: { score: 6, producerScore: 9 },
        currentLayers: { spatialLayer: 0, temporalLayer: 1 },
        getStats: async () => [{ type: 'outbound-rtp', bitrate: 3_400_000, fractionLost: 3 }],
        ...overrides,
    });
    const peer = (name, producers = [], consumers = []) => ({
        peer_name: name,
        producers: new Map(producers.map((p) => [p.id, p])),
        consumers: new Map(consumers.map((c, i) => [`c${i}`, c])),
    });
    const worker = (pid, ms) => ({ pid, getResourceUsage: async () => ({ ru_utime: ms, ru_stime: 0 }) });

    beforeEach(() => (written.length = 0));

    it('records, for a screen, how it arrives at the server (score, bitrate, loss in %, round trip, jitter in ms)', async () => {
        const rooms = new Map([['link', { peers: new Map([['p1', peer('Sender', [producer('0123456789abcdef')])]]) }]]);
        const sm = new StreamMeter({ meter, rooms: () => rooms, workers: () => [] });
        await sm.tick(1_000_000);

        written.should.have.length(1);
        const { record, at } = written[0];
        at.should.equal(1_000_000);
        record.kind.should.equal('srv');
        JSON.parse(JSON.stringify(record.producers[0])).should.deepEqual({
            room: 'link', peer: 'Sender', id: '01234567', type: 'screenType', codec: 'VP8',
            score: 9, kbps: 7100, loss: 12.1, rtt: 980, jit: 10, nack: 120, pli: 6,
        });
    });

    it('records, for each person receiving it, what the server sends them: the layer, the score of the stream and of its source', async () => {
        const rooms = new Map([['link', { peers: new Map([['p1', peer('Viewer', [], [consumer('abcdef0123456789'), consumer('feedfeedfeed', { paused: true, currentLayers: undefined })])]]) }]]);
        const sm = new StreamMeter({ meter, rooms: () => rooms, workers: () => [] });
        await sm.tick(1_000_000);

        const consumers = JSON.parse(JSON.stringify(written[0].record.consumers));
        consumers[0].should.deepEqual({ room: 'link', to: 'Viewer', of: 'abcdef01', score: 6, pscore: 9, kbps: 3400, lay: '0/1', loss: 1.2 });
        consumers[1].paused.should.be.true();
        (consumers[1].lay === undefined).should.be.true();
    });

    it('records the load of every mediasoup worker as a share of one core, from two readings', async () => {
        const rooms = new Map([['link', { peers: new Map([['p1', peer('S', [producer('aaaaaaaaaaaa')])]]) }]]);
        let ms = 0;
        const w = { pid: 38, getResourceUsage: async () => ({ ru_utime: ms, ru_stime: 0 }) };
        const sm = new StreamMeter({ meter, rooms: () => rooms, workers: () => [w] });
        ms = 1000;
        await sm.tick(10_000); // the first reading: nothing to compare with yet
        written[0].record.workers.should.deepEqual([]);
        ms = 4500; // 3.5 s of CPU in the next 10 s
        await sm.tick(20_000);
        written[1].record.workers.should.deepEqual([{ pid: 38, cpu: 35 }]);
    });

    it('leaves out audio, closed streams and rooms with nothing to say, and does not break when mediasoup refuses', async () => {
        const rooms = new Map([
            ['empty', { peers: new Map() }],
            ['link', { peers: new Map([['p1', peer('S', [producer('aaaaaaaaaaaa', { kind: 'audio' }), producer('bbbbbbbbbbbb', { closed: true }), producer('cccccccccccc', { getStats: async () => { throw new Error('gone'); } })], [consumer('x', { kind: 'audio' })])]]) }],
        ]);
        const sm = new StreamMeter({ meter, rooms: () => rooms, workers: () => [worker(1, 5)] });
        await sm.tick(1_000_000);
        written[0].record.producers.should.have.length(1); // the one whose statistics could not be read is still listed, without numbers
        (written[0].record.producers[0].kbps === 0).should.be.true();
        written[0].record.consumers.should.have.length(0);
    });

    it('writes nothing when there is nobody sharing, and one tick at a time', async () => {
        const sm = new StreamMeter({ meter, rooms: () => new Map(), workers: () => [] });
        await sm.tick(1_000_000);
        written.should.have.length(0);
        let release;
        const slow = { peers: new Map([['p1', peer('S', [producer('dddddddddddd', { getStats: () => new Promise((r) => (release = r)) })])]]) };
        const busy = new StreamMeter({ meter, rooms: () => new Map([['link', slow]]), workers: () => [] });
        const first = busy.tick(1);
        await busy.tick(2); // refused: the first has not finished
        release([{ type: 'inbound-rtp' }]);
        await first;
        written.should.have.length(1);
    });
});

describe('test-BuildInfo (which switches are on, in one line)', () => {
    it('lists the switches that change what a person sees, with their defaults', () => {
        flagsOf({}).should.equal('sel=off kfd=0 replay=0 codec=vp8 layers=1 guard=off pause=0');
    });

    it('says how the production of 03/10 was set up, and the new modes', () => {
        flagsOf({ SELECTIVE_RECEPTION: 'true', KEYFRAME_REQUEST_DELAY_MS: '1000', REPLAY_ENABLED: 'true' }).should.equal('sel=adaptive kfd=1000 replay=1 codec=vp8 layers=1 guard=off pause=0');
        flagsOf({ SELECTIVE_RECEPTION: 'true', SELECTIVE_MODE: 'tile' }).should.equal('sel=tile kfd=0 replay=0 codec=vp8 layers=1 guard=off pause=0');
        flagsOf({ SELECTIVE_RECEPTION: 'true', SELECTIVE_MODE: 'adaptive', SEND_GUARD: 'observe', SCREEN_CODEC: 'vp9' }).should.equal('sel=adaptive kfd=0 replay=0 codec=vp9 layers=1 guard=observe pause=0');
    });

    it('ignores values it does not know', () => {
        flagsOf({ SELECTIVE_RECEPTION: 'true', SELECTIVE_MODE: '<x>', SEND_GUARD: 'maybe', SCREEN_CODEC: 'mpeg' }).should.equal('sel=adaptive kfd=0 replay=0 codec=vp8 layers=1 guard=off pause=0');
    });
});
