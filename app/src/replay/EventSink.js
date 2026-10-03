'use strict';

const http = require('node:http');
const https = require('node:https');

/**
 * Delivers the recorder's events to the SFU (REPLAY_SFU_EVENTS_URL) with a POST and the secret header.
 *
 * It never blocks and never throws: send() puts the event in a short queue and returns. The queue is delivered one
 * event at a time, in order. Events that matter (a clip was created or deleted, an MP4 is ready or failed) are tried
 * again a few times; the periodic ones (buffers, progress) are sent once, and a newer one replaces an older one that
 * is still waiting. When the SFU is away the queue keeps its newest events and drops the oldest.
 */

const BEST_EFFORT = new Set(['buffers', 'mp4.progress']);

class EventSink {
    /**
     * @param {object} options
     * @param {string} [options.url] events endpoint; without it nothing is sent
     * @param {string} [options.secret]
     * @param {object} options.log
     * @param {number} [options.maxQueue]
     * @param {number} [options.retries] extra attempts for the events that matter
     * @param {number[]} [options.retryDelaysMs]
     * @param {number} [options.timeoutMs]
     */
    constructor(options) {
        this.url = options.url ? new URL(options.url) : null;
        this.secret = options.secret || '';
        this.log = options.log;
        this.maxQueue = options.maxQueue ?? 200;
        this.retries = options.retries ?? 3;
        this.retryDelaysMs = options.retryDelaysMs || [250, 1000, 3000];
        this.timeoutMs = options.timeoutMs ?? 3000;
        this.queue = [];
        this.sending = false;
        this.closed = false;
        this.timer = null;
        this.lastWarnAt = 0;
        this.stats = { sent: 0, failed: 0, dropped: 0 };
        const lib = this.url && this.url.protocol === 'https:' ? https : http;
        this.lib = lib;
        // idle connections are closed by us (4 s) before a server with the usual 5 s keep-alive closes them under our feet
        this.agent = this.url ? new lib.Agent({ keepAlive: true, maxSockets: 1, timeout: 4000 }) : null;
    }

    get enabled() {
        return this.url !== null;
    }

    send(event) {
        if (!this.url || this.closed) return;
        const critical = !BEST_EFFORT.has(event.type);
        if (!critical) {
            const same = this.queue.findIndex(
                (item) => !item.inFlight && item.event.type === event.type && item.event.id === event.id
            );
            if (same >= 0) {
                this.queue[same].event = event;
                return;
            }
        }
        this.queue.push({ event, critical, attempts: 0, inFlight: false });
        while (this.queue.length > this.maxQueue) {
            const index = this.queue.findIndex((item) => !item.critical && !item.inFlight);
            this.queue.splice(index >= 0 ? index : this.queue[0].inFlight ? 1 : 0, 1);
            this.stats.dropped++;
        }
        this._pump();
    }

    _pump() {
        if (this.sending || this.closed) return;
        const item = this.queue[0];
        if (!item) return;
        this.sending = true;
        item.inFlight = true;
        this._post(item.event).then((ok) => {
            item.inFlight = false;
            if (ok) {
                this.stats.sent++;
                this.queue.shift();
                this.sending = false;
                this._pump();
                return;
            }
            this.stats.failed++;
            item.attempts++;
            if (item.critical && item.attempts <= this.retries && !this.closed) {
                const delay = this.retryDelaysMs[Math.min(item.attempts - 1, this.retryDelaysMs.length - 1)];
                this.timer = setTimeout(() => {
                    this.timer = null;
                    this.sending = false;
                    this._pump();
                }, delay);
                this.timer.unref();
                return;
            }
            this._warn(`could not deliver "${item.event.type}" to the SFU`);
            this.queue.shift();
            this.stats.dropped++;
            this.sending = false;
            this._pump();
        });
    }

    _warn(message) {
        const now = Date.now();
        if (now - this.lastWarnAt < 10000) return;
        this.lastWarnAt = now;
        this.log.warn(`replay: ${message}`);
    }

    _post(event) {
        return new Promise((resolve) => {
            let body;
            try {
                body = Buffer.from(JSON.stringify(event));
            } catch {
                resolve(true); // cannot ever be sent: do not retry it
                return;
            }
            const req = this.lib.request(
                {
                    protocol: this.url.protocol,
                    hostname: this.url.hostname,
                    port: this.url.port,
                    path: this.url.pathname + this.url.search,
                    method: 'POST',
                    agent: this.agent,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': body.length,
                        'X-Replay-Secret': this.secret,
                    },
                },
                (res) => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
                    res.on('error', () => resolve(false));
                }
            );
            req.on('error', () => resolve(false));
            req.setTimeout(this.timeoutMs, () => req.destroy());
            req.end(body);
        });
    }

    /** Stops accepting events and waits (a little) for the ones still queued. */
    async close(waitMs = 1500) {
        const deadline = Date.now() + waitMs;
        while (this.url && this.queue.length > 0 && !this.closed && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.queue = [];
        if (this.agent) this.agent.destroy();
    }
}

module.exports = { EventSink, BEST_EFFORT };
