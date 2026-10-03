'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * The buffer of one share: the last minutes of its frames on disk, as a ring of chunk files.
 *
 *   <dir>/00000001.log, 00000002.log ...   frame log chunks of about chunkMs of media time each
 *   <dir>/index.json                        a small description (share info and the chunk list), for people
 *
 * A chunk is the recorder's own format, a plain sequence of records (little endian):
 *
 *   u8 kind (1 video, 2 audio) | u8 flags (bit 0: key frame) | u16 reserved | u32 length | f64 media time (ms) | bytes
 *
 * The index of the chunks and of their key frames lives in memory (the buffers do not survive a restart: the
 * recorder deletes them at startup). Nothing ever loads a whole buffer in memory: frames are copied into a staging
 * buffer of about 1 MB that is written asynchronously, one write at a time per chunk, and read back one chunk at a
 * time by the clip builder (see readRecords).
 *
 * - append() never blocks and never waits for the disk. When the writes fall too far behind (maxQueuedBytes) or the
 *   disk fails, frames are dropped and counted.
 * - A small hold-back (holdMs) sorts the frames of the video and the audio by media time before they are written, so
 *   the log is in time order and a clip can start reading at its first key frame without missing any audio.
 * - Chunks older than retainMs (relative to the newest frame) are deleted, except while a clip is being built from
 *   them (snapshot() pins them).
 */

const RECORD_HEADER = 16;
const KIND_VIDEO = 1;
const KIND_AUDIO = 2;
const MAX_RECORD = 64 * 1024 * 1024;
const AUDIO_RANGE_GAP_MS = 1000;

/** A binary min-heap of { ts, seq } items. */
class FrameHeap {
    constructor() {
        this.items = [];
        this.counter = 0;
    }

    get size() {
        return this.items.length;
    }

    peek() {
        return this.items[0];
    }

    push(item) {
        item.seq = this.counter++;
        const items = this.items;
        let i = items.length;
        items.push(item);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!this._less(item, items[parent])) break;
            items[i] = items[parent];
            i = parent;
        }
        items[i] = item;
    }

    pop() {
        const items = this.items;
        const top = items[0];
        const last = items.pop();
        if (items.length > 0) {
            let i = 0;
            const half = items.length >> 1;
            while (i < half) {
                let child = 2 * i + 1;
                if (child + 1 < items.length && this._less(items[child + 1], items[child])) child++;
                if (!this._less(items[child], last)) break;
                items[i] = items[child];
                i = child;
            }
            items[i] = last;
        }
        return top;
    }

    _less(a, b) {
        return a.ts < b.ts || (a.ts === b.ts && a.seq < b.seq);
    }
}

function chunkName(seq) {
    return `${String(seq).padStart(8, '0')}.log`;
}

class FrameStore {
    /**
     * @param {object} options
     * @param {string} options.dir directory of this buffer (created by open())
     * @param {number} options.retainMs how much media time to keep (buffer + lead-in)
     * @param {object} [options.info] share description written to index.json
     * @param {number} [options.chunkMs] media time per chunk file (10 s)
     * @param {number} [options.holdMs] hold-back that sorts frames by media time
     * @param {number} [options.flushIntervalMs] how often pending data is handed to the disk
     * @param {number} [options.stagingBytes] size of a write batch
     * @param {number} [options.maxQueuedBytes] memory allowed for data waiting for the disk
     * @param {object} [options.log]
     * @param {function} [options.now]
     */
    constructor(options) {
        this.dir = options.dir;
        this.retainMs = options.retainMs;
        this.info = options.info || {};
        this.chunkMs = options.chunkMs ?? 10000;
        this.holdMs = options.holdMs ?? 300;
        this.flushIntervalMs = options.flushIntervalMs ?? 250;
        this.stagingBytes = options.stagingBytes ?? 1 << 20;
        this.maxQueuedBytes = options.maxQueuedBytes ?? 128 * 1024 * 1024;
        this.log = options.log || { warn() {}, error() {}, info() {}, debug() {} };
        this.now = options.now || Date.now;

        this.chunks = []; // oldest first; the last one is the chunk being written
        this.cur = null;
        this.nextSeq = 1;
        this.staging = null;
        this.stagingLen = 0;
        this.queuedBytes = 0;
        this.heap = new FrameHeap();
        this.newestIn = -Infinity; // newest media time given to append()
        this.newestTs = -Infinity; // newest media time written
        this.audioRanges = [];
        this.waiters = [];
        this.timer = null;
        this.closed = false;
        this.failedUntil = 0;
        this.indexDirty = false;
        this.indexWriting = false;
        this.stats = { framesIn: 0, framesWritten: 0, bytesWritten: 0, dropped: 0, droppedOverload: 0, writeErrors: 0 };
    }

