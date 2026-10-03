'use strict';

require('should');

const { parseRtp } = require('../../app/src/replay/rtp');
const {
    Vp8Depacketizer,
    H264Depacketizer,
    OpusDepacketizer,
    createDepacketizer,
} = require('../../app/src/replay/depacketizers');
const h264 = require('../../app/src/replay/h264');
const opus = require('../../app/src/replay/opus');
const gen = require('./lib/gen');

/** Feeds RTP datagrams to a depacketizer as the reorder buffer would. */
function feed(depacketizer, datagrams, arrivalMs = 1000) {
    for (const datagram of datagrams) {
        const h = parseRtp(datagram);
        depacketizer.push({
            seq: h.sequenceNumber,
            timestamp: h.timestamp,
            marker: h.marker,
            payload: datagram.subarray(h.payloadOffset, h.payloadEnd),
            arrivalMs,
        });
    }
}

function collect(make) {
    const frames = [];
    const depacketizer = make((frame) => frames.push(frame));
    return { depacketizer, frames };
}

describe('replay: depacketizers', () => {
    describe('VP8 (RFC 7741)', () => {
        const make = (cb) => new Vp8Depacketizer(cb);

        it('turns a one packet key frame into a frame with its picture size', () => {
            const { depacketizer, frames } = collect(make);
            const frame = gen.vp8Frame({ key: true, size: 400, width: 1920, height: 1080 });
            feed(depacketizer, gen.vp8Packets(frame, { timestamp: 9000 }));
            frames.should.have.length(1);
            frames[0].key.should.be.true();
            frames[0].width.should.equal(1920);
            frames[0].height.should.equal(1080);
            frames[0].timestamp.should.equal(9000);
            frames[0].data.equals(frame).should.be.true();
        });

        it('joins the packets of a large frame and tells delta frames from key frames', () => {
            const { depacketizer, frames } = collect(make);
            const key = gen.vp8Frame({ key: true, size: 9000 });
            const delta = gen.vp8Frame({ key: false, size: 5000, seed: 5 });
            const keyPackets = gen.vp8Packets(key, { timestamp: 1000, firstSeq: 10, mtu: 1000 });
            const deltaPackets = gen.vp8Packets(delta, {
                timestamp: 4000,
                firstSeq: 10 + keyPackets.length,
                mtu: 1000,
            });
            keyPackets.length.should.be.greaterThan(5);
            feed(depacketizer, keyPackets);
            feed(depacketizer, deltaPackets);
            frames.map((f) => f.key).should.deepEqual([true, false]);
            frames[0].data.equals(key).should.be.true();
            frames[1].data.equals(delta).should.be.true();
            frames[1].width.should.equal(0);
        });

        it('skips every form of the payload descriptor extension', () => {
            for (const extension of ['none', 'pid7', 'pid15', 'full', 'tl0']) {
                const { depacketizer, frames } = collect(make);
                const frame = gen.vp8Frame({ key: true, size: 3000, seed: 9 });
                feed(depacketizer, gen.vp8Packets(frame, { timestamp: 500, mtu: 700, extension, pictureId: 300 }));
                frames.should.have.length(1, extension);
                frames[0].data.equals(frame).should.be.true(extension);
            }
        });

        it('copes with RTP header extensions and padding around the descriptor', () => {
            const { depacketizer, frames } = collect(make);
            const frame = gen.vp8Frame({ key: true, size: 2500 });
            feed(
                depacketizer,
                gen.vp8Packets(frame, {
                    timestamp: 500,
                    mtu: 900,
                    rtpExtension: { profile: 0xbede, data: Buffer.from([0x11, 1, 2, 3, 0x22, 4, 5, 6]) },
                    padding: 3,
                })
            );
            frames[0].data.equals(frame).should.be.true();
        });

        it('treats a new timestamp as the end of the previous frame when the marker bit is missing', () => {
            const { depacketizer, frames } = collect(make);
            const a = gen.vp8Frame({ key: true, size: 2000 });
            const b = gen.vp8Frame({ key: false, size: 800, seed: 2 });
            feed(depacketizer, gen.vp8Packets(a, { timestamp: 1000, mtu: 900, marker: false }));
            frames.should.have.length(0);
            feed(depacketizer, gen.vp8Packets(b, { timestamp: 4000, firstSeq: 3, mtu: 900 }));
            frames.should.have.length(2);
            frames[0].data.equals(a).should.be.true();
        });

        it('drops the frame being assembled on reset and ignores its remaining packets', () => {
            const { depacketizer, frames } = collect(make);
            const lost = gen.vp8Frame({ key: false, size: 4000 });
            const packets = gen.vp8Packets(lost, { timestamp: 1000, mtu: 1000 });
            feed(depacketizer, [packets[0], packets[1]]);
            depacketizer.reset(); // a hole was given up here
            feed(depacketizer, packets.slice(3)); // continuation packets without the start
            frames.should.have.length(0);
            const next = gen.vp8Frame({ key: true, size: 600, seed: 4 });
            feed(depacketizer, gen.vp8Packets(next, { timestamp: 4000, firstSeq: 20 }));
            frames.should.have.length(1);
            frames[0].key.should.be.true();
        });

        it('wraps the 16 bit sequence and the 32 bit timestamp without noticing', () => {
            const { depacketizer, frames } = collect(make);
            let ts = 4294967000;
            let seq = 65530;
            for (let i = 0; i < 6; i++) {
                const frame = gen.vp8Frame({ key: i === 0, size: 2500, seed: i + 1 });
                const packets = gen.vp8Packets(frame, { timestamp: ts >>> 0, firstSeq: seq, mtu: 800 });
                seq += packets.length;
                ts += 3000;
                feed(depacketizer, packets);
            }
            frames.should.have.length(6);
            frames[5].timestamp.should.equal((4294967000 + 15000) >>> 0);
        });

        it('ignores empty payloads and garbage descriptors', () => {
            const { depacketizer, frames } = collect(make);
            depacketizer.push({ timestamp: 1, marker: true, payload: Buffer.alloc(0), arrivalMs: 0 });
            depacketizer.push({ timestamp: 2, marker: true, payload: Buffer.from([0x80]), arrivalMs: 0 });
            depacketizer.push({ timestamp: 3, marker: true, payload: Buffer.from([0x90, 0xf0, 0x80]), arrivalMs: 0 });
            frames.should.have.length(0);
        });

        it('reports the arrival time of the first packet of the frame', () => {
            const { depacketizer, frames } = collect(make);
            const packets = gen.vp8Packets(gen.vp8Frame({ key: true, size: 3000 }), { timestamp: 1, mtu: 1000 });
            feed(depacketizer, [packets[0]], 5000);
            feed(depacketizer, packets.slice(1), 5040);
            frames[0].arrivalMs.should.equal(5000);
        });
    });

    describe('H.264 (RFC 6184)', () => {
        const sps = gen.h264Sps({ width: 1280, height: 720 });
        const pps = gen.h264Pps();

        it('assembles an access unit of STAP-A (SPS, PPS) and FU-A (IDR) packets into Annex-B', () => {
            const { depacketizer, frames } = collect((cb) => new H264Depacketizer(cb));
            const idr = gen.h264Nal(5, 5000);
            const packets = gen.h264Packets([sps, pps, idr], { timestamp: 9000, mtu: 1200 });
            packets.length.should.be.greaterThan(3);
            ((packets[0][12] & 0x1f) === 24).should.be.true(); // the first packet is a STAP-A
            feed(depacketizer, packets);
            frames.should.have.length(1);
            frames[0].key.should.be.true();
            frames[0].width.should.equal(1280);
            frames[0].height.should.equal(720);
            h264.splitAnnexB(frames[0].data)
                .map((n) => n[0] & 0x1f)
                .should.deepEqual([7, 8, 5]);
            h264.splitAnnexB(frames[0].data)[2].equals(idr).should.be.true();
        });

        it('produces length prefixed NAL units when asked, with the same content', () => {
            const { depacketizer, frames } = collect((cb) => new H264Depacketizer(cb, { format: 'avcc' }));
            const idr = gen.h264Nal(5, 4000);
            feed(depacketizer, gen.h264Packets([sps, pps, idr], { timestamp: 9000 }));
            const nals = h264.avccNals(frames[0].data);
            nals.map((n) => n[0] & 0x1f).should.deepEqual([7, 8, 5]);
            nals[2].equals(idr).should.be.true();
            frames[0].data.length.should.equal(3 * 4 + sps.length + pps.length + idr.length);
        });

        it('handles single NAL unit packets and non-IDR slices (delta frames)', () => {
            const { depacketizer, frames } = collect((cb) => new H264Depacketizer(cb));
            feed(
                depacketizer,
                gen.h264Packets([sps, pps, gen.h264Nal(5, 300)], { timestamp: 1000, aggregate: false, firstSeq: 0 })
            );
            const slice = gen.h264Nal(1, 700, { seed: 11 });
            feed(depacketizer, gen.h264Packets([slice], { timestamp: 4000, firstSeq: 10 }));
            frames.map((f) => f.key).should.deepEqual([true, false]);
            h264.splitAnnexB(frames[1].data)[0].equals(slice).should.be.true();
        });

        it('adds the latest SPS/PPS to a key frame that arrives without them', () => {
            const { depacketizer, frames } = collect((cb) => new H264Depacketizer(cb));
            feed(depacketizer, gen.h264Packets([sps, pps, gen.h264Nal(5, 300)], { timestamp: 1000 }));
            const idr2 = gen.h264Nal(5, 2500, { seed: 3 });
            feed(depacketizer, gen.h264Packets([idr2], { timestamp: 91000, firstSeq: 20 }));
            frames.should.have.length(2);
            frames[1].key.should.be.true();
            h264.splitAnnexB(frames[1].data)
                .map((n) => n[0] & 0x1f)
                .should.deepEqual([7, 8, 5]);
        });

        it('does not call an IDR a key frame while no parameter sets were ever seen', () => {
            const { depacketizer, frames } = collect((cb) => new H264Depacketizer(cb));
            feed(depacketizer, gen.h264Packets([gen.h264Nal(5, 300)], { timestamp: 1000 }));
            frames.should.have.length(1);
            frames[0].key.should.be.false();
        });

        it('takes the parameter sets of the fmtp (sprop-parameter-sets) as a start', () => {
            const sprop = `${sps.toString('base64')},${pps.toString('base64')}`;
            const { depacketizer, frames } = collect((cb) => new H264Depacketizer(cb, { sprop }));
            feed(depacketizer, gen.h264Packets([gen.h264Nal(5, 300)], { timestamp: 1000 }));
            frames[0].key.should.be.true();
            frames[0].width.should.equal(1280);
        });

        it('drops an access unit whose fragments were interrupted', () => {
            const { depacketizer, frames } = collect((cb) => new H264Depacketizer(cb));
            const packets = gen.h264Packets([sps, pps, gen.h264Nal(5, 6000)], { timestamp: 1000 });
            feed(depacketizer, packets.slice(0, 3));
            depacketizer.reset();
            feed(depacketizer, packets.slice(4)); // continuation fragments, the start is gone
            frames.should.have.length(0);
            feed(depacketizer, gen.h264Packets([sps, pps, gen.h264Nal(5, 700)], { timestamp: 4000, firstSeq: 30 }));
            frames.should.have.length(1);
            frames[0].key.should.be.true();
        });

        it('refuses a key frame whose first slice is missing', () => {
            const { depacketizer, frames } = collect((cb) => new H264Depacketizer(cb));
            feed(depacketizer, gen.h264Packets([sps, pps, gen.h264Nal(5, 200)], { timestamp: 1000 }));
            feed(
                depacketizer,
                gen.h264Packets([gen.h264Nal(5, 300, { first: false })], { timestamp: 91000, firstSeq: 9 })
            );
            frames.should.have.length(1); // only the first, intact key frame
        });

        it('splits a picture of several slices that share one timestamp', () => {
            const { depacketizer, frames } = collect((cb) => new H264Depacketizer(cb));
            const slices = [
                gen.h264Nal(1, 500, { seed: 1 }),
                gen.h264Nal(1, 600, { seed: 2, first: false }),
                gen.h264Nal(1, 400, { seed: 3, first: false }),
            ];
            feed(depacketizer, gen.h264Packets([sps, pps, gen.h264Nal(5, 100)], { timestamp: 1000 }));
            feed(depacketizer, gen.h264Packets(slices, { timestamp: 4000, firstSeq: 10, aggregate: false }));
            frames.should.have.length(2);
            h264.splitAnnexB(frames[1].data).should.have.length(3);
        });
    });

    describe('Opus (RFC 7587)', () => {
        it('turns every packet into one frame', () => {
            const frames = [];
            const depacketizer = new OpusDepacketizer((f) => frames.push(f));
            for (let i = 0; i < 5; i++) {
                const payload = gen.opusPacket({ size: 50 + i, seed: i + 1 });
                const h = parseRtp(gen.opusRtp(payload, { timestamp: i * 960, sequenceNumber: i }));
                depacketizer.push({ seq: i, timestamp: h.timestamp, marker: false, payload, arrivalMs: 100 + i * 20 });
            }
            frames.should.have.length(5);
            frames[3].timestamp.should.equal(2880);
            frames[3].data.length.should.equal(53);
            depacketizer.push({ seq: 9, timestamp: 1, marker: false, payload: Buffer.alloc(0), arrivalMs: 0 });
            frames.should.have.length(5);
        });
    });

    describe('createDepacketizer', () => {
        it('picks the depacketizer by codec name and refuses the others', () => {
            createDepacketizer('VP8', () => {}).should.be.instanceOf(Vp8Depacketizer);
            createDepacketizer('h264', () => {}).should.be.instanceOf(H264Depacketizer);
            createDepacketizer('opus', () => {}).should.be.instanceOf(OpusDepacketizer);
            (() => createDepacketizer('vp9', () => {})).should.throw(/unsupported/);
        });
    });

    describe('H.264 and Opus helpers', () => {
        it('parses the picture size of Sequence Parameter Sets, with and without cropping and chroma fields', () => {
            for (const [width, height, profile, scalingMatrix] of [
                [1280, 720, 66, false],
                [1920, 1080, 66, false],
                [1920, 1080, 100, false],
                [2560, 1440, 100, true],
                [1366, 768, 100, false],
                [640, 360, 77, false],
            ]) {
                const info = h264.parseSps(gen.h264Sps({ width, height, profile, scalingMatrix }));
                info.width.should.equal(width, `${width}x${height} profile ${profile}`);
                info.height.should.equal(height, `${width}x${height} profile ${profile}`);
                info.profileIdc.should.equal(profile);
            }
            (h264.parseSps(Buffer.from([0x67, 0x42])) === null).should.be.true();
            (h264.parseSps(Buffer.from([0x68, 0xce, 0x3c, 0x80, 1])) === null).should.be.true();
        });

        it('builds the avcC record', () => {
            const sps = gen.h264Sps({ width: 1920, height: 1080, profile: 66 });
            const pps = gen.h264Pps();
            const avcc = h264.buildAvcC(sps, pps);
            avcc[0].should.equal(1);
            avcc[1].should.equal(66);
            avcc[4].should.equal(0xff);
            avcc[5].should.equal(0xe1);
            avcc.readUInt16BE(6).should.equal(sps.length);
            avcc.subarray(8, 8 + sps.length)
                .equals(sps)
                .should.be.true();
            avcc[8 + sps.length].should.equal(1);
            avcc.length.should.equal(11 + sps.length + pps.length);
            const high = h264.buildAvcC(gen.h264Sps({ profile: 100 }), pps);
            high.length.should.equal(11 + gen.h264Sps({ profile: 100 }).length + pps.length + 4);
        });

        it('converts between Annex-B and length prefixed layouts', () => {
            const nals = [gen.h264Nal(7, 20), gen.h264Nal(8, 6), gen.h264Nal(5, 3000)];
            const annexB = Buffer.concat(
                nals.flatMap((n, i) => [i === 0 ? Buffer.from([0, 0, 0, 1]) : Buffer.from([0, 0, 1]), n])
            );
            h264.splitAnnexB(annexB).should.have.length(3);
            const avcc = h264.annexBToAvcc(annexB);
            h264.avccNals(avcc)
                .map((n, i) => n.equals(nals[i]))
                .should.deepEqual([true, true, true]);
            h264.splitAnnexB(h264.avccToAnnexB(avcc))
                .map((n, i) => n.equals(nals[i]))
                .should.deepEqual([true, true, true]);
        });

        it('computes the duration of Opus packets from the TOC byte', () => {
            opus.opusPacketDurationMs(Buffer.from([0xf8, 1, 2])).should.equal(20); // CELT FB 20 ms
            opus.opusPacketDurationMs(Buffer.from([0xe0, 1])).should.equal(2.5); // CELT NB 2.5 ms
            opus.opusPacketDurationMs(Buffer.from([0x78, 1])).should.equal(20); // hybrid FB 20 ms
            opus.opusPacketDurationMs(Buffer.from([0x0b, 3])).should.equal(60); // SILK NB 20 ms, code 3: 3 frames
            opus.opusPacketDurationMs(Buffer.from([0xf9, 1])).should.equal(40); // code 1: two frames
            opus.opusPacketDurationMs(Buffer.alloc(0)).should.equal(20);
            opus.OPUS_SILENCE_FRAME.length.should.equal(3);
            const head = opus.buildOpusHead({ channels: 2 });
            head.subarray(0, 8).toString().should.equal('OpusHead');
            head.length.should.equal(19);
            head.readUInt16LE(10).should.equal(312);
        });
    });
});
