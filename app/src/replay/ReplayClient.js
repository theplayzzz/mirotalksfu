'use strict';

/*
 * The SFU's side of the recorder control API (docs/REPLAY.md, section 3): plain HTTP + JSON on the private network,
 * authenticated with the shared secret. Every call has a timeout, so a stuck recorder never holds the room.
 */

class ReplayError extends Error {
    constructor(message, { status = 0, code = 'RECORDER_ERROR' } = {}) {
        super(message);
        this.name = 'ReplayError';
        this.status = status;
        this.code = code;
    }
}

class ReplayClient {
    /**
     * @param {object} o
     * @param {string} o.baseUrl for example http://mirotalk-replay:7000
     * @param {string} o.secret value of X-Replay-Secret
     * @param {number} [o.timeoutMs]
     * @param {function} [o.fetchImpl] fetch, replaceable in tests
     */
    constructor({ baseUrl, secret, timeoutMs = 8000, fetchImpl = globalThis.fetch }) {
        if (!baseUrl) throw new Error('ReplayClient needs the URL of the recorder');
        if (!secret) throw new Error('ReplayClient needs the internal secret');
        this.baseUrl = String(baseUrl).replace(/\/+$/, '');
        this.secret = secret;
        this.timeoutMs = timeoutMs;
        this.fetch = fetchImpl;
    }

    get host() {
        return new URL(this.baseUrl).hostname;
    }

    async request(method, path, body, { timeoutMs = this.timeoutMs } = {}) {
        let response;
        try {
            response = await this.fetch(this.baseUrl + path, {
                method,
                headers: {
                    'X-Replay-Secret': this.secret,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new ReplayError(`The recorder did not answer ${method} ${path}: ${error.message}`, { code: 'RECORDER_UNREACHABLE' });
        }

        let json = null;
        try {
            json = await response.json();
        } catch (error) {
            // not JSON
        }
        if (!response.ok) {
            throw new ReplayError((json && json.error) || `The recorder answered ${response.status} to ${method} ${path}`, {
                status: response.status,
                code: (json && json.code) || 'RECORDER_ERROR',
            });
        }
        return json || {};
    }

    health() {
        return this.request('GET', '/v1/health', undefined, { timeoutMs: 3000 });
    }

    registerShare(share) {
        return this.request('POST', '/v1/shares', share);
    }

    patchShare(shareId, patch) {
        return this.request('PATCH', `/v1/shares/${encodeURIComponent(shareId)}`, patch);
    }

    deleteShare(shareId) {
        return this.request('DELETE', `/v1/shares/${encodeURIComponent(shareId)}`);
    }

    listShares() {
        return this.request('GET', '/v1/shares');
    }

    // Building a clip is quick (a copy, under 3 s), but the disk may be busy: a longer timeout than the others
    createClip(request) {
        return this.request('POST', '/v1/clips', request, { timeoutMs: 20000 });
    }

    listClips() {
        return this.request('GET', '/v1/clips');
    }

    getClip(id) {
        return this.request('GET', `/v1/clips/${encodeURIComponent(id)}`);
    }

    deleteClip(id) {
        return this.request('DELETE', `/v1/clips/${encodeURIComponent(id)}`);
    }

    startMp4(id) {
        return this.request('POST', `/v1/clips/${encodeURIComponent(id)}/mp4`);
    }
}

module.exports = { ReplayClient, ReplayError };
