'use strict';

require('should');

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const HealthMeter = require('../app/src/HealthMeter');
const { sanitize } = HealthMeter;

const rx = { id: 'abc-123', type: 'screen', fps: 59.4, w: 1920, h: 1080, kbps: 9100, loss: 0.3, frz: 0, dec: 'ExternalDecoder', hw: true };
const tx = { type: 'screen', fps: 60, w: 1920, h: 1080, kbps: 9800, lim: 'cpu', enc: 'libvpx', hw: false, kf: 1, pli: 1 };

describe('test-HealthMeter', () => {
    describe('sanitize', () => {
        it('keeps the allowed fields and drops everything else', () => {
            const clean = sanitize({
                dt: 10000,
                rx: [{ ...rx, secret: 'x', ip: '1.2.3.4' }],
                tx: [{ ...tx, candidate: '10.0.0.1' }],
                net: { rtt: 120, aout: 12000, ain: 50000, address: '1.2.3.4' },
                cookie: 'nope',
            });

            clean.rx[0].should.deepEqual(rx);
            clean.tx[0].should.deepEqual(tx);
            clean.net.should.deepEqual({ rtt: 120, aout: 12000, ain: 50000 });
            clean.should.not.have.property('cookie');
            JSON.stringify(clean).should.not.match(/1\.2\.3\.4|10\.0\.0\.1|nope|secret/);
        });

        it('rounds and clamps numbers, drops wrong types and bad labels', () => {
            const clean = sanitize({
                rx: [
                    { type: 'screen', fps: 1e9, loss: -5, kbps: '9000', w: NaN, dec: '<script>alert(1)</script>', hw: 'yes', id: 'x'.repeat(80) },
                    { type: 'hologram', fps: 30 },
                ],
            });

            clean.rx.should.have.length(2);
            clean.rx[0].should.deepEqual({ type: 'screen', fps: 240, loss: 0 });
            clean.rx[1].should.deepEqual({ fps: 30 });
        });

        it('limits the number of streams and the size of a report', () => {
            const many = sanitize({ rx: Array.from({ length: 14 }, () => rx), tx: Array.from({ length: 8 }, () => tx) });
            many.rx.should.have.length(12);
            many.tx.should.have.length(6);

            (sanitize({ rx: [rx], padding: 'p'.repeat(13000) }) === null).should.be.true();
        });

        // The fields that tell a slow capture from a slow encoder from a bad line, and what the viewer asked of the server
        it('accepts the diagnostic fields of a sender, a viewer and the page (the build, whether it is visible)', () => {
            const sender = {
                pid: 'a1b2c3d4', type: 'screen', fps: 15.8, w: 1920, h: 1080, encMs: 32.4, lim: 'none', hw: false,
                srcFps: 16.2, srcW: 2560, srcH: 1440, setW: 1920, setH: 1080, setFps: 60,
                scale: 1.25, maxKbps: 9000, maxFps: 60, degr: 'maintain-framerate', hint: 'motion', codec: 'VP8',
                retx: 12.5, huge: 1, qlr: 2, sendMs: 4.5, gRung: 1, gWhy: 'uplink', gMode: 'observe',
            };
            const viewer = { pid: 'a1b2c3d4', from: 'Sender One', type: 'screen', fps: 29, tl: 1, lw: 'struggle', tw: 650, decMs: 11.2, pause: 0 };
            const clean = sanitize({ cb: 'b707d0a', vis: false, tx: [sender], rx: [viewer] });
            clean.cb.should.equal('b707d0a');
            clean.vis.should.be.false();
            clean.tx[0].should.deepEqual(sender);
            clean.rx[0].should.deepEqual(viewer);
        });

        it('drops a diagnostic label that is not in the list, and the commit of the page when it is not plain', () => {
            const clean = sanitize({ cb: '<script>', tx: [{ type: 'screen', fps: 60, degr: 'whatever', hint: 'x', codec: 'MPEG', gMode: 'both', gWhy: 'a;b' }] });
            clean.should.not.have.property('cb');
            clean.tx[0].should.deepEqual({ type: 'screen', fps: 60 });
        });

        it('accepts the graphics card, the screen and the codecs the browser says it can encode and decode', () => {
            const clean = sanitize({ env: { gpu: 'AMD Radeon RX 9060 XT', scr: '2560x1440@1', caps: { vp9e: 'sw', vp9d: 'hw', av1e: 'sw', av1d: 'hw', vp8d: 'sw' } } });
            clean.env.should.deepEqual({ gpu: 'AMD Radeon RX 9060 XT', scr: '2560x1440@1', caps: { vp9e: 'sw', vp9d: 'hw', av1e: 'sw', av1d: 'hw', vp8d: 'sw' } });
        });

        it('refuses reports that are not objects or have nothing in them', () => {
            for (const bad of [null, undefined, 'text', 42, [], {}, { rx: [] }, { rx: ['x', null] }, { net: { rtt: 5 } }]) {
                (sanitize(bad) === null).should.be.true();
            }
        });

        it('accepts the environment report with short labels only', () => {
            const clean = sanitize({
                env: {
                    browser: 'Google Chrome 154, Chromium 154',
                    os: 'Windows',
                    cores: 12,
                    mem: 8,
                    caps: { vp8e: 'sw', h264e: 'hw', vp8d: 'hw!smooth', h264d: 'weird', extra: 'hw' },
                },
            });

            clean.env.should.deepEqual({
                browser: 'Google Chrome 154, Chromium 154',
                os: 'Windows',
                cores: 12,
                mem: 8,
                caps: { vp8e: 'sw', h264e: 'hw', vp8d: 'hw!smooth' },
            });
        });
    });

    describe('recording', () => {
        let dir;
        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
        });
        afterEach(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        const meter = (extra = {}) =>
            new HealthMeter({ HEALTH_METER_ENABLED: 'true', HEALTH_DIR: dir, HEALTH_INTERVAL_S: '10', ...extra });

        it('is off unless enabled and given a directory', () => {
            new HealthMeter({}).enabled.should.be.false();
            new HealthMeter({ HEALTH_METER_ENABLED: 'true' }).enabled.should.be.false();
            new HealthMeter({ HEALTH_DIR: dir }).enabled.should.be.false();
            meter().enabled.should.be.true();
            new HealthMeter({}).record({ socketId: 'a', roomId: 'link', peerName: 'Ana', report: { rx: [rx] } }).should.be.false();
        });

        it('limits each browser to about one report per interval', () => {
            const m = meter();
            const base = { socketId: 's1', roomId: 'link', peerName: 'Ana', report: { rx: [rx] } };

            m.record({ ...base, now: 1_000_000 }).should.be.true();
            m.record({ ...base, now: 1_002_000 }).should.be.false();
            m.record({ ...base, now: 1_006_000 }).should.be.true();
            m.record({ ...base, socketId: 's2', now: 1_006_100 }).should.be.true();
            m.record({ ...base, report: { junk: 1 }, now: 1_100_000 }).should.be.false();
        });

        it('writes one JSON line per report into the file of its day', async () => {
            const m = meter();
            const noon = Date.UTC(2026, 9, 3, 12, 0, 0);
            const nextDay = Date.UTC(2026, 9, 4, 0, 0, 5);
            m.record({ socketId: 's1', roomId: 'link', peerName: 'Ana', report: { rx: [rx] }, now: noon });
            m.record({ socketId: 's2', roomId: 'link', peerName: 'Beto', report: { tx: [tx] }, now: nextDay });
            await m.flush();

            const lines = fs.readFileSync(path.join(dir, 'health-2026-10-03.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
            lines.should.have.length(1);
            lines[0].should.containEql({ ts: noon, room: 'link', peer: 'Ana' });
            lines[0].rx[0].fps.should.equal(59.4);
            JSON.parse(fs.readFileSync(path.join(dir, 'health-2026-10-04.jsonl'), 'utf8').trim()).peer.should.equal('Beto');
        });

        it('compresses finished days and deletes compressed days past the retention', async () => {
            const m = meter({ HEALTH_RETENTION_DAYS: '3' });
            const now = Date.UTC(2026, 9, 10, 12, 0, 0);
            fs.writeFileSync(path.join(dir, 'health-2026-10-09.jsonl'), '{"a":1}\n');
            fs.writeFileSync(path.join(dir, 'health-2026-10-10.jsonl'), '{"today":1}\n');
            fs.writeFileSync(path.join(dir, 'health-2026-10-01.jsonl.gz'), zlib.gzipSync('{"old":1}\n'));
            fs.writeFileSync(path.join(dir, 'health-2026-10-08.jsonl.gz'), zlib.gzipSync('{"keep":1}\n'));
            fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');

            await m.maintenance(now);

            fs.existsSync(path.join(dir, 'health-2026-10-09.jsonl')).should.be.false();
            zlib.gunzipSync(fs.readFileSync(path.join(dir, 'health-2026-10-09.jsonl.gz'))).toString().should.equal('{"a":1}\n');
            fs.existsSync(path.join(dir, 'health-2026-10-10.jsonl')).should.be.true();
            fs.existsSync(path.join(dir, 'health-2026-10-01.jsonl.gz')).should.be.false();
            fs.existsSync(path.join(dir, 'health-2026-10-08.jsonl.gz')).should.be.true();
            fs.existsSync(path.join(dir, 'notes.txt')).should.be.true();
        });
    });
});
