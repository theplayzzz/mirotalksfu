'use strict';

require('should');

const fs = require('node:fs');
const path = require('node:path');
const sinon = require('sinon');

const { FrameStore, readRecords, KIND_VIDEO, KIND_AUDIO } = require('../../app/src/replay/FrameStore');
const gen = require('./lib/gen');
const media = require('./lib/media');

const T0 = 1791036902000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readAll(snapshot) {
    const records = [];
    for (const chunk of snapshot.chunks) {
        for await (const record of readRecords(chunk.path, 0, chunk.bytes))
            records.push({ ...record, data: Buffer.from(record.data) });
    }
    return records;
}

/** Appends `seconds` of synthetic media in time order: video at fps (key frame every keyEvery s) and 20 ms audio. */
function feed(store, { seconds, from = 0, fps = 10, keyEvery = 2, videoBytes = 1000, keyBytes = 6000, audio = true }) {
    const frames = [];
    for (let t = 0; t < seconds * 1000; t += 1000 / fps) {
        const key = Math.round(t + from * 1000) % (keyEvery * 1000) === 0;
        frames.push({ t, kind: KIND_VIDEO, key, data: gen.patterned(key ? keyBytes : videoBytes, Math.round(t) + 1) });
    }
    if (audio)
        for (let t = 0; t < seconds * 1000; t += 20)
            frames.push({ t: t + 0.5, kind: KIND_AUDIO, key: true, data: gen.patterned(60, t + 7) });
    frames.sort((a, b) => a.t - b.t);
    for (const frame of frames) store.append(frame.kind, frame.key, T0 + from * 1000 + Math.floor(frame.t), frame.data);
}

