'use strict';

// LivePix panel next to the join dialog: LivePix link, what is left of this month's goal (adjusted by
// last month's balance) and this month's supporters. Updates arrive in real time over Server-Sent
// Events; each new donation plays a celebration.
window.LivePixPanel = (() => {
    const FALLBACK_POLL_MS = 60000;
    const FEED_MAX = 6;
    const COMPACT_WIDTH = 820;
    const CELEBRATION_MS = 5200;
    const MESSAGE_MAX_CHARS = 34;
    const SEEN_KEY = 'livepix.lastSeenDonation';

    const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const moneyShort = new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });
    const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' });
    const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let els = null;
    let popup = null;
    let active = false;
    let pollTimer = null;
    let placeTimer = null;
    let resizeObserver = null;
    let stream = null;
    let summary = null;
    let shown = null; // what is on screen: { month, goal, raised, donorIds }
    const queue = [];
    let celebrating = false;
    const seenMessages = new Set();
    let feedPrimed = false;

    const brl = (cents) => money.format((cents || 0) / 100);
    const brlShort = (cents) => moneyShort.format((cents || 0) / 100);
    const isCompact = () => window.innerWidth < COMPACT_WIDTH;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const monthLabel = (key, offset = 0) => {
        const [y, m] = key.split('-').map(Number);
        return monthName.format(new Date(Date.UTC(y, m - 1 + offset, 15)));
    };
    // The celebration only plays while someone is actually looking at the page.
    const isWatching = () => !document.hidden && document.hasFocus();
    const waitWatching = () =>
        new Promise((resolve) => {
            const check = () => {
                if (!isWatching() && active) return;
                window.removeEventListener('focus', check);
                document.removeEventListener('visibilitychange', check);
                resolve();
            };
            window.addEventListener('focus', check);
            document.addEventListener('visibilitychange', check);
        });
    const readSeen = () => {
        try {
            return localStorage.getItem(SEEN_KEY);
        } catch {
            return null;
        }
    };
    const writeSeen = (id) => {
        try {
            localStorage.setItem(SEEN_KEY, id);
        } catch {}
    };
    const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function build() {
        if (els) return;

        const panel = el('aside', 'livepix-panel');
        panel.id = 'livepixPanel';
        panel.setAttribute('aria-label', 'Apoie via LivePix');
        panel.setAttribute('translate', 'no');
        panel.innerHTML = `
            <button class="lp-close" type="button" aria-label="Fechar"><i class="fas fa-xmark"></i></button>
            <div class="lp-top">
                <div class="lp-tagline">Apoie e mantenha a live stream</div>
                <a class="lp-link" target="_blank" rel="noopener noreferrer">
                    <span class="lp-link-text"></span><i class="fas fa-arrow-up-right-from-square"></i>
                </a>
                <div class="lp-goal">
                    <div class="lp-goal-row">
                        <div class="lp-left">
                            <span class="lp-left-label">Arrecadado</span>
                            <strong class="lp-left-value"></strong>
                        </div>
                        <div class="lp-target">
                            <span class="lp-target-label">Meta</span>
                            <span class="lp-target-value">
                                <span class="lp-base"></span>
                                <span class="lp-adjust"></span>
                            </span>
                        </div>
                    </div>
                    <div class="lp-bar"><div class="lp-bar-fill"></div></div>
                    <div class="lp-goal-sub">
                        <span class="lp-raised"></span>
                        <span class="lp-percent"></span>
                    </div>
                </div>
                <div class="lp-alert" aria-live="assertive">
                    <div class="lp-alert-icon"><i class="fas fa-heart"></i></div>
                    <div class="lp-alert-kicker"></div>
                    <div class="lp-alert-name"></div>
                    <div class="lp-alert-amount"></div>
                    <div class="lp-alert-msg"></div>
                </div>
            </div>
            <div class="lp-donors-head"><span class="lp-donors-title">Apoiadores</span> <span class="lp-count"></span></div>
            <ul class="lp-donors"></ul>`;

        const chip = el('button', 'livepix-chip');
        chip.type = 'button';
        chip.innerHTML = '<i class="fas fa-heart"></i> <span></span>';

        const feed = el('div', 'livepix-feed');
        feed.setAttribute('aria-live', 'polite');
        feed.setAttribute('translate', 'no');

        document.body.append(panel, chip, feed);

        const q = (sel) => panel.querySelector(sel);
        els = {
            panel,
            chip,
            feed,
            link: q('.lp-link'),
            linkText: q('.lp-link-text'),
            leftLabel: q('.lp-left-label'),
            leftValue: q('.lp-left-value'),
            base: q('.lp-base'),
            adjust: q('.lp-adjust'),
            target: q('.lp-target'),
            bar: q('.lp-bar'),
            fill: q('.lp-bar-fill'),
            raised: q('.lp-raised'),
            percent: q('.lp-percent'),
            alert: q('.lp-alert'),
            donorsTitle: q('.lp-donors-title'),
            count: q('.lp-count'),
            donors: q('.lp-donors'),
        };

        chip.addEventListener('click', () => document.body.classList.add('livepix-sheet-open'));
        q('.lp-close').addEventListener('click', () => document.body.classList.remove('livepix-sheet-open'));
        window.addEventListener('resize', place);
    }

    function setLink(url) {
        if (!url || els.link.href === url) return;
        els.link.href = url;
        els.linkText.textContent = url.replace(/^https?:\/\//, '');
    }

    // ---------------------------------------------------------------- static render

    function setAdjust(s) {
        // adjust < 0: last months left a surplus (goal goes down, green); > 0: a shortfall (goal goes up).
        const a = s.adjust || 0;
        els.base.textContent = brlShort(s.baseGoal);
        els.adjust.textContent = a ? `(${a < 0 ? '−' : '+'} ${brlShort(Math.abs(a))})` : '';
        els.adjust.className = `lp-adjust ${a < 0 ? 'lp-good' : a > 0 ? 'lp-bad' : ''}`;
        const prev = monthLabel(s.month, -1);
        els.target.title = a
            ? `${a < 0 ? 'Sobraram' : 'Faltaram'} ${brl(Math.abs(a))} em ${prev}: a meta de ${monthLabel(s.month)} é ${brl(s.goal)}`
            : `Meta de ${monthLabel(s.month)}: ${brl(s.goal)}`;
    }

    function setProgress(raised, goal, month) {
        const left = Math.max(0, goal - raised);
        const reached = raised >= goal;
        const pct = goal > 0 ? Math.min(100, (raised / goal) * 100) : 100;
        els.leftLabel.textContent = reached ? 'Meta batida! 🎉' : 'Arrecadado';
        els.leftValue.textContent = brl(raised);
        els.fill.style.width = `${pct}%`;
        els.percent.textContent = `${Math.floor(pct)}%`;
        const extra = raised - goal;
        els.raised.textContent = !reached
            ? `Restam ${brl(left)}`
            : extra > 0
              ? `+${brlShort(extra)} para ${monthLabel(month, 1)}`
              : 'Meta completa';
        els.panel.classList.toggle('lp-reached', reached);
        els.chip.querySelector('span').textContent = reached ? 'Meta do mês batida!' : `Restam ${brl(left)}`;
    }

    function donorRow(d) {
        const li = el('li');
        li.dataset.id = d.id;
        const top = el('div', 'lp-donor-top');
        top.append(
            el('span', 'lp-donor-name', d.name),
            el('span', 'lp-donor-date', dayFmt.format(new Date(d.at))),
            el('span', 'lp-donor-amount', brlShort(d.amount))
        );
        const msg = (d.message || '').trim();
        const message = el('div', `lp-donor-msg${msg ? '' : ' lp-donor-msg-empty'}`, msg ? clip(msg, MESSAGE_MAX_CHARS) : '—');
        if (msg.length > MESSAGE_MAX_CHARS) message.title = msg;
        li.append(top, message);
        return li;
    }

    function renderDonors(donors) {
        els.count.textContent = donors.length ? `(${donors.length})` : '';
        els.donors.replaceChildren();
        if (!donors.length) {
            els.donors.append(el('li', 'lp-empty', 'Ninguém apoiou ainda este mês. Seja o primeiro!'));
            return;
        }
        els.donors.append(...donors.map(donorRow));
    }

    function renderStatic(s) {
        setLink(s.url);
        els.donorsTitle.textContent = `Apoiadores de ${monthLabel(s.month)}`;
        setAdjust(s);
        setProgress(s.raised, s.goal, s.month);
        renderDonors(s.donors || []);
        shown = {
            month: s.month,
            goal: s.goal,
            raised: s.raised,
            donorIds: new Set((s.donors || []).map((d) => d.id)),
        };
    }

    // ---------------------------------------------------------------- message feed

    function addFeedItem(m, delay = 0) {
        const item = el('div', 'lp-msg');
        const head = el('div', 'lp-msg-head');
        head.append(el('strong', '', m.name), el('span', '', brl(m.amount)));
        item.append(head, el('div', 'lp-msg-text', m.message));
        item.style.animationDelay = `${delay}ms`;
        els.feed.prepend(item); // newest on top; older ones slide down and fade
        while (els.feed.children.length > FEED_MAX) els.feed.lastElementChild.remove();
    }

    function renderFeed(messages) {
        const fresh = messages.filter((m) => !seenMessages.has(m.id));
        fresh.forEach((m) => seenMessages.add(m.id));
        const toShow = feedPrimed ? fresh : fresh.slice(-FEED_MAX);
        toShow.forEach((m, i) => addFeedItem(m, feedPrimed ? i * 400 : i * 180));
        feedPrimed = true;
    }

    // ---------------------------------------------------------------- celebration

    function countUp(from, to, duration) {
        if (reducedMotion) return;
        // rAF pauses in background tabs; make sure the final value always lands.
        setTimeout(() => (els.leftValue.textContent = brl(to)), duration + 50);
        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            els.leftValue.textContent = brl(Math.round(from + (to - from) * eased));
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    function confetti(originEl, amount = 70, spread = 1) {
        if (reducedMotion || !originEl) return;
        const rect = originEl.getBoundingClientRect();
        if (!rect.width) return;
        const canvas = el('canvas', 'livepix-confetti');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = innerWidth * dpr;
        canvas.height = innerHeight * dpr;
        document.body.append(canvas);
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        const colors = ['#ea929e', '#c2394f', '#ffffff', '#f5c84c', '#ff5d73', '#6fdc9c'];
        const x0 = rect.left + rect.width / 2;
        const y0 = rect.top + rect.height / 2;
        const parts = Array.from({ length: amount }, () => {
            const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1 * spread;
            const speed = 4 + Math.random() * 7;
            return {
                x: x0 + (Math.random() - 0.5) * rect.width * 0.6,
                y: y0,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                w: 4 + Math.random() * 5,
                h: 6 + Math.random() * 8,
                r: Math.random() * Math.PI,
                vr: (Math.random() - 0.5) * 0.3,
                c: colors[Math.floor(Math.random() * colors.length)],
            };
        });
        const start = performance.now();
        const frame = (now) => {
            const t = (now - start) / 2200;
            ctx.clearRect(0, 0, innerWidth, innerHeight);
            for (const p of parts) {
                p.vy += 0.22;
                p.vx *= 0.985;
                p.x += p.vx;
                p.y += p.vy;
                p.r += p.vr;
                ctx.save();
                ctx.globalAlpha = Math.max(0, 1 - t);
                ctx.translate(p.x, p.y);
                ctx.rotate(p.r);
                ctx.fillStyle = p.c;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
                ctx.restore();
            }
            if (t < 1) requestAnimationFrame(frame);
            else canvas.remove();
        };
        requestAnimationFrame(frame);
    }

    function restartAnimation(node, className) {
        node.classList.remove(className);
        void node.offsetWidth;
        node.classList.add(className);
    }

    async function celebrate(d) {
        const before = shown.raised;
        const after = before + d.amount;
        const crossed = before < shown.goal && after >= shown.goal;
        shown.raised = after;
        shown.donorIds.add(d.id);
        writeSeen(d.id);

        // 1. Alert card pops over the top of the panel, which glows.
        const a = els.alert;
        a.querySelector('.lp-alert-kicker').textContent = crossed ? 'Meta do mês batida!' : 'Novo apoio!';
        a.querySelector('.lp-alert-name').textContent = d.name;
        a.querySelector('.lp-alert-amount').textContent = `+${brl(d.amount)}`;
        a.querySelector('.lp-alert-msg').textContent = d.message ? `“${d.message}”` : '';
        restartAnimation(a, 'show');
        restartAnimation(els.panel, 'lp-celebrate');
        restartAnimation(els.chip, 'lp-chip-pop');
        confetti(a, 60, 1.2);

        // 2. After the card, the bar climbs and "Arrecadado" counts up; confetti bursts from the bar.
        await wait(3000);
        a.classList.remove('show');
        await wait(300);
        els.bar.classList.add('lp-bar-rising');
        setProgress(after, shown.goal, shown.month);
        els.leftValue.textContent = brl(before);
        countUp(before, after, 1500);
        restartAnimation(els.leftValue, 'lp-pop');
        await wait(1200);
        confetti(els.bar, crossed ? 160 : 50, crossed ? 1.6 : 0.8);
        if (crossed) restartAnimation(els.panel, 'lp-goal-hit');

        // 3. The supporter slides in at the top of the list.
        await wait(200);
        els.donors.querySelector('.lp-empty')?.remove();
        const li = donorRow(d);
        li.classList.add('lp-new');
        els.donors.prepend(li);
        els.donors.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
        els.count.textContent = `(${els.donors.children.length})`;

        await wait(CELEBRATION_MS - 4700);
        els.bar.classList.remove('lp-bar-rising');
        await wait(400);
    }

    // Adds a donation without the show (it arrived while nobody was looking and a newer one exists).
    function addSilently(d) {
        shown.raised += d.amount;
        shown.donorIds.add(d.id);
        setProgress(shown.raised, shown.goal, shown.month);
        els.donors.querySelector('.lp-empty')?.remove();
        els.donors.prepend(donorRow(d));
        els.count.textContent = `(${els.donors.children.length})`;
    }

    async function drainQueue() {
        if (celebrating) return;
        celebrating = true;
        while (queue.length && active) {
            if (!isWatching()) {
                await waitWatching();
                if (!active) break;
                // Only the latest donation that arrived while away gets the celebration.
                while (queue.length > 1) addSilently(queue.shift());
            }
            await celebrate(queue.shift());
        }
        celebrating = false;
        if (summary && active) renderStatic(summary); // reconcile with the server's numbers
    }

    // ---------------------------------------------------------------- data flow

    function apply(s) {
        if (!s || !s.enabled) {
            if (s && !s.enabled) deactivate();
            return;
        }
        summary = s;
        renderFeed(s.messages || []);

        const firstRender = !shown;
        if (firstRender) {
            // Everyone sees the latest donation arrive once, even if it landed before they opened the page.
            const latest = (s.donors || [])[0];
            if (latest && latest.id !== readSeen()) {
                renderStatic({ ...s, raised: s.raised - latest.amount, donors: s.donors.slice(1) });
                queue.push(latest);
                drainQueue();
            } else {
                renderStatic(s);
            }
        } else if (shown.month !== s.month || shown.goal !== s.goal) {
            if (!celebrating) renderStatic(s);
        } else {
            const known = new Set([...shown.donorIds, ...queue.map((d) => d.id)]);
            const fresh = (s.donors || []).filter((d) => !known.has(d.id)).reverse(); // oldest first
            if (fresh.length) {
                queue.push(...fresh);
                drainQueue();
            } else if (!celebrating) {
                renderStatic(s);
            }
        }

        if (firstRender) {
            document.body.classList.add('livepix-ready');
            place();
        }
    }

    async function poll() {
        try {
            const res = await fetch('/livepix/summary', { cache: 'no-store' });
            apply(await res.json());
        } catch (err) {
            console.warn('LivePix summary unavailable', err);
        }
    }

    function connect() {
        if (stream || typeof EventSource === 'undefined') return;
        stream = new EventSource('/livepix/stream');
        stream.onmessage = (e) => {
            try {
                apply(JSON.parse(e.data));
            } catch (err) {
                console.warn('LivePix stream parse error', err);
            }
        };
    }

    // ---------------------------------------------------------------- layout

    function place() {
        if (!active || !els || !popup) return;
        const compact = isCompact();
        document.body.classList.toggle('livepix-compact', compact);
        if (compact) {
            els.panel.style.left = els.panel.style.top = els.panel.style.height = '';
            return;
        }
        // Same top and height as the join dialog; the supporters list takes the remaining space.
        const r = popup.getBoundingClientRect();
        const gap = parseFloat(getComputedStyle(document.body).getPropertyValue('--lp-gap')) || 14;
        els.panel.style.left = `${Math.round(r.right + gap)}px`;
        els.panel.style.top = `${Math.round(r.top)}px`;
        els.panel.style.height = `${Math.round(r.height)}px`;

        // Hide the message feed when the screen is too narrow for it to sit beside the panel.
        const feedLeft = window.innerWidth - 20 - Math.min(300, window.innerWidth - 40);
        document.body.classList.toggle('livepix-feed-hidden', feedLeft < r.right + gap + els.panel.offsetWidth + 16);
    }

    function show(popupEl) {
        build();
        popup = popupEl;
        active = true;
        document.body.classList.add('livepix-active');
        poll();
        connect();
        clearInterval(pollTimer);
        pollTimer = setInterval(poll, FALLBACK_POLL_MS);
        // The dialog animates in; keep re-anchoring until it settles.
        let ticks = 0;
        clearInterval(placeTimer);
        placeTimer = setInterval(() => {
            place();
            if (++ticks > 15) clearInterval(placeTimer);
        }, 100);
        popup.addEventListener('animationend', place);
        // Validation messages change the dialog height; keep the panel matching it.
        resizeObserver?.disconnect();
        resizeObserver = new ResizeObserver(place);
        resizeObserver.observe(popup);
    }

    function deactivate() {
        active = false;
        clearInterval(pollTimer);
        clearInterval(placeTimer);
        resizeObserver?.disconnect();
        stream?.close();
        stream = null;
        queue.length = 0;
        document.body.classList.remove(
            'livepix-active',
            'livepix-ready',
            'livepix-compact',
            'livepix-sheet-open',
            'livepix-feed-hidden'
        );
    }

    // Local preview of the donation animation (only this browser): LivePixPanel.simulate('Nome', 1000, 'msg')
    function simulate(name = 'Teste', cents = 1000, message = '') {
        if (!summary) return;
        const donor = { id: `sim-${Date.now()}`, name, amount: cents, message, at: new Date().toISOString() };
        const raised = summary.raised + cents;
        apply({
            ...summary,
            raised,
            remaining: Math.max(0, summary.goal - raised),
            surplus: Math.max(0, raised - summary.goal),
            donors: [donor, ...summary.donors],
            messages: message ? [...summary.messages, donor] : summary.messages,
        });
    }

    return { show, hide: deactivate, simulate, apply, getSummary: () => summary };
})();
