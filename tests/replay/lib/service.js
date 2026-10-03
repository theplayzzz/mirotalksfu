'use strict';

/**
 * Starts a recorder in-process for the tests: ephemeral ports, a temporary data directory, a silent logger, and a
 * little client of its HTTP API. Events are collected in `events` (and can be awaited with `waitForEvent`).
 */

const http = require('node:http');
const path = require('node:path');

const { createRecorder } = require('../../../app/src/replay/Recorder');
const media = require('./media');

const SECRET = 'test-secret-not-a-real-one';
const silent = { debug() {}, info() {}, log() {}, warn() {}, error() {} };

async function startRecorder(overrides = {}) {
    const dir = overrides.dataDir || media.tmpDir('replay-svc-');
    const recorder = createRecorder({
        dataDir: dir,
        secret: SECRET,
        listenPort: 0,
        host: '127.0.0.1',
        bindHost: '127.0.0.1',
        recvBufferMb: 2,
        housekeepingMs: 60 * 60 * 1000,
        log: process.env.REPLAY_TEST_LOG ? console : silent,
        ...overrides,
    });
    const events = [];
    recorder.on('event', (e) => events.push(e));
    const { port } = await recorder.start();

    function request(method, urlPath, body, { secret = SECRET, headers = {}, raw } = {}) {
        return new Promise((resolve, reject) => {
            const payload =
                raw !== undefined ? Buffer.from(raw) : body === undefined ? null : Buffer.from(JSON.stringify(body));
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    method,
                    path: urlPath,
                    headers: {
                        ...(secret === null ? {} : { 'X-Replay-Secret': secret }),
                        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
                        ...headers,
                    },
                },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json = null;
                        try {
                            json = JSON.parse(text);
                        } catch {
                            // not JSON
                        }
                        resolve({ status: res.statusCode, body: json, text });
                    });
                }
            );
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    const api = {
        get: (p, o) => request('GET', p, undefined, o),
        post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
        patch: (p, b, o) => request('PATCH', p, b, o),
        delete: (p, o) => request('DELETE', p, undefined, o),
        request,
    };

    function waitForEvent(predicate, ms = 60000) {
        return new Promise((resolve, reject) => {
            const found = events.find(predicate);
            if (found) return resolve(found);
            const timer = setTimeout(() => {
                recorder.off('event', onEvent);
                reject(new Error('timeout waiting for an event'));
            }, ms);
            const onEvent = (e) => {
                if (predicate(e)) {
                    clearTimeout(timer);
                    recorder.off('event', onEvent);
                    resolve(e);
                }
            };
            recorder.on('event', onEvent);
        });
    }

    return {
        recorder,
        port,
        dir,
        api,
        events,
        waitForEvent,
        clipDir: (id) => path.join(dir, 'clips', id),
        async stop({ keepDir = false } = {}) {
            await recorder.stop();
            if (!keepDir && !overrides.dataDir) media.rmDir(dir);
        },
    };
}

module.exports = { startRecorder, SECRET };