    async open() {
        await fsp.mkdir(this.dir, { recursive: true });
        this._writeIndex();
    }

    /**
     * Adds a frame. Returns false when it was dropped. The data must not be modified afterwards (it is read later).
     * @param {number} kind KIND_VIDEO or KIND_AUDIO
     * @param {boolean} key
     * @param {number} tsMs media time, wall clock ms
     * @param {Buffer} data
     */
    append(kind, key, tsMs, data) {
        if (this.closed) return false;
        this.stats.framesIn++;
        if (this.queuedBytes > this.maxQueuedBytes) {
            this.stats.droppedOverload++;
            this.stats.dropped++;
            return false;
        }
        this.heap.push({ ts: tsMs, kind, key, data, at: this.now() });
        if (tsMs > this.newestIn) this.newestIn = tsMs;
        this._pumpHeap(false);
        if (this.timer === null) {
            this.timer = setInterval(() => this._onTimer(), this.flushIntervalMs);
            this.timer.unref();
        }
        return true;
    }

    _onTimer() {
        this._pumpHeap(false);
        this._submit();
        this._trim(this.newestTs);
    }

    /** Moves frames that waited long enough in the hold-back to the staging buffer, in media time order. */
    _pumpHeap(all) {
        const heap = this.heap;
        if (heap.size === 0) return;
        const horizon = this.newestIn - this.holdMs;
        const oldest = this.now() - 2 * this.holdMs;
        while (heap.size > 0) {
            const top = heap.peek();
            if (!all && top.ts > horizon && top.at > oldest) break;
            const item = heap.pop();
            this._write(item.kind, item.key, item.ts, item.data);
        }
    }

    _write(kind, key, ts, data) {
        if (this.cur !== null && this.cur.failed) {
            if (this.now() < this.failedUntil) {
                this.stats.dropped++;
                return;
            }
            this._rotate(ts);
        }
        if (this.cur === null || ts - this.cur.startTs >= this.chunkMs) this._rotate(ts);
        const need = RECORD_HEADER + data.length;
        if (this.staging === null || this.stagingLen + need > this.staging.length) {
            this._submit();
            this.staging = Buffer.allocUnsafe(Math.max(this.stagingBytes, need));
            this.stagingLen = 0;
        }
        const buf = this.staging;
        const o = this.stagingLen;
        buf[o] = kind;
        buf[o + 1] = key ? 1 : 0;
        buf.writeUInt16LE(0, o + 2);
        buf.writeUInt32LE(data.length, o + 4);
        buf.writeDoubleLE(ts, o + 8);
        data.copy(buf, o + RECORD_HEADER);
        this.stagingLen += need;

        const chunk = this.cur;
        const offset = chunk.bytes;
        chunk.bytes += need;
        if (ts > chunk.endTs) chunk.endTs = ts;
        if (ts > this.newestTs) this.newestTs = ts;
        if (kind === KIND_VIDEO) {
            chunk.videoFrames++;
            if (key) chunk.keys.push({ ts, off: offset, end: offset + need });
        } else {
            chunk.audioFrames++;
            this._noteAudio(ts);
        }
        this.stats.framesWritten++;
        this.stats.bytesWritten += need;
    }

