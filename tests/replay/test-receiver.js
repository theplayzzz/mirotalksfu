'use strict';

require('should');

const { StreamReceiver } = require('../../app/src/replay/StreamReceiver');
const { parseRtcp, buildRtp } = require('../../app/src/replay/rtp');
const gen = require('./lib/gen');

const T0 = 1791036902000;
const SENDER_SSRC = 0x5eed;

function videoReceiver(extra = {}) {
    const frames = [];
    const rtcp = [];
    const receiver = new StreamReceiver({
        kind: 'video',
        codec: 'vp8',
        ssrc: 1111,
        payloadType: 101,
        clockRate: 90000,
        senderSsrc: SENDER_SSRC,
        sendRtcp: (buf) => rtcp.push(...parseRtcp(buf)),
        onFrame: (frame) => frames.push(frame),
        ...extra,
    });
    return { receiver, frames, rtcp };
}

/** One synthetic VP8 frame as RTP packets; frame i is at 30 fps from rtp base. */
function frameAt(i, { key = false, base = 100000, firstSeq = 0, size = 3000, ssrc = 1111 } = {}) {
    const frame = gen.vp8Frame({ key, size, seed: i + 1 });
    return gen.vp8Packets(frame, { timestamp: (base + i * 3000) >>> 0, firstSeq, mtu: 1000, ssrc });
}

