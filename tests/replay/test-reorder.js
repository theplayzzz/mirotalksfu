'use strict';

require('should');

const { ReorderBuffer, SLOTS } = require('../../app/src/replay/ReorderBuffer');

function setup(options = {}) {
    const delivered = [];
    const losses = [];
    const nacks = [];
    const buffer = new ReorderBuffer({
        deliver: (pkt) => delivered.push(pkt.seq),
        onLoss: (count, reason) => losses.push([count, reason]),
        sendNack: (seqs) => nacks.push(seqs.slice()),
        ...options,
    });
    const push = (seq, now = 0) => buffer.push({ seq }, now);
    return { buffer, delivered, losses, nacks, push };
}

describe('replay: ReorderBuffer', () => {
    it('lets packets in order go straight through', () => {
        const { buffer, delivered, nacks, push } = setup();
        for (let i = 0; i < 10; i++) push(100 + i, i);
        buffer.tick(100);
        delivered.should.deepEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
        nacks.should.have.length(0);
        buffer.waiting.should.equal(0);
    });

    it('puts a swapped pair back in order without asking for anything', () => {
        const { buffer, delivered, nacks, push } = setup();
        push(1, 0);
        push(2, 1);
        push(4, 2);
        buffer.tick(3); // too early for a NACK
        push(3, 4);
        buffer.tick(30);
        delivered.should.deepEqual([1, 2, 3, 4]);
        nacks.should.have.length(0);
        buffer.stats.recovered.should.equal(1);
    });

    it('asks for a missing packet after nackDelayMs and releases everything when it arrives', () => {
        const { buffer, delivered, nacks, push } = setup();
        push(1, 0);
        push(2, 0);
        push(4, 1); // 3 is missing
        push(5, 2);
        buffer.tick(4);
        nacks.should.have.length(0);
        buffer.tick(7);
        nacks.should.deepEqual([[3]]);
        delivered.should.deepEqual([1, 2]);
        push(3, 9); // the retransmission
        delivered.should.deepEqual([1, 2, 3, 4, 5]);
        buffer.tick(60);
        nacks.should.have.length(1);
        buffer.stats.recovered.should.equal(1);
        buffer.stats.lost.should.equal(0);
    });

    it('repeats the NACK every nackRetryMs, then gives up the packet after maxWaitMs and carries on', () => {
        const { buffer, delivered, losses, nacks, push } = setup({ nackDelayMs: 5, nackRetryMs: 20, maxWaitMs: 60 });
        push(1, 0);
        push(3, 0);
        push(4, 0);
        for (let t = 1; t < 60; t++) buffer.tick(t);
        nacks.length.should.be.within(3, 5);
        losses.should.have.length(0);
        delivered.should.deepEqual([1]);
        buffer.tick(60);
        buffer.tick(61); // the last NACK went out at 45 and the answer window is over
        losses.should.deepEqual([[1, 'gap']]);
        delivered.should.deepEqual([1, 3, 4]);
        buffer.stats.lost.should.equal(1);
        push(2, 70); // the retransmission comes too late
        delivered.should.deepEqual([1, 3, 4]);
        buffer.stats.late.should.equal(1);
        push(5, 71);
        delivered.should.deepEqual([1, 3, 4, 5]);
    });

    it('stops asking after maxNacks', () => {
        const { buffer, nacks, push } = setup({ maxNacks: 2, nackRetryMs: 10, maxWaitMs: 1000 });
        push(1, 0);
        push(3, 0);
        for (let t = 1; t < 500; t++) buffer.tick(t);
        nacks.should.have.length(2);
    });

    it('works across the 16 bit sequence wrap', () => {
        const { buffer, delivered, nacks, push } = setup();
        for (const seq of [65533, 65534, 0, 1]) push(seq, 0); // 65535 missing
        buffer.tick(10);
        nacks.should.deepEqual([[65535]]);
        push(65535, 12);
        delivered.should.deepEqual([65533, 65534, 65535, 0, 1]);
        push(2, 13);
        delivered[delivered.length - 1].should.equal(2);
    });

    it('ignores duplicates', () => {
        const { buffer, delivered, push } = setup();
        push(1, 0);
        push(2, 0);
        push(2, 0);
        push(4, 0);
        push(4, 0);
        push(1, 0);
        push(3, 1);
        delivered.should.deepEqual([1, 2, 3, 4]);
        buffer.stats.duplicates.should.equal(1);
        buffer.stats.late.should.equal(2);
    });

    it('asks for all the packets of a burst loss in one message and gives them up together', () => {
        const { buffer, delivered, losses, nacks, push } = setup();
        for (let seq = 0; seq < 10; seq++) push(seq, 0);
        for (let seq = 20; seq < 30; seq++) push(seq, 1);
        buffer.tick(10);
        nacks.should.have.length(1);
        nacks[0]
            .slice()
            .sort((a, b) => a - b)
            .should.deepEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
        buffer.tick(70);
        buffer.tick(80); // a hole is given up one tick after its last NACK, so the answer has a chance to arrive
        losses.should.deepEqual([[10, 'gap']]);
        delivered.slice(-10).should.deepEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    });

    it('handles several holes and fills them in any order', () => {
        const { buffer, delivered, nacks, push } = setup();
        push(0, 0);
        push(2, 0);
        push(5, 0);
        push(6, 0);
        buffer.tick(10);
        nacks[0].slice().sort().should.deepEqual([1, 3, 4]);
        push(4, 11);
        push(1, 12);
        delivered.should.deepEqual([0, 1, 2]);
        push(3, 13);
        delivered.should.deepEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('gives up the head hole first and keeps waiting for a later one', () => {
        const { buffer, delivered, losses, push } = setup({ maxWaitMs: 60 });
        push(0, 0);
        push(2, 0); // hole 1 noticed at t=0
        push(4, 40); // hole 3 noticed at t=40
        buffer.tick(61);
        buffer.tick(71);
        losses.should.deepEqual([[1, 'gap']]);
        delivered.should.deepEqual([0, 2]);
        buffer.tick(101);
        buffer.tick(111);
        losses.should.deepEqual([
            [1, 'gap'],
            [1, 'gap'],
        ]);
        delivered.should.deepEqual([0, 2, 4]);
    });

    it('resynchronizes when the sequence jumps further than it can hold', () => {
        const { buffer, delivered, losses, push } = setup();
        push(10, 0);
        push(11, 0);
        push(13, 0); // waits
        push(5000, 1);
        losses.should.deepEqual([[0, 'resync']]);
        delivered.should.deepEqual([10, 11, 5000]);
        push(5001, 2);
        delivered.should.deepEqual([10, 11, 5000, 5001]);
        buffer.stats.resyncs.should.equal(1);
    });

    it('keeps its memory bounded when a stream keeps jumping', () => {
        const { buffer, push } = setup();
        for (let i = 0; i < 5000; i++) push((i * 3001) & 0xffff, i);
        buffer.waiting.should.be.below(SLOTS);
    });

    it('does not throw when nothing was received', () => {
        const { buffer } = setup();
        buffer.tick(1000);
        buffer.reset();
        buffer.waiting.should.equal(0);
    });
});
