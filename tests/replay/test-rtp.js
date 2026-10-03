'use strict';

require('should');

const rtp = require('../../app/src/replay/rtp');
const { buildRtp, parseRtp, parseRtcp, buildNack, buildPli, buildSenderReport, isRtcp } = rtp;

describe('replay: RTP and RTCP', () => {
    describe('parseRtp', () => {
        it('reads the fixed header', () => {
            const payload = Buffer.from('hello');
            const buf = buildRtp({
                payloadType: 101,
                sequenceNumber: 65535,
                timestamp: 4294967295,
                ssrc: 0xdeadbeef,
                marker: true,
                payload,
            });
            const h = parseRtp(buf);
            h.marker.should.be.true();
            h.payloadType.should.equal(101);
            h.sequenceNumber.should.equal(65535);
            h.timestamp.should.equal(4294967295);
            h.ssrc.should.equal(0xdeadbeef);
            h.payloadOffset.should.equal(12);
            h.payloadEnd.should.equal(17);
            buf.subarray(h.payloadOffset, h.payloadEnd).equals(payload).should.be.true();
        });

        it('skips CSRCs and the header extension to find the payload', () => {
            const payload = Buffer.from('payload!');
            const buf = buildRtp({
                payloadType: 96,
                sequenceNumber: 1,
                timestamp: 2,
                ssrc: 3,
                csrcs: [10, 20, 30],
                extension: { profile: 0xbede, data: Buffer.from([0x10, 0xaa, 0x20, 0xbb, 0xcc, 0, 0, 0]) },
                payload,
            });
            const h = parseRtp(buf);
            h.csrcCount.should.equal(3);
            h.hasExtension.should.be.true();
            h.extensionProfile.should.equal(0xbede);
            h.extensionLength.should.equal(8);
            h.payloadOffset.should.equal(12 + 12 + 4 + 8);
            buf.subarray(h.payloadOffset, h.payloadEnd).toString().should.equal('payload!');
        });

        it('removes the padding from the payload', () => {
            const buf = buildRtp({
                payloadType: 96,
                sequenceNumber: 1,
                timestamp: 2,
                ssrc: 3,
                payload: Buffer.from('abc'),
                padding: 4,
            });
            const h = parseRtp(buf);
            h.paddingLength.should.equal(4);
            buf.subarray(h.payloadOffset, h.payloadEnd).toString().should.equal('abc');
        });

        it('handles an empty payload', () => {
            const h = parseRtp(buildRtp({ payloadType: 96, sequenceNumber: 1, timestamp: 2, ssrc: 3 }));
            h.payloadEnd.should.equal(h.payloadOffset);
        });

        it('refuses malformed packets without throwing', () => {
            const good = buildRtp({
                payloadType: 96,
                sequenceNumber: 1,
                timestamp: 2,
                ssrc: 3,
                payload: Buffer.alloc(20),
            });
            (parseRtp(Buffer.alloc(0)) === null).should.be.true();
            (parseRtp(good.subarray(0, 11)) === null).should.be.true();
            const wrongVersion = Buffer.from(good);
            wrongVersion[0] = 0x40;
            (parseRtp(wrongVersion) === null).should.be.true();
            const cc = Buffer.from(good.subarray(0, 14));
            cc[0] = 0x8f; // 15 CSRCs do not fit
            (parseRtp(cc) === null).should.be.true();
            const ext = Buffer.from(good.subarray(0, 14));
            ext[0] = 0x90; // extension header does not fit
            (parseRtp(ext) === null).should.be.true();
            const longExt = Buffer.from(good);
            longExt[0] = 0x90;
            longExt.writeUInt16BE(1000, 14); // extension longer than the packet
            (parseRtp(longExt) === null).should.be.true();
            const padded = Buffer.from(good);
            padded[0] |= 0x20;
            padded[padded.length - 1] = 200; // more padding than packet
            (parseRtp(padded) === null).should.be.true();
            padded[padded.length - 1] = 0; // zero padding length is invalid
            (parseRtp(padded) === null).should.be.true();
        });

        it('survives random garbage', () => {
            for (let i = 0; i < 2000; i++) {
                const buf = Buffer.allocUnsafe(1 + (i % 60));
                for (let j = 0; j < buf.length; j++) buf[j] = (i * 31 + j * 17 + (i >> 3)) & 0xff;
                const h = parseRtp(buf);
                if (h) {
                    h.payloadOffset.should.be.within(12, buf.length);
                    h.payloadEnd.should.be.within(h.payloadOffset, buf.length);
                }
                parseRtcp(buf); // must not throw either
            }
        });
    });

    describe('isRtcp', () => {
        it('recognizes RTCP by the second byte (192-223), RTP payload types stay RTP', () => {
            for (const pt of [200, 201, 202, 203, 205, 206, 207]) {
                isRtcp(Buffer.from([0x80, pt, 0, 6, 0, 0, 0, 1])).should.be.true();
            }
            for (const pt of [96, 100, 101, 102, 111, 127]) {
                isRtcp(buildRtp({ payloadType: pt, sequenceNumber: 1, timestamp: 1, ssrc: 1 })).should.be.false();
                isRtcp(
                    buildRtp({ payloadType: pt, sequenceNumber: 1, timestamp: 1, ssrc: 1, marker: true })
                ).should.be.false();
            }
            isRtcp(Buffer.alloc(4)).should.be.false();
        });
    });

    describe('Sender Reports', () => {
        it('converts NTP time to Unix milliseconds', () => {
            const ms = Date.UTC(2026, 9, 3, 14, 15, 2, 345);
            const sr = parseRtcp(
                buildSenderReport({ ssrc: 99, ntpMs: ms, rtpTimestamp: 123456, packetCount: 7, octetCount: 900 })
            )[0];
            sr.type.should.equal('sr');
            sr.ssrc.should.equal(99);
            sr.rtpTimestamp.should.equal(123456);
            sr.packetCount.should.equal(7);
            sr.octetCount.should.equal(900);
            sr.ntpMs.should.be.approximately(ms, 0.01);
        });

        it('has no time when the NTP field is zero', () => {
            const sr = buildSenderReport({ ssrc: 1, ntpMs: 0, rtpTimestamp: 5 });
            sr.fill(0, 8, 16);
            (parseRtcp(sr)[0].ntpMs === null).should.be.true();
        });

        it('reads compound packets and skips what it does not know', () => {
            const ms = 1791036902123;
            const sdes = Buffer.from([0x81, 202, 0, 3, 0, 0, 0, 1, 1, 4, 0x61, 0x62, 0x63, 0x64, 0, 0]); // SDES with a CNAME
            const rr = Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 9]);
            const compound = Buffer.concat([
                rr,
                buildSenderReport({ ssrc: 5, ntpMs: ms, rtpTimestamp: 1000 }),
                sdes,
                buildSenderReport({ ssrc: 6, ntpMs: ms + 1, rtpTimestamp: 2000 }),
                Buffer.from([0x8f, 255, 0, 1, 0, 0, 0, 0]), // unknown type
            ]);
            const packets = parseRtcp(compound);
            packets
                .map((p) => [p.type, p.ssrc])
                .should.deepEqual([
                    ['sr', 5],
                    ['sr', 6],
                ]);
        });

        it('stops quietly at a truncated or corrupt element and keeps what it already parsed', () => {
            const sr = buildSenderReport({ ssrc: 5, ntpMs: 1791036902123, rtpTimestamp: 1000 });
            parseRtcp(Buffer.concat([sr, sr.subarray(0, 20)])).should.have.length(1);
            parseRtcp(sr.subarray(0, 20)).should.have.length(0);
            parseRtcp(Buffer.concat([sr, Buffer.from([0x00, 200, 0, 6, 0, 0, 0, 0])])).should.have.length(1);
            parseRtcp(Buffer.alloc(0)).should.have.length(0);
        });
    });

    describe('Generic NACK', () => {
        it('packs sequence numbers in PID + bitmask entries', () => {
            const buf = buildNack(0x11111111, 0x22222222, [100, 101, 103, 116, 117, 200]);
            buf[0].should.equal(0x81); // V=2, FMT=1
            buf[1].should.equal(205);
            buf.readUInt16BE(2).should.equal(2 + 3); // header words after the first + three FCI entries
            buf.readUInt32BE(4).should.equal(0x11111111);
            buf.readUInt32BE(8).should.equal(0x22222222);
            // 100 + {101: bit 0, 103: bit 2, 116: bit 15}
            buf.readUInt16BE(12).should.equal(100);
            buf.readUInt16BE(14).should.equal(0b1000000000000101);
            // 117 is 17 after 100: a new entry
            buf.readUInt16BE(16).should.equal(117);
            buf.readUInt16BE(18).should.equal(0);
            buf.readUInt16BE(20).should.equal(200);
            buf.length.should.equal(24);
        });

        it('round trips through the parser, in any input order, with duplicates', () => {
            const seqs = [5000, 4990, 5001, 5001, 5017, 5018, 4999];
            const nack = parseRtcp(buildNack(1, 2, seqs))[0];
            nack.type.should.equal('nack');
            nack.mediaSsrc.should.equal(2);
            nack.senderSsrc.should.equal(1);
            nack.seqs
                .slice()
                .sort((a, b) => a - b)
                .should.deepEqual([4990, 4999, 5000, 5001, 5017, 5018]);
        });

        it('works across the 16 bit sequence wrap', () => {
            const buf = buildNack(1, 2, [1, 65535, 0, 65534]);
            buf.readUInt16BE(2).should.equal(3); // one entry
            buf.readUInt16BE(12).should.equal(65534);
            buf.readUInt16BE(14).should.equal(0b111);
            parseRtcp(buf)[0]
                .seqs.slice()
                .sort((a, b) => a - b)
                .should.deepEqual([0, 1, 65534, 65535]);
        });
    });

    describe('PLI', () => {
        it('is an RTCP PSFB (206) with FMT 1 and the two SSRCs', () => {
            const buf = buildPli(0xaabbccdd, 0x01020304);
            buf.length.should.equal(12);
            buf[0].should.equal(0x81);
            buf[1].should.equal(206);
            buf.readUInt16BE(2).should.equal(2);
            parseRtcp(buf)[0].should.deepEqual({ type: 'pli', senderSsrc: 0xaabbccdd, mediaSsrc: 0x01020304 });
        });
    });

    describe('sequence and timestamp arithmetic', () => {
        it('seqDiff is the signed distance on a 16 bit circle', () => {
            rtp.seqDiff(10, 5).should.equal(5);
            rtp.seqDiff(5, 10).should.equal(-5);
            rtp.seqDiff(2, 65534).should.equal(4);
            rtp.seqDiff(65534, 2).should.equal(-4);
            rtp.seqDiff(0, 0).should.equal(0);
        });

        it('tsDiff is the signed distance on a 32 bit circle', () => {
            rtp.tsDiff(100, 50).should.equal(50);
            rtp.tsDiff(10, 4294967290).should.equal(16);
            rtp.tsDiff(4294967290, 10).should.equal(-16);
        });

        it('TimestampUnwrapper keeps counting across the wrap and tolerates late packets', () => {
            const u = new rtp.TimestampUnwrapper();
            const start = u.unwrap(4294967000);
            u.unwrap(4294967200).should.equal(start + 200);
            u.unwrap(100).should.equal(start + 396); // wrapped
            u.unwrap(4294967290).should.equal(start + 290); // late, from before the wrap: no move back
            u.unwrap(200).should.equal(start + 496);
            u.near(4294967295).should.equal(start + 295);
            u.near(300).should.equal(start + 596);
        });

        it('TimestampUnwrapper accepts big jumps forward (a paused stream)', () => {
            const u = new rtp.TimestampUnwrapper();
            const start = u.unwrap(1000);
            u.unwrap(1000 + 27000000).should.equal(start + 27000000); // 5 minutes at 90 kHz
        });
    });
});
