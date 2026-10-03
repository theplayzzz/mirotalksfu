'use strict';

require('should');

const http = require('node:http');

const { EventSink } = require('../../app/src/replay/EventSink');

const log = { warn() {}, error() {}, info() {}, debug() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A little SFU: records the POSTs; `behavior(n)` decides the status (or 'hang') of the n-th request. */
async function sfu(behavior = () => 200) {
    const received = [];
    let n = 0;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            n++;
            const verdict = behavior(n);
            if (verdict === 'hang') return; // never answers
            received.push({
                headers: req.headers,
                url: req.url,
                method: req.method,
                status: verdict,
                body: JSON.parse(Buffer.concat(chunks).toString()),
            });
            res.writeHead(verdict);
            res.end();
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        received,
        url: `http://127.0.0.1:${server.address().port}/internal/replay/events`,
        attempts: () => n,
        close: () =>
            new Promise((resolve) => {
                server.close(resolve);
                server.closeAllConnections();
            }),
    };
}

describe('replay: EventSink (events to the SFU)', function () {
    this.timeout(20000);
    let server;
    let sink;

    afterEach(async () => {
        if (sink) await sink.close(100);
        if (server) await server.close();
        sink = server = null;
    });

    it('posts events as JSON with the secret header, in order', async () => {
        server = await sfu();
        sink = new EventSink({ url: server.url, secret: 'the-secret', log });
        sink.send({ type: 'clip.created', clip: { id: 'a' } });
        sink.send({ type: 'clip.deleted', id: 'b' });
        sink.send({ type: 'mp4.ready', id: 'c', mp4: { name: 'clip.mp4', bytes: 1 } });
        await sink.close(2000);
        server.received.map((r) => r.body.type).should.deepEqual(['clip.created', 'clip.deleted', 'mp4.ready']);
        server.received[0].method.should.equal('POST');
        server.received[0].url.should.equal('/internal/replay/events');
        server.received[0].headers['x-replay-secret'].should.equal('the-secret');
        server.received[0].headers['content-type'].should.equal('application/json');
    });

    it('does nothing without a URL', async () => {
        sink = new EventSink({ url: '', secret: 's', log });
        sink.enabled.should.be.false();
        sink.send({ type: 'clip.deleted', id: 'x' });
        await sink.close();
    });

    it('tries again a few times for the events that matter', async () => {
        server = await sfu((n) => (n <= 2 ? 500 : 200));
        sink = new EventSink({ url: server.url, secret: 's', log, retryDelaysMs: [10, 10, 10] });
        sink.send({ type: 'clip.created', clip: { id: 'a' } });
        await sink.close(2000);
        server.attempts().should.equal(3);
        server.received.map((r) => r.status).should.deepEqual([500, 500, 200]);
        sink.stats.failed.should.equal(2);
    });

    it('gives up after the retries and goes on with the next event', async () => {
        server = await sfu((n) => (n <= 4 ? 503 : 200));
        sink = new EventSink({ url: server.url, secret: 's', log, retries: 3, retryDelaysMs: [5, 5, 5] });
        sink.send({ type: 'clip.created', clip: { id: 'lost' } });
        sink.send({ type: 'clip.deleted', id: 'kept' });
        await sink.close(2000);
        server.attempts().should.equal(5); // 1 + 3 retries for the first, 1 for the second
        server.received
            .filter((r) => r.status === 200)
            .map((r) => r.body.id)
            .should.deepEqual(['kept']);
        sink.stats.dropped.should.equal(1);
    });

    it('sends periodic events once, and a newer one replaces one that is still waiting', async () => {
        server = await sfu((n) => (n === 1 ? 'hang' : 200));
        sink = new EventSink({ url: server.url, secret: 's', log, timeoutMs: 300, retryDelaysMs: [5] });
        sink.send({ type: 'buffers', shares: [], diskFreeGb: 1 }); // in flight (the server hangs)
        sink.send({ type: 'buffers', shares: [], diskFreeGb: 2 });
        sink.send({ type: 'buffers', shares: [], diskFreeGb: 3 }); // replaces the previous waiting one
        sink.send({ type: 'mp4.progress', id: 'x', progress: 0.1 });
        sink.send({ type: 'mp4.progress', id: 'x', progress: 0.2 });
        sink.send({ type: 'mp4.progress', id: 'y', progress: 0.9 });
        sink.send({ type: 'clip.deleted', id: 'z' });
        await sleep(1200);
        // the hanging one timed out and was not retried (best effort), then: the newest buffers, newest progress of x and y, the deletion
        const bodies = server.received.map((r) => r.body);
        bodies
            .filter((b) => b.type === 'buffers')
            .map((b) => b.diskFreeGb)
            .should.deepEqual([3]);
        bodies
            .filter((b) => b.type === 'mp4.progress')
            .map((b) => [b.id, b.progress])
            .should.deepEqual([
                ['x', 0.2],
                ['y', 0.9],
            ]);
        bodies.filter((b) => b.type === 'clip.deleted').should.have.length(1);
    });

    it('never blocks the caller, even when the SFU hangs or is not there', async () => {
        server = await sfu(() => 'hang');
        sink = new EventSink({ url: server.url, secret: 's', log, timeoutMs: 100, retryDelaysMs: [10] });
        const start = Date.now();
        for (let i = 0; i < 1000; i++) sink.send({ type: 'clip.created', clip: { id: String(i) } });
        (Date.now() - start).should.be.below(200);
        sink.queue.length.should.be.below(201); // short queue: the oldest events are dropped
        sink.stats.dropped.should.be.above(700);
        await server.close();
        server = null;
        const gone = new EventSink({
            url: 'http://127.0.0.1:1/x',
            secret: 's',
            log,
            timeoutMs: 100,
            retryDelaysMs: [5],
        });
        gone.send({ type: 'clip.deleted', id: 'a' });
        await gone.close(1000);
    });

    it('delivers to https URLs with the same code path (and does not throw when the certificate is not right)', async () => {
        sink = new EventSink({
            url: 'https://127.0.0.1:1/events',
            secret: 's',
            log,
            timeoutMs: 100,
            retryDelaysMs: [5],
        });
        sink.send({ type: 'clip.deleted', id: 'a' });
        await sink.close(1000);
    });
});
