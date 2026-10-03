'use strict';

// LivePix integration: polls received donations (messages) and builds the monthly goal summary
// shown on the join screen. Excess over the monthly goal rolls over to the next month.

const Logger = require('./Logger');
const log = new Logger('LivePix');

const API_URL = 'https://api.livepix.gg/v2';
const TOKEN_URL = 'https://oauth.livepix.gg/oauth2/token';
const SCOPES = 'account:read messages:read';
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;
const FEED_SIZE = 30;

function monthKey(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}`;
}

function nextMonth(key) {
    let [y, m] = key.split('-').map(Number);
    m += 1;
    if (m > 12) {
        m = 1;
        y += 1;
    }
    return `${y}-${String(m).padStart(2, '0')}`;
}

function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

module.exports = class LivePix {
    constructor(env = process.env) {
        this.clientId = (env.LIVEPIX_CLIENT_ID || '').trim();
        this.clientSecret = (env.LIVEPIX_CLIENT_SECRET || '').trim();
        this.enabled = env.LIVEPIX_ENABLED !== 'false' && Boolean(this.clientId && this.clientSecret);
        this.goal = toInt(env.LIVEPIX_GOAL_CENTS, 8500);
        this.timeZone = env.LIVEPIX_TIMEZONE || 'America/Sao_Paulo';
        this.startMonth = /^\d{4}-\d{2}$/.test(env.LIVEPIX_START_MONTH || '')
            ? env.LIVEPIX_START_MONTH
            : monthKey(new Date(), this.timeZone);
        this.username = (env.LIVEPIX_USERNAME || '').trim();
        this.pollMs = Math.max(15, toInt(env.LIVEPIX_POLL_SECONDS, 30)) * 1000;
        // Donations left out of the goal and lists (e.g. test payments), comma-separated message ids
        this.excludeIds = new Set((env.LIVEPIX_EXCLUDE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));

        this.token = null;
        this.tokenExpiresAt = 0;
        this.useBasicAuth = false;
        this.donations = [];
        this.signature = '';
        this.clients = new Set();
        this.lastSyncAt = null;
        this.lastError = null;
        this.refreshing = null;
        this.webhookTimer = null;
    }

    start() {
        if (!this.enabled) {
            log.info('LivePix disabled (missing LIVEPIX_CLIENT_ID / LIVEPIX_CLIENT_SECRET)');
            return;
        }
        log.info('LivePix enabled', { goal: this.goal, startMonth: this.startMonth, pollMs: this.pollMs });
        this.refresh();
        this.timer = setInterval(() => this.refresh(), this.pollMs);
        this.timer.unref?.();
        // Comment lines keep idle SSE connections open through proxies.
        this.heartbeat = setInterval(() => this.send(': ping\n\n'), 25000);
        this.heartbeat.unref?.();
    }

    // Server-Sent Events: every open join screen gets the new summary as soon as a donation lands.
    subscribe(req, res) {
        if (this.clients.size >= 500) return res.status(503).end();
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        res.write('retry: 5000\n\n');
        this.write(res, `data: ${JSON.stringify(this.getSummary())}\n\n`);
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
    }

    write(res, chunk) {
        res.write(chunk);
        res.flush?.(); // compression middleware buffers otherwise
    }

    send(chunk) {
        for (const res of this.clients) this.write(res, chunk);
    }

    broadcast() {
        if (this.clients.size) this.send(`data: ${JSON.stringify(this.getSummary())}\n\n`);
    }

    async requestToken() {
        const body = new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPES });
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
        if (this.useBasicAuth) {
            headers.Authorization =
                'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        } else {
            body.set('client_id', this.clientId);
            body.set('client_secret', this.clientSecret);
        }
        return fetch(TOKEN_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    }

    async getToken() {
        if (this.token && Date.now() < this.tokenExpiresAt - 60000) return this.token;

        let res = await this.requestToken();
        if (res.status === 401) {
            // The app may be registered for the other client auth method (post vs basic)
            this.useBasicAuth = !this.useBasicAuth;
            res = await this.requestToken();
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
            throw new Error(`token ${res.status}: ${data.error_description || data.error || 'unknown error'}`);
        }
        this.token = data.access_token;
        this.tokenExpiresAt = Date.now() + toInt(data.expires_in, 3600) * 1000;
        return this.token;
    }

    async api(path, retry = true) {
        const token = await this.getToken();
        const res = await fetch(API_URL + path, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401 && retry) {
            this.token = null;
            return this.api(path, false);
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${data.message || data.error || 'unknown error'}`);
        return data.data;
    }

    monthStartTime(key) {
        // Earliest instant whose month (in timeZone) is >= key; a 1-day margin is enough for any UTC offset.
        const [y, m] = key.split('-').map(Number);
        return Date.UTC(y, m - 1, 1) - 24 * 3600 * 1000;
    }

    async fetchDonations() {
        const since = this.monthStartTime(this.startMonth);
        const items = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const data = await this.api(`/messages?currency=BRL&limit=${PAGE_LIMIT}&page=${page}`);
            const list = Array.isArray(data) ? data : [];
            items.push(...list);
            const allOlder = list.length > 0 && list.every((d) => new Date(d.createdAt).getTime() < since);
            if (list.length < PAGE_LIMIT || allOlder) break;
        }

        const seen = new Set();
        return items
            .filter((d) => d && d.id && !seen.has(d.id) && seen.add(d.id))
            .map((d) => ({
                id: String(d.id),
                name: String(d.username || 'Anônimo').slice(0, 40),
                message: d.flagged ? '' : String(d.message || '').slice(0, 200),
                amount: Math.max(0, toInt(d.amount, 0)),
                at: new Date(d.createdAt).toISOString(),
                month: monthKey(new Date(d.createdAt), this.timeZone),
            }))
            .filter((d) => d.amount > 0 && d.month >= this.startMonth && !this.excludeIds.has(d.id))
            .sort((a, b) => a.at.localeCompare(b.at));
    }

    refresh() {
        if (!this.enabled) return Promise.resolve();
        if (this.refreshing) return this.refreshing;
        this.refreshing = (async () => {
            try {
                if (!this.username) {
                    const account = await this.api('/account');
                    this.username = account?.username || '';
                }
                this.donations = await this.fetchDonations();
                this.lastSyncAt = new Date().toISOString();
                const signature = this.donations.map((d) => d.id).join(',');
                if (signature !== this.signature) {
                    if (this.signature) log.info('LivePix new donation data', { count: this.donations.length });
                    this.signature = signature;
                    this.broadcast();
                }
                if (this.lastError) log.info('LivePix sync recovered');
                this.lastError = null;
            } catch (err) {
                if (this.lastError !== err.message) log.warn('LivePix sync failed', err.message);
                this.lastError = err.message;
            } finally {
                this.refreshing = null;
            }
        })();
        return this.refreshing;
    }

    handleWebhook(body) {
        if (!this.enabled) return;
        if (body?.clientId && body.clientId !== this.clientId) return;
        // The payload only carries ids, so treat it as a trigger to re-sync right away
        // (and once more shortly after, in case the message list lags behind the event).
        log.info('LivePix webhook', { event: body?.event, type: body?.resource?.type });
        clearTimeout(this.webhookTimer);
        clearTimeout(this.webhookRetryTimer);
        this.webhookTimer = setTimeout(() => this.refresh(), 1000);
        this.webhookRetryTimer = setTimeout(() => this.refresh(), 8000);
    }

    getSummary(now = new Date()) {
        if (!this.enabled) return { enabled: false };

        const current = monthKey(now, this.timeZone);
        const byMonth = new Map();
        for (const d of this.donations) byMonth.set(d.month, (byMonth.get(d.month) || 0) + d.amount);

        // Running balance of past months: a shortfall raises this month's goal (adjust > 0),
        // a surplus lowers it (adjust < 0).
        let adjust = 0;
        for (let m = this.startMonth; m < current; m = nextMonth(m)) {
            adjust += this.goal - (byMonth.get(m) || 0);
        }

        const goal = Math.max(0, this.goal + adjust);
        const raised = byMonth.get(current) || 0;

        return {
            enabled: true,
            url: this.username ? `https://livepix.gg/${this.username}` : null,
            username: this.username || null,
            baseGoal: this.goal,
            adjust,
            goal,
            month: current,
            raised,
            remaining: Math.max(0, goal - raised),
            surplus: Math.max(0, raised - goal),
            donors: this.donations
                .filter((d) => d.month === current)
                .reverse()
                .map(({ id, name, amount, message, at }) => ({ id, name, amount, message, at })),
            messages: this.donations
                .filter((d) => d.message)
                .slice(-FEED_SIZE)
                .map(({ id, name, message, amount, at }) => ({ id, name, message, amount, at })),
            updatedAt: this.lastSyncAt,
            stale: Boolean(this.lastError),
        };
    }
};