    _noteAudio(ts) {
        const ranges = this.audioRanges;
        const last = ranges[ranges.length - 1];
        if (last && ts - last.to <= AUDIO_RANGE_GAP_MS && last.from - ts <= AUDIO_RANGE_GAP_MS) {
            if (ts > last.to) last.to = ts;
            if (ts < last.from) last.from = ts;
        } else {
            ranges.push({ from: ts, to: ts });
        }
    }

    _rotate(ts) {
        this._submit();
        if (this.cur !== null) {
            this.cur.sealed = true;
            this._pump(this.cur);
        }
        const seq = this.nextSeq++;
        const chunk = {
            seq,
            path: path.join(this.dir, chunkName(seq)),
            fd: null,
            opening: false,
            startTs: ts,
            endTs: ts,
            bytes: 0, // bytes handed to append (some may still be in memory)
            submitted: 0, // bytes given to the write queue
            written: 0, // bytes the disk confirmed
            keys: [],
            videoFrames: 0,
            audioFrames: 0,
            queue: [],
            writing: false,
            sealed: false,
            closing: false,
            failed: false,
            pins: 0,
            disposed: false,
            unlinking: false,
        };
        this.chunks.push(chunk);
        this.cur = chunk;
        this._open(chunk);
        this._trim(Math.max(this.newestTs, ts));
        this._writeIndex();
    }

    /** Hands the staging buffer to the write queue of the current chunk. */
    _submit() {
        const chunk = this.cur;
        if (this.staging === null || this.stagingLen === 0 || chunk === null) return;
        const buf = this.staging.subarray(0, this.stagingLen);
        this.staging = null;
        this.stagingLen = 0;
        if (chunk.failed) return;
        chunk.queue.push({ buf, pos: chunk.submitted, off: 0 });
        chunk.submitted += buf.length;
        this.queuedBytes += buf.length;
        this._pump(chunk);
    }

    _open(chunk) {
        chunk.opening = true;
        fs.open(chunk.path, 'w', (error, fd) => {
            chunk.opening = false;
            if (error) {
                this._fail(chunk, error);
                return;
            }
            chunk.fd = fd;
            this._pump(chunk);
        });
    }

    _pump(chunk) {
        if (chunk.writing || chunk.failed || chunk.fd === null) return;
        const item = chunk.queue[0];
        if (item === undefined) {
            if (chunk.sealed && !chunk.closing) this._closeChunk(chunk);
            this._checkWaiters();
            return;
        }
        chunk.writing = true;
        fs.write(chunk.fd, item.buf, item.off, item.buf.length - item.off, item.pos + item.off, (error, n) => {
            chunk.writing = false;
            if (error) {
                this._fail(chunk, error);
                return;
            }
            item.off += n;
            chunk.written += n;
            this.queuedBytes -= n;
            if (item.off >= item.buf.length) chunk.queue.shift();
            this._pump(chunk);
        });
    }

    _closeChunk(chunk) {
        chunk.closing = true;
        const fd = chunk.fd;
        fs.close(fd, () => {
            chunk.fd = null;
            this._maybeUnlink(chunk);
            this._checkWaiters();
        });
    }

    _fail(chunk, error) {
        this.stats.writeErrors++;
        this.log.error(`replay buffer: writing ${chunk.path} failed: ${error.message}`);
        chunk.failed = true;
        for (const item of chunk.queue) this.queuedBytes -= item.buf.length - item.off;
        chunk.queue = [];
        this.failedUntil = this.now() + 5000;
        if (chunk.fd !== null && !chunk.closing) {
            chunk.closing = true;
            fs.close(chunk.fd, () => {
                chunk.fd = null;
                this._maybeUnlink(chunk);
            });
        }
        this._checkWaiters();
    }

    _isDrained() {
        for (const chunk of this.chunks) {
            if (chunk.failed) continue;
            if (chunk.queue.length > 0 || chunk.writing) return false;
        }
        return true;
    }

