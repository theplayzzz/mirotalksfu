'use strict';

const { seqDiff } = require('./rtp');

/**
 * Puts the RTP packets of one stream back in sequence order and decides what to do about holes.
 *
 * - A packet that is the next expected one goes straight through (the common case: no copy, no queue).
 * - A packet that is ahead of the next expected one waits in a ring of slots; the sequence numbers in between are
 *   remembered as missing.
 * - Missing packets are asked for with a Generic NACK: the first one nackDelayMs after the hole was noticed (so plain
 *   reordering costs nothing), then every nackRetryMs, at most maxNacks times. The SFU answers by sending the
 *   packet again with the same sequence number, which fills the hole.
 * - A hole that is still open maxWaitMs after it was noticed is given up: the packet is skipped, onLoss() is called
 *   (the depacketizer must drop the frame it was assembling) and the packets waiting behind it are released.
 * - Packets that arrive after their hole was given up, and duplicates, are dropped.
 *
 * A jump of the sequence numbers larger than the ring (the stream was restarted) resynchronizes: whatever waits is
 * dropped, onLoss() is called and the new packet is the next expected one.
 *
 * Time is passed in (milliseconds on any monotonic clock) so tests can drive it.
 */

const SLOTS = 4096; // ring of waiting packets
const WINDOW = SLOTS / 2; // how far ahead of the next expected packet a packet may be to wait for it
const MASK = SLOTS - 1;

class ReorderBuffer {
    /**
     * @param {object} options
     * @param {function} options.deliver (pkt) => void, packets in sequence order. pkt.seq is the 16 bit sequence.
     * @param {function} options.onLoss (lostPackets, reason) => void
     * @param {function} options.sendNack (seqs[]) => void
     */
    constructor(options) {
        this.deliver = options.deliver;
        this.onLoss = options.onLoss;
        this.sendNack = options.sendNack;
        this.nackDelayMs = options.nackDelayMs ?? 5;
        this.nackRetryMs = options.nackRetryMs ?? 20;
        this.maxNacks = options.maxNacks ?? 5;
        this.maxWaitMs = options.maxWaitMs ?? 60;
        this.nackAnswerMs = options.nackAnswerMs ?? 8; // a hole is never given up sooner than this after its last NACK
        this.maxNackBatch = options.maxNackBatch ?? 200;
        this.slots = new Array(SLOTS);
        this.missing = new Map();
        this.stats = {
            received: 0,
            late: 0,
            duplicates: 0,
            lost: 0,
            recovered: 0,
            nackedPackets: 0,
            nackMessages: 0,
            resyncs: 0,
        };
        this.reset();
    }

    reset() {
        this.started = false;
        this.expected = 0;
        this.highest = 0;
        this.pendingCount = 0;
        this.missing.clear();
        this.slots.fill(undefined);
    }

    /** Number of packets waiting for a hole to be filled. */
    get waiting() {
        return this.pendingCount;
    }

    push(pkt, nowMs) {
        const seq = pkt.seq;
        this.stats.received++;
        if (!this.started) {
            this.started = true;
            this.expected = seq;
            this.highest = seq;
            this._release(pkt);
            return;
        }

        const ahead = (seq - this.expected) & 0xffff;
        if (ahead === 0) {
            if (this.missing.size !== 0 && this.missing.delete(seq)) this.stats.recovered++;
            if (seqDiff(seq, this.highest) > 0) this.highest = seq;
            this._release(pkt);
            this._drain();
            return;
        }
        if (ahead >= WINDOW) {
            if (ahead > 0x10000 - WINDOW) {
                this.stats.late++; // behind the next expected packet: late or duplicate
                return;
            }
            this._resync(pkt, nowMs);
            return;
        }

        const slot = seq & MASK;
        if (this.slots[slot] !== undefined) {
            this.stats.duplicates++;
            return;
        }
        this.slots[slot] = pkt;
        this.pendingCount++;
        if (seqDiff(seq, this.highest) > 0) {
            // New hole(s): everything between the highest packet seen and this one.
            for (let s = (this.highest + 1) & 0xffff; s !== seq; s = (s + 1) & 0xffff) {
                this.missing.set(s, { first: nowMs, last: 0, nacks: 0 });
            }
            this.highest = seq;
        } else if (this.missing.delete(seq)) {
            this.stats.recovered++;
        }
    }

    /** Sends NACKs that are due and gives up holes that waited too long. Call it every few milliseconds. */
    tick(nowMs) {
        if (this.pendingCount === 0 && this.missing.size === 0) return;

        // NACKs first: even after a stall of the event loop every hole gets one request before it is given up.
        let due = null;
        for (const [seq, info] of this.missing) {
            if (info.nacks >= this.maxNacks || nowMs - info.first < this.nackDelayMs) continue;
            if (info.nacks > 0 && nowMs - info.last < this.nackRetryMs) continue;
            info.nacks++;
            info.last = nowMs;
            (due || (due = [])).push(seq);
            if (due.length >= this.maxNackBatch) break;
        }
        if (due) {
            this.stats.nackedPackets += due.length;
            this.stats.nackMessages++;
            this.sendNack(due);
        }

        // Give up the holes at the head of the line that waited too long (and had time to be answered).
        let lost = 0;
        while (this.pendingCount > 0 && this.slots[this.expected & MASK] === undefined) {
            let info = this.missing.get(this.expected);
            if (!info) {
                info = { first: nowMs, last: 0, nacks: 0 };
                this.missing.set(this.expected, info);
            }
            if (nowMs - info.first < this.maxWaitMs) break;
            if (this.maxNacks > 0 && (info.nacks === 0 || nowMs - info.last < this.nackAnswerMs)) break;
            this.missing.delete(this.expected);
            this.expected = (this.expected + 1) & 0xffff;
            lost++;
        }
        if (lost > 0) {
            this.stats.lost += lost;
            this.onLoss(lost, 'gap');
            this._drain();
        }
    }

    _release(pkt) {
        this.expected = (this.expected + 1) & 0xffff;
        this.deliver(pkt);
    }

    _drain() {
        while (this.pendingCount > 0) {
            const slot = this.expected & MASK;
            const pkt = this.slots[slot];
            if (pkt === undefined) return;
            this.slots[slot] = undefined;
            this.pendingCount--;
            this._release(pkt);
        }
    }

    _resync(pkt, nowMs) {
        this.stats.resyncs++;
        this.stats.lost += this.pendingCount;
        this.reset();
        this.onLoss(0, 'resync');
        this.push(pkt, nowMs);
        this.stats.received--; // push counted this packet a second time
    }
}

module.exports = { ReorderBuffer, WINDOW, SLOTS };