describe('replay: StreamReceiver', () => {
    describe('timestamps', () => {
        it('stamps frames with the wall clock of the Sender Report mapping', () => {
            const { receiver, frames } = videoReceiver();
            receiver.onSenderReport(100000, T0, T0); // rtp 100000 <-> T0
            let seq = 0;
            for (let i = 0; i < 4; i++) {
                const packets = frameAt(i, { key: i === 0, firstSeq: seq });
                seq += packets.length;
                packets.forEach((p) => receiver.push(p, T0 + i * 33 + 5));
            }
            frames.should.have.length(4);
            frames.forEach((frame, i) => frame.tsMs.should.be.approximately(T0 + (i * 3000) / 90, 1e-6));
            frames[0].key.should.be.true();
            frames[0].kind.should.equal('video');
        });

        it('keeps frames in memory until the first Sender Report, then converts them', () => {
            const { receiver, frames } = videoReceiver();
            let seq = 0;
            for (let i = 0; i < 5; i++) {
                const packets = frameAt(i, { key: i === 0, firstSeq: seq });
                seq += packets.length;
                packets.forEach((p) => receiver.push(p, T0 + i * 33));
                receiver.tick(T0 + i * 33 + 1);
            }
            frames.should.have.length(0);
            receiver.onSenderReport(100000 + 3000 * 6, T0 + 6 * 33.3333, T0 + 200);
            frames.should.have.length(5);
            frames.forEach((frame, i) => frame.tsMs.should.be.approximately(T0 + i * 33.3333, 0.01));
            receiver.clockMode.should.equal('sr');
        });

        it('falls back to the arrival times when no report comes within pendingMaxMs', () => {
            const { receiver, frames } = videoReceiver();
            let seq = 0;
            // delays of the frames: 8, 3, 20, 5, 15 ms -> the minimum (3 ms) defines the mapping
            const delays = [8, 3, 20, 5, 15];
            delays.forEach((delay, i) => {
                const packets = frameAt(i, { key: i === 0, firstSeq: seq });
                seq += packets.length;
                packets.forEach((p) => receiver.push(p, T0 + i * 33.3333 + delay));
            });
            receiver.tick(T0 + 2999);
            frames.should.have.length(0);
            receiver.tick(T0 + 3100);
            frames.should.have.length(5);
            receiver.clockMode.should.equal('arrival');
            frames.forEach((frame, i) => frame.tsMs.should.be.approximately(T0 + i * 33.3333 + 3, 0.01));
        });

        it('puts video and audio of one instant on the same time', () => {
            const out = [];
            const video = new StreamReceiver({
                kind: 'video',
                codec: 'vp8',
                ssrc: 1111,
                payloadType: 101,
                clockRate: 90000,
                senderSsrc: 1,
                sendRtcp: () => {},
                onFrame: (f) => out.push(f),
            });
            const audio = new StreamReceiver({
                kind: 'audio',
                codec: 'opus',
                ssrc: 3333,
                payloadType: 100,
                clockRate: 48000,
                senderSsrc: 1,
                sendRtcp: () => {},
                onFrame: (f) => out.push(f),
            });
            // Unrelated bases; both reports describe "wall T0 + 1000".
            video.onSenderReport(5000000, T0 + 1000, T0 + 1000);
            audio.onSenderReport(900000, T0 + 1000, T0 + 1000);
            // the instant T0 + 1500: video frame at 5000000 + 45000, audio packet at 900000 + 24000
            const vp = frameAt(0, { key: true, base: 5000000 + 45000 });
            vp.forEach((p) => video.push(p, T0 + 1510));
            audio.push(gen.opusRtp(gen.opusPacket(), { timestamp: 900000 + 24000, sequenceNumber: 0 }), T0 + 1520);
            out.should.have.length(2);
            const v = out.find((f) => f.kind === 'video');
            const a = out.find((f) => f.kind === 'audio');
            v.tsMs.should.be.approximately(T0 + 1500, 1e-6);
            a.tsMs.should.be.approximately(T0 + 1500, 1e-6);
        });

        it('never lets the timestamps of a stream run backwards', () => {
            const { receiver, frames } = videoReceiver();
            receiver.onSenderReport(100000, T0, T0);
            let seq = 0;
            for (let i = 0; i < 30; i++) {
                const packets = frameAt(i, { key: i === 0, firstSeq: seq, size: 300 });
                seq += packets.length;
                if (i === 10) receiver.onSenderReport(100000 + 3000 * 10, T0 + 333 - 40, T0 + 333); // the estimate drops
                packets.forEach((p) => receiver.push(p, T0 + i * 33));
            }
            for (let i = 1; i < frames.length; i++) frames[i].tsMs.should.not.be.below(frames[i - 1].tsMs);
        });

        it('copes with the 32 bit RTP timestamp wrapping in the middle of the stream', () => {
            const { receiver, frames } = videoReceiver();
            const base = 4294967296 - 6000;
            receiver.onSenderReport(base >>> 0, T0, T0);
            let seq = 0;
            for (let i = 0; i < 6; i++) {
                const packets = frameAt(i, { key: i === 0, firstSeq: seq, base, size: 200 });
                seq += packets.length;
                packets.forEach((p) => receiver.push(p, T0 + i * 33));
            }
            frames.should.have.length(6);
            frames.forEach((frame, i) => frame.tsMs.should.be.approximately(T0 + (i * 3000) / 90, 1e-3));
        });
    });

    describe('loss, NACK and key frames', () => {
        it('repairs a lost packet with a NACK and keeps the frame, with no key frame request', () => {
            const { receiver, frames, rtcp } = videoReceiver();
            receiver.onSenderReport(100000, T0, T0);
            let seq = 0;
            const all = [];
            for (let i = 0; i < 4; i++) {
                const packets = frameAt(i, { key: i === 0, firstSeq: seq, size: 4000 });
                seq += packets.length;
                all.push(packets);
            }
            const lost = all[1][2];
            all.forEach((packets, i) => packets.forEach((p) => p !== lost && receiver.push(p, T0 + i * 33)));
            receiver.tick(T0 + 120);
            const nack = rtcp.find((p) => p.type === 'nack');
            nack.mediaSsrc.should.equal(1111);
            nack.senderSsrc.should.equal(SENDER_SSRC);
            nack.seqs.should.deepEqual([all[0].length + 2]);
            receiver.push(lost, T0 + 125); // retransmission, same sequence number
            frames.should.have.length(4);
            rtcp.filter((p) => p.type === 'pli').should.have.length(0);
            frames[1].data.length.should.equal(4000);
        });

        it('drops the frame it could not repair, waits for a key frame, and sends one PLI', () => {
            const { receiver, frames, rtcp } = videoReceiver();
            receiver.onSenderReport(100000, T0, T0);
            let seq = 0;
            const all = [];
            for (let i = 0; i < 6; i++) {
                const packets = frameAt(i, { key: i === 0 || i === 5, firstSeq: seq, size: 4000 });
                seq += packets.length;
                all.push(packets);
            }
            // frame 2 loses a packet for good
            all.forEach((packets, i) =>
                packets.forEach((p, j) => !(i === 2 && j === 1) && receiver.push(p, T0 + i * 33))
            );
            frames.map((f) => f.key).should.deepEqual([true, false]); // frames 0 and 1 came through
            for (let t = 1; t <= 70; t += 5) receiver.tick(T0 + 5 * 33 + t);
            // after the give-up: frames 3 and 4 are inter frames that cannot be decoded -> dropped; key frame 5 is kept
            // (it was pushed before the give-up and waited behind the hole, so it comes out now)
            frames.map((f) => f.key).should.deepEqual([true, false, true]);
            rtcp.filter((p) => p.type === 'pli').should.have.length(1);
            receiver.stats.droppedWaitingKey.should.be.greaterThan(0);
            receiver.needKey.should.be.false();
        });

        it('asks for a key frame at most once every 10 seconds', () => {
            const { receiver, rtcp } = videoReceiver();
            receiver.onSenderReport(100000, T0, T0);
            let seq = 0;
            const loseOne = (i, now) => {
                const packets = frameAt(i, { key: false, firstSeq: seq, size: 4000 });
                seq += packets.length;
                packets.forEach((p, j) => j !== 1 && receiver.push(p, now));
                for (let t = 5; t <= 100; t += 5) receiver.tick(now + t);
            };
            // a key frame first so that the stream is running
            const first = frameAt(0, { key: true, firstSeq: seq });
            seq += first.length;
            first.forEach((p) => receiver.push(p, T0));
            loseOne(1, T0 + 100);
            rtcp.filter((p) => p.type === 'pli').should.have.length(1);
            loseOne(2, T0 + 3000);
            rtcp.filter((p) => p.type === 'pli').should.have.length(1); // too soon
            receiver.tick(T0 + 9000);
            rtcp.filter((p) => p.type === 'pli').should.have.length(1);
            receiver.tick(T0 + 10200);
            rtcp.filter((p) => p.type === 'pli').should.have.length(2); // 10 s passed and a key frame is still wanted
            receiver.tick(T0 + 10300);
            rtcp.filter((p) => p.type === 'pli').should.have.length(2);
        });

        it('drops inter frames at the start and asks for a key frame after a second', () => {
            const { receiver, frames, rtcp } = videoReceiver();
            receiver.onSenderReport(100000, T0, T0);
            let seq = 0;
            for (let i = 0; i < 3; i++) {
                const packets = frameAt(i, { key: false, firstSeq: seq });
                seq += packets.length;
                packets.forEach((p) => receiver.push(p, T0 + i * 33));
            }
            frames.should.have.length(0);
            receiver.tick(T0 + 500);
            rtcp.should.have.length(0);
            receiver.tick(T0 + 1100);
            rtcp.filter((p) => p.type === 'pli').should.have.length(1);
            const packets = frameAt(3, { key: true, firstSeq: seq });
            packets.forEach((p) => receiver.push(p, T0 + 1200));
            frames.should.have.length(1);
            frames[0].key.should.be.true();
        });

        it('does not need key frames for audio: a lost packet is only a gap', () => {
            const frames = [];
            const rtcp = [];
            const audio = new StreamReceiver({
                kind: 'audio',
                codec: 'opus',
                ssrc: 3333,
                payloadType: 100,
                clockRate: 48000,
                senderSsrc: 1,
                sendRtcp: (b) => rtcp.push(...parseRtcp(b)),
                onFrame: (f) => frames.push(f),
            });
            audio.onSenderReport(0, T0, T0);
            for (let i = 0; i < 10; i++) {
                if (i === 4) continue; // lost
                audio.push(gen.opusRtp(gen.opusPacket(), { timestamp: i * 960, sequenceNumber: i }), T0 + i * 20);
            }
            for (let t = 0; t < 200; t += 5) audio.tick(T0 + 200 + t);
            frames.should.have.length(9);
            frames[4].tsMs.should.be.approximately(T0 + 100, 1e-6); // the packet after the hole keeps its own time
            rtcp.filter((p) => p.type === 'pli').should.have.length(0);
            rtcp.filter((p) => p.type === 'nack').should.not.have.length(0);
        });

        it('takes retransmissions that come on the RTX stream', () => {
            const { receiver, frames, rtcp } = videoReceiver({ rtx: { ssrc: 4444, payloadType: 107 } });
            receiver.onSenderReport(100000, T0, T0);
            let seq = 0;
            const all = [];
            for (let i = 0; i < 3; i++) {
                const packets = frameAt(i, { key: i === 0, firstSeq: seq, size: 3500 });
                seq += packets.length;
                all.push(packets);
            }
            const lostIndex = 1;
            all.forEach((packets, i) =>
                packets.forEach((p, j) => !(i === 1 && j === lostIndex) && receiver.push(p, T0 + i * 33))
            );
            receiver.tick(T0 + 120);
            rtcp.filter((p) => p.type === 'nack').should.not.have.length(0);
            // RTX packet: own SSRC and payload type, the original sequence number in front of the original payload
            const original = all[1][lostIndex];
            const originalPayload = original.subarray(12);
            const osn = Buffer.alloc(2);
            osn.writeUInt16BE(original.readUInt16BE(2));
            const rtxPacket = buildRtp({
                payloadType: 107,
                sequenceNumber: 9000,
                timestamp: original.readUInt32BE(4),
                ssrc: 4444,
                marker: false,
                payload: Buffer.concat([osn, originalPayload]),
            });
            receiver.pushRtx(rtxPacket, T0 + 130);
            frames.should.have.length(3);
            receiver.stats.rtxPackets.should.equal(1);
        });

        it('counts malformed packets and packets of another payload type, and does not throw on them', () => {
            const { receiver, frames } = videoReceiver();
            receiver.push(Buffer.from([1, 2, 3]), T0);
            receiver.push(
                buildRtp({ payloadType: 99, sequenceNumber: 1, timestamp: 1, ssrc: 1111, payload: Buffer.alloc(10) }),
                T0
            );
            receiver.pushRtx(Buffer.from([0x80, 107, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 5]), T0);
            receiver.stats.malformed.should.equal(2);
            receiver.stats.wrongPayloadType.should.equal(1);
            frames.should.have.length(0);
        });
    });

    describe('H.264', () => {
        it('gates on the first IDR with parameter sets and exposes them', () => {
            const frames = [];
            const receiver = new StreamReceiver({
                kind: 'video',
                codec: 'h264',
                ssrc: 2222,
                payloadType: 102,
                clockRate: 90000,
                senderSsrc: 1,
                sendRtcp: () => {},
                onFrame: (f) => frames.push(f),
            });
            receiver.onSenderReport(1000, T0, T0);
            const sps = gen.h264Sps({ width: 1920, height: 1080 });
            const pps = gen.h264Pps();
            gen.h264Packets([gen.h264Nal(1, 400)], { timestamp: 1000, firstSeq: 0 }).forEach((p) =>
                receiver.push(p, T0)
            );
            frames.should.have.length(0); // inter frame before any key frame
            gen.h264Packets([sps, pps, gen.h264Nal(5, 3000)], { timestamp: 4000, firstSeq: 1 }).forEach((p) =>
                receiver.push(p, T0 + 33)
            );
            frames.should.have.length(1);
            frames[0].key.should.be.true();
            frames[0].width.should.equal(1920);
            frames[0].height.should.equal(1080);
            receiver.parameterSets.info.height.should.equal(1080);
        });
    });
});