describe('replay: FrameStore (the ring on disk)', () => {
    let dir;
    let store;

    beforeEach(() => {
        dir = media.tmpDir('replay-store-');
    });

    afterEach(async () => {
        sinon.restore();
        if (store) await store.close();
        store = null;
        media.rmDir(dir);
    });

    function create(options = {}) {
        store = new FrameStore({
            dir: path.join(dir, 'share1'),
            retainMs: 60000,
            chunkMs: 10000,
            flushIntervalMs: 20,
            holdMs: 100,
            ...options,
        });
        return store;
    }

    it('writes records that read back identically, chunk after chunk', async () => {
        create({ retainMs: 600000 });
        await store.open();
        const sent = [];
        for (let i = 0; i < 300; i++) {
            const kind = i % 3 === 0 ? KIND_AUDIO : KIND_VIDEO;
            const data = gen.patterned(100 + ((i * 37) % 900), i + 1);
            sent.push({ kind, key: i % 30 === 1 && kind === KIND_VIDEO, ts: T0 + i * 100, data });
            store.append(kind, sent[i].key, sent[i].ts, data);
        }
        const snapshot = await store.snapshot();
        snapshot.chunks.length.should.equal(3); // 30 s of media time in chunks of 10 s
        const read = await readAll(snapshot);
        read.should.have.length(300);
        read.forEach((record, i) => {
            record.kind.should.equal(sent[i].kind);
            record.key.should.equal(sent[i].key);
            record.ts.should.equal(sent[i].ts);
            record.data.equals(sent[i].data).should.be.true();
        });
        snapshot.release();
    });

    it('indexes the key frames with the byte offset of their record', async () => {
        create({ retainMs: 600000 });
        await store.open();
        feed(store, { seconds: 25 });
        const snapshot = await store.snapshot();
        const keys = snapshot.chunks.flatMap((c) => c.keys.map((k) => ({ chunk: c, ...k })));
        keys.map((k) => k.ts - T0).should.deepEqual(Array.from({ length: 13 }, (_, i) => i * 2000));
        for (const key of keys) {
            const [first] = await collect(readRecords(key.chunk.path, key.off, key.end));
            first.key.should.be.true();
            first.kind.should.equal(KIND_VIDEO);
            first.ts.should.equal(key.ts);
        }
        snapshot.release();
    });

    it('sorts video and audio by media time in a small hold-back, so the log is in time order', async () => {
        create({ holdMs: 500 });
        await store.open();
        // the audio of an instant arrives first, the video 150 ms later (a frame takes time to complete)
        let video = 0;
        for (let i = 0; i < 40; i++) {
            const ts = T0 + i * 20;
            store.append(KIND_AUDIO, true, ts, gen.patterned(40, i));
            while (video < 6 && T0 + video * 100 + 150 <= ts) {
                store.append(KIND_VIDEO, video === 0, T0 + video * 100, gen.patterned(300, 100 + video));
                video++;
            }
        }
        const snapshot = await store.snapshot();
        const records = await readAll(snapshot);
        records.length.should.equal(40 + video);
        for (let i = 1; i < records.length; i++) records[i].ts.should.not.be.below(records[i - 1].ts);
        records[0].ts.should.equal(T0);
        records[0].kind.should.equal(KIND_AUDIO); // same instant, the first one written wins the tie
        records[1].kind.should.equal(KIND_VIDEO);
        records[1].key.should.be.true();
        snapshot.release();
    });

    it('keeps the ring inside its limit: old chunks are deleted, the number of files and bytes stay bounded', async () => {
        create({ retainMs: 30000, chunkMs: 10000 });
        await store.open();
        let maxChunks = 0;
        let maxBytes = 0;
        for (let second = 0; second < 300; second += 5) {
            feed(store, { seconds: 5, from: second });
            await sleep(1);
            const d = store.describe();
            maxChunks = Math.max(maxChunks, d.chunks);
            maxBytes = Math.max(maxBytes, d.bytes);
        }
        await store.flush();
        await sleep(100); // deletions are asynchronous
        // 30 s retained + the chunk being written + the one about to be dropped: at most 5 chunks
        maxChunks.should.be.below(6);
        const bytesPerSecond = 10 * 1000 + 6000 / 2 + 50 * 60 + 17 * 16 * 3;
        maxBytes.should.be.below(bytesPerSecond * 55);
        const files = fs.readdirSync(path.join(dir, 'share1')).filter((f) => f.endsWith('.log'));
        files.length.should.equal(store.describe().chunks);
        files.length.should.be.below(6);
        const d = store.describe();
        (d.newestTs - d.oldestKeyTs).should.be.within(30000, 42000);
        // the oldest chunk still starts inside the retention window
        const snapshot = await store.snapshot();
        (snapshot.newestTs - snapshot.chunks[0].startTs).should.be.below(30000 + 10000 + 1000);
        snapshot.release();
    });

    it('keeps a chunk that a clip build is reading until it is released', async () => {
        create({ retainMs: 15000, chunkMs: 10000 });
        await store.open();
        feed(store, { seconds: 12 });
        const snapshot = await store.snapshot();
        const first = snapshot.chunks[0].path;
        store.pinCount.should.be.above(0);
        feed(store, { seconds: 60, from: 12 }); // pushes the first chunk out of the ring
        await store.flush();
        await sleep(50);
        store.describe().chunks.should.be.below(snapshot.chunks.length + 6);
        fs.existsSync(first).should.be.true();
        // still readable
        const records = await readAll({ chunks: [snapshot.chunks[0]] });
        records.length.should.be.above(10);
        snapshot.release();
        snapshot.release(); // twice is harmless
        await sleep(100);
        fs.existsSync(first).should.be.false();
        store.pinCount.should.equal(0);
    });

    it('tracks the audio ranges and what a clip can cover', async () => {
        create({ retainMs: 600000 });
        await store.open();
        // video 20 s, audio only from 5 s to 8 s and from 15 s on
        feed(store, { seconds: 20, audio: false });
        for (let t = 5000; t < 8000; t += 20) store.append(KIND_AUDIO, true, T0 + t, gen.patterned(40, t));
        for (let t = 15000; t < 20000; t += 20) store.append(KIND_AUDIO, true, T0 + t, gen.patterned(40, t));
        const snapshot = await store.snapshot();
        snapshot.audioRanges.should.deepEqual([
            { from: T0 + 5000, to: T0 + 7980 },
            { from: T0 + 15000, to: T0 + 19980 },
        ]);
        const d = store.describe();
        d.oldestKeyTs.should.equal(T0);
        d.availableMs.should.be.approximately(19900, 100);
        snapshot.release();
    });

    it('handles a frame larger than the write batch', async () => {
        create({ stagingBytes: 4096 });
        await store.open();
        const huge = gen.patterned(300000, 5);
        store.append(KIND_VIDEO, true, T0, huge);
        store.append(KIND_VIDEO, false, T0 + 33, gen.patterned(100, 6));
        const snapshot = await store.snapshot();
        const records = await readAll(snapshot);
        records.should.have.length(2);
        records[0].data.equals(huge).should.be.true();
        snapshot.release();
    });

    it('drops frames instead of growing its memory when the disk falls behind', async () => {
        create({ maxQueuedBytes: 200000, holdMs: 0 });
        await store.open();
        const stuck = [];
        sinon.stub(fs, 'write').callsFake((fd, buf, off, len, pos, cb) => stuck.push(() => cb(null, len))); // the disk never answers
        let accepted = 0;
        for (let i = 0; i < 400; i++) {
            if (store.append(KIND_VIDEO, i === 0, T0 + i * 10, gen.patterned(5000, i))) accepted++;
            if (i % 20 === 0) await sleep(30); // let the flush timer hand batches to the (stuck) writes
        }
        accepted.should.be.below(400);
        store.stats.droppedOverload.should.be.above(0);
        sinon.restore();
        stuck.forEach((complete) => complete()); // the disk comes back and the queue drains
    });

    it('survives a disk error: it drops what it cannot write, never throws, and retries with a new chunk', async () => {
        let clock = Date.now();
        create({ chunkMs: 100000, now: () => clock });
        await store.open();
        const original = fs.open;
        sinon.stub(fs, 'open').callsFake((file, flags, cb) => setImmediate(cb, new Error('ENOSPC: no space left')));
        store.append(KIND_VIDEO, true, T0, gen.patterned(1000, 1));
        store.append(KIND_VIDEO, false, T0 + 33, gen.patterned(1000, 2));
        const failed = await store.snapshot(); // must not hang
        failed.chunks.should.have.length(0); // nothing usable
        failed.release();
        store.stats.writeErrors.should.equal(1);
        store.append(KIND_VIDEO, false, T0 + 66, gen.patterned(1000, 3)); // dropped while the error is fresh
        (await store.snapshot()).release();
        store.stats.dropped.should.be.above(0);
        sinon.restore();
        fs.open.should.equal(original);
        // a few seconds later the disk is fine again: the next frames go to a new chunk
        clock += 6000;
        store.append(KIND_VIDEO, true, T0 + 10000, gen.patterned(1000, 4));
        store.append(KIND_VIDEO, false, T0 + 10033, gen.patterned(1000, 5));
        const recovered = await store.snapshot();
        recovered.chunks.should.have.length(1);
        (await readAll(recovered)).should.have.length(2);
        recovered.release();
    });

    it('writes a small index.json describing the share and its chunks', async () => {
        create({ info: { shareId: 'abc', roomId: 'link', codec: 'vp8' }, retainMs: 600000 });
        await store.open();
        feed(store, { seconds: 15 });
        await store.close();
        const index = JSON.parse(fs.readFileSync(path.join(dir, 'share1', 'index.json'), 'utf8'));
        index.shareId.should.equal('abc');
        index.closed.should.be.true();
        index.chunks.length.should.equal(2);
        index.chunks[0].file.should.equal('00000001.log');
    });

    it('destroy removes the buffer from the disk', async () => {
        create();
        await store.open();
        feed(store, { seconds: 3 });
        await store.destroy();
        fs.existsSync(path.join(dir, 'share1')).should.be.false();
        store.append(KIND_VIDEO, true, T0, Buffer.alloc(10)).should.be.false(); // closed stores take nothing
    });

    it('reads records that straddle the read buffer boundaries', async () => {
        create({ retainMs: 600000 });
        await store.open();
        const sent = [];
        for (let i = 0; i < 200; i++) {
            const data = gen.patterned(500 + i * 13, i);
            sent.push(data);
            store.append(KIND_VIDEO, i === 0, T0 + i * 10, data);
        }
        const snapshot = await store.snapshot();
        const chunk = snapshot.chunks[0];
        for (const readSize of [64, 1000, 4096, 100000]) {
            const records = await collect(readRecords(chunk.path, 0, chunk.bytes, { readSize }));
            records.length.should.equal(sent.length);
            records.every((r, i) => r.data.equals(sent[i])).should.be.true(`readSize ${readSize}`);
        }
        snapshot.release();
    });
});

async function collect(iterator) {
    const out = [];
    for await (const item of iterator) out.push({ ...item, data: Buffer.from(item.data) });
    return out;
}