    _checkWaiters() {
        if (this.waiters.length === 0 || !this._isDrained()) return;
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters) resolve();
    }

    /** Resolves when everything accepted so far (but the hold-back) is on disk. */
    flush() {
        this._submit();
        return new Promise((resolve) => {
            this.waiters.push(resolve);
            this._checkWaiters();
        });
    }

    /* ------------------------------------------------------------------------------------ retention ---- */

    _trim(newestTs) {
        const horizon = newestTs - this.retainMs;
        while (this.chunks.length > 1 && this.chunks[0].endTs < horizon) {
            const chunk = this.chunks.shift();
            chunk.disposed = true;
            this._maybeUnlink(chunk);
        }
        const oldestStart = this.chunks.length > 0 ? this.chunks[0].startTs : -Infinity;
        while (this.audioRanges.length > 1 && this.audioRanges[0].to < oldestStart) this.audioRanges.shift();
    }

    /** Deletes the file of a chunk that left the index, once nobody reads it and nothing writes it. */
    _maybeUnlink(chunk) {
        if (!chunk.disposed || chunk.unlinking || chunk.pins > 0) return;
        if (chunk.fd !== null || chunk.opening || chunk.writing || chunk.queue.length > 0) return;
        if (!chunk.sealed && !chunk.failed) return;
        chunk.unlinking = true;
        fs.unlink(chunk.path, () => {});
    }

    /* -------------------------------------------------------------------------------------- reading ---- */

    /**
     * Makes sure what was accepted is on disk and describes it for the clip builder. The chunks stay on disk (they
     * are pinned) until release() is called.
     * @returns {Promise<{chunks: object[], newestTs: number, audioRanges: object[], release: function}>}
     */
    async snapshot() {
        this._pumpHeap(true);
        await this.flush();
        const chunks = [];
        let newestTs = -Infinity;
        for (const chunk of this.chunks) {
            if (chunk.failed || chunk.written === 0) continue;
            chunk.pins++;
            const keys = chunk.keys.filter((k) => k.end <= chunk.written);
            chunks.push({
                seq: chunk.seq,
                path: chunk.path,
                startTs: chunk.startTs,
                endTs: chunk.endTs,
                bytes: chunk.written,
                keys,
                videoFrames: chunk.videoFrames,
                audioFrames: chunk.audioFrames,
                _chunk: chunk,
            });
            if (chunk.endTs > newestTs) newestTs = chunk.endTs;
        }
        let released = false;
        return {
            chunks,
            newestTs,
            audioRanges: this.audioRanges.map((r) => ({ ...r })),
            release: () => {
                if (released) return;
                released = true;
                for (const entry of chunks) {
                    entry._chunk.pins--;
                    this._maybeUnlink(entry._chunk);
                }
            },
        };
    }

    /** Number of clip builds (snapshots) that currently hold chunks of this buffer. */
    get pinCount() {
        let pins = 0;
        for (const chunk of this.chunks) pins += chunk.pins;
        return pins;
    }

    /** What is kept and how much of it can be used for a clip. */
    describe() {
        let bytes = 0;
        let oldestKeyTs = null;
        for (const chunk of this.chunks) {
            bytes += chunk.bytes;
            if (oldestKeyTs === null && chunk.keys.length > 0) oldestKeyTs = chunk.keys[0].ts;
        }
        const newest = Math.max(this.newestTs, this.newestIn);
        return {
            bytes,
            chunks: this.chunks.length,
            newestTs: Number.isFinite(newest) ? newest : null,
            oldestKeyTs,
            // media time that a clip can cover (it has to start at a key frame)
            availableMs: oldestKeyTs !== null && Number.isFinite(newest) ? Math.max(0, newest - oldestKeyTs) : 0,
            queuedBytes: this.queuedBytes,
        };
    }

    /* -------------------------------------------------------------------------------------- the index ---- */

    _writeIndex() {
        if (this.indexWriting) {
            this.indexDirty = true;
            return;
        }
        this.indexWriting = true;
        const body = JSON.stringify({
            ...this.info,
            updatedAt: this.now(),
            chunks: this.chunks.map((c) => ({
                file: path.basename(c.path),
                startTs: c.startTs,
                endTs: c.endTs,
                bytes: c.bytes,
                keyFrames: c.keys.length,
            })),
        });
        const target = path.join(this.dir, 'index.json');
        const tmp = `${target}.tmp`;
        fsp.writeFile(tmp, body)
            .then(() => fsp.rename(tmp, target))
            .catch(() => {})
            .finally(() => {
                this.indexWriting = false;
                if (this.indexDirty) {
                    this.indexDirty = false;
                    if (!this.closed) this._writeIndex();
                }
            });
    }

    /** Updates the share description kept in index.json. */
    setInfo(info) {
        this.info = { ...this.info, ...info };
        this._writeIndex();
    }

    /* ------------------------------------------------------------------------------------- lifecycle ---- */

    /** Writes what is pending, closes the files and stops. The chunks stay on disk. */
    async close() {
        if (this.closed) return;
        this._pumpHeap(true);
        this._submit();
        if (this.cur !== null) {
            this.cur.sealed = true;
            this._pump(this.cur);
        }
        this.closed = true;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        await new Promise((resolve) => {
            this.waiters.push(resolve);
            this._checkWaiters();
        });
        // wait for the files to be closed
        for (let i = 0; i < 100 && this.chunks.some((c) => c.fd !== null || c.opening); i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        this.indexDirty = false;
        await this._finalIndex();
    }

    async _finalIndex() {
        while (this.indexWriting) await new Promise((resolve) => setTimeout(resolve, 5));
        this.indexWriting = true;
        try {
            const target = path.join(this.dir, 'index.json');
            const body = JSON.stringify({
                ...this.info,
                updatedAt: this.now(),
                closed: true,
                chunks: this.chunks.map((c) => ({
                    file: path.basename(c.path),
                    startTs: c.startTs,
                    endTs: c.endTs,
                    bytes: c.bytes,
                    keyFrames: c.keys.length,
                })),
            });
            await fsp.writeFile(`${target}.tmp`, body);
            await fsp.rename(`${target}.tmp`, target);
        } catch {
            // the directory may be gone already
        } finally {
            this.indexWriting = false;
        }
    }

    /** Stops and deletes everything of this buffer. */
    async destroy() {
        await this.close();
        for (const chunk of this.chunks) chunk.disposed = true;
        await fsp.rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

/**
 * Reads the records of a chunk file between two byte offsets (record boundaries), one read buffer at a time.
 * The data of a record is a view of the read buffer: copy it if it must outlive the iteration by long.
 * @param {string} file
 * @param {number} from offset of the first record to read
 * @param {number} to end offset (exclusive)
 * @returns {AsyncGenerator<{kind: number, key: boolean, ts: number, data: Buffer}>}
 */
async function* readRecords(file, from, to, { readSize = 1 << 20 } = {}) {
    const handle = await fsp.open(file, 'r');
    try {
        let pos = from;
        let carry = null;
        while (pos < to) {
            const carryLength = carry === null ? 0 : carry.length;
            const want = Math.min(readSize, to - pos);
            const buf = Buffer.allocUnsafe(carryLength + want);
            if (carryLength > 0) carry.copy(buf, 0);
            const { bytesRead } = await handle.read(buf, carryLength, want, pos);
            if (bytesRead === 0) break;
            pos += bytesRead;
            const view = buf.subarray(0, carryLength + bytesRead);
            let o = 0;
            while (view.length - o >= RECORD_HEADER) {
                const length = view.readUInt32LE(o + 4);
                if (length > MAX_RECORD) throw new Error(`corrupt record in ${file}`);
                if (view.length - o < RECORD_HEADER + length) break;
                yield {
                    kind: view[o],
                    key: (view[o + 1] & 1) !== 0,
                    ts: view.readDoubleLE(o + 8),
                    data: view.subarray(o + RECORD_HEADER, o + RECORD_HEADER + length),
                };
                o += RECORD_HEADER + length;
            }
            carry = view.subarray(o);
        }
    } finally {
        await handle.close();
    }
}

module.exports = { FrameStore, FrameHeap, readRecords, KIND_VIDEO, KIND_AUDIO, RECORD_HEADER };
