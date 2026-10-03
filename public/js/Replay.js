'use strict';

// Replay in the room (docs/REPLAY.md, section 7): the button on the hover bar of a shared screen, the "● Replay"
// badge, the popover with the lengths, the toasts, the gallery button with its counter and the exchange of the
// ticket that opens the gallery without a password. It stays off unless /config says replay.enabled.
//
// The room only hands over its screen tiles (RoomClient.handleConsumer / handleProducer call attachScreen); all the
// logic lives here. Same shape as LivePix.js: an IIFE on window, no libraries, text in Portuguese. Never SweetAlert2.
window.Replay = (() => {
    const L = window.ReplayLogic;
    if (!L) {
        console.error('ReplayLogic.js did not load');
        return null;
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const MAX_TOASTS = 4;
    const GALLERY_BUTTON_ID = 'replayGalleryButton';
    const GALLERY_BADGE_ID = 'replayGalleryBadge';

    // Tests shorten these.
    const timings = {
        savedMs: 8000, // "Replay salvo na galeria"
        errorMs: 10000,
        otherMs: 6500, // what other people save
        ackMs: 8000, // the server must answer the request this fast
        requestMs: 60000, // and the clip must be ready this fast after it
        tickMs: 1000, // the popover counts the buffer up while it is open
        leaveMs: 200,
    };

    const state = {
        enabled: false,
        maxSeconds: 300,
        options: [60, 120, 180, 300],
        available: true, // false while the server pauses the recording under load
        reason: '',
        shares: new Map(), // producerId -> { producerId, peerName, bufferSeconds, codec, hasAudio, at }
        tiles: new Map(), // producerId -> { producerId, tile, bar, pin, peerName, own, button, badge }
        popover: null,
        jobs: [],
        early: new Map(), // replayStatus that arrived before the ack of its request
        toasts: [],
        unseen: new Set(), // clips created since the gallery was last opened
        created: new Set(), // replayCreated already handled (a reconnect can repeat them)
        tickets: new Set(), // tickets already exchanged: each goes once
        session: '', // '', 'ok' or 'failed': the last exchange of a ticket
        link: null, // the socket
        seq: 0,
    };

    const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    const ICONS = {
        check: 'm5 12.5 4.5 4.5L19 7.5',
        alert: 'M12 6.5v7M12 17.5v.1',
        close: 'm6 6 12 12M18 6 6 18',
    };

    function icon(name) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ICONS[name]);
        svg.append(path);
        return svg;
    }

    const strong = (text) => el('strong', '', text);

    // What the room knows about me (rc is the room client, a global of Room.js).
    function me() {
        let client = null;
        try {
            client = typeof rc !== 'undefined' ? rc : null;
        } catch {
            client = null;
        }
        return { name: (client && client.peer_name) || '', mobile: !!(client && client.isMobileDevice) };
    }

    function tip(button, text, placement = 'bottom') {
        if (me().mobile) return;
        try {
            if (typeof tippy === 'function') {
                if (button._tippy) button._tippy.destroy();
                tippy(button, { content: text, placement });
                return;
            }
        } catch {
            // fall through to the native tooltip
        }
        button.title = text;
    }

    // ---- the socket ---------------------------------------------------------------------------------------------

    // Room.js creates a global `socket`; the events can arrive as soon as it joins, so listen right away.
    function findSocket() {
        try {
            if (typeof socket !== 'undefined' && socket && typeof socket.on === 'function') return socket;
        } catch {
            // not defined (yet)
        }
        return window.socket && typeof window.socket.on === 'function' ? window.socket : null;
    }

    function wireSocket(link = findSocket()) {
        if (!link) return false;
        if (state.link === link) return true;
        state.link = link;
        link.on('replayTicket', onTicket);
        link.on('replayBuffers', onBuffers);
        link.on('replayStatus', onStatus);
        link.on('replayCreated', onCreated);
        link.on('disconnect', () => {
            state.shares = new Map();
            renderAll();
        });
        return true;
    }

    function emit(event, data, ack, timeoutMs) {
        const link = state.link;
        if (!link || link.connected === false) {
            ack({ error: 'sem conexão', code: 'NO_CONNECTION' });
            return;
        }
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            ack({ error: 'o servidor não respondeu', code: 'TIMEOUT' });
        }, timeoutMs);
        const finish = (response) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            ack(response);
        };
        try {
            link.emit(event, data, finish);
        } catch (error) {
            finish({ error: String(error && error.message ? error.message : error), code: 'EMIT_FAILED' });
        }
    }

    // ---- the ticket that opens the gallery -----------------------------------------------------------------

    function onTicket(payload) {
        const ticket = payload && payload.ticket;
        if (typeof ticket !== 'string' || !ticket || state.tickets.has(ticket)) return;
        state.tickets.add(ticket); // each ticket goes once, whatever the answer
        fetch('/replay/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket }),
            credentials: 'same-origin',
        })
            .then((response) => {
                state.session = response.ok ? 'ok' : 'failed';
            })
            .catch(() => {
                state.session = 'failed'; // the gallery then asks for the room password
            });
    }

    // ---- what the server keeps -------------------------------------------------------------------------------

    function onBuffers(payload) {
        if (!payload || typeof payload !== 'object') return;
        state.available = payload.available !== false;
        state.reason = typeof payload.reason === 'string' ? payload.reason : '';
        if (isNumber(payload.maxSeconds) && payload.maxSeconds > 0) state.maxSeconds = payload.maxSeconds;
        const shares = new Map();
        for (const share of Array.isArray(payload.shares) ? payload.shares : []) {
            if (share && share.producerId) shares.set(String(share.producerId), { ...share, at: Date.now() });
        }
        state.shares = shares;
        renderAll();
    }

    // The seconds a screen has been kept: what the server last said plus the time since (it counts up between
    // the messages, which come every 5 s).
    function keptSeconds(share) {
        if (!share) return 0;
        const base = isNumber(share.bufferSeconds) ? share.bufferSeconds : 0;
        return state.available ? base + (Date.now() - share.at) / 1000 : base;
    }

    // ---- the screens of the room ---------------------------------------------------------------------------

    // Called by RoomClient for every screen tile it builds. Never throws: it must not get in the way of the room.
    function attachScreen({ tile, bar, pin, producerId, peerName, own } = {}) {
        try {
            if (!tile || !bar || !producerId) return;
            const key = String(producerId);
            const known = state.tiles.get(key);
            if (known && known.tile === tile) return;
            if (known) forget(known);
            const entry = {
                producerId: key,
                tile,
                bar,
                pin: pin || null,
                peerName: peerName || '',
                own: !!own,
                button: null,
                badge: null,
            };
            state.tiles.set(key, entry);
            render(entry);
        } catch (error) {
            console.warn('Replay.attachScreen', error);
        }
    }

    function forget(entry) {
        if (state.popover && state.popover.entry === entry) closePopover({ restoreFocus: false });
        entry.button?.remove();
        entry.badge?.remove();
        state.tiles.delete(entry.producerId);
    }

    function nameOf(entry, share) {
        return (share && share.peerName) || entry.peerName || 'alguém';
    }

    const labelOf = (entry, share) => `Salvar replay da tela de ${nameOf(entry, share)}`;

    function createButton(entry) {
        const button = el('button', 'replay-btn fas fa-clock-rotate-left');
        button.type = 'button';
        button.id = `${entry.producerId}__replay`;
        button.hidden = true;
        button.setAttribute('translate', 'no');
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            if (button.getAttribute('aria-disabled') === 'true') return;
            if (state.popover && state.popover.entry === entry) closePopover();
            else openPopover(entry);
        });
        // Next to the pin button (the pin is not in the bar on a phone: then it goes to the end).
        if (entry.pin && entry.pin.parentNode === entry.bar) entry.pin.before(button);
        else entry.bar.append(button);
        tip(button, 'Salvar replay');
        return button;
    }

    function createBadge(entry) {
        const badge = el('div', 'replay-badge', 'Replay');
        badge.hidden = true;
        badge.setAttribute('aria-hidden', 'true');
        badge.setAttribute('translate', 'no');
        entry.tile.append(badge);
        return badge;
    }

    // Shows or hides what belongs on one screen, from what the server says it keeps.
    function render(entry) {
        const share = state.enabled ? state.shares.get(entry.producerId) : null;
        if (!share) {
            if (entry.button) entry.button.hidden = true;
            if (entry.badge) entry.badge.hidden = true;
            if (state.popover && state.popover.entry === entry) closePopover({ restoreFocus: false });
            return;
        }
        if (!entry.button) entry.button = createButton(entry);
        if (!entry.badge) entry.badge = createBadge(entry);
        entry.button.hidden = false;
        const tooltip = state.available ? 'Salvar replay' : 'Replay indisponível agora';
        if (entry.button._tippy) entry.button._tippy.setContent(tooltip);
        else if (!me().mobile) entry.button.title = tooltip;
        entry.button.setAttribute('aria-disabled', String(!state.available));
        entry.button.setAttribute(
            'aria-label',
            state.available ? labelOf(entry, share) : `${labelOf(entry, share)} (indisponível agora)`
        );
        entry.badge.hidden = !state.available;
    }

    function renderAll() {
        for (const entry of [...state.tiles.values()]) {
            // The tile is gone (the screen stopped, or its consumer closed).
            if (!entry.tile.isConnected && !entry.bar.isConnected) {
                forget(entry);
                continue;
            }
            render(entry);
        }
        if (state.popover) renderPopover();
    }

    // ---- the popover -----------------------------------------------------------------------------------------

    function openPopover(entry) {
        closePopover({ restoreFocus: false });
        if (!state.enabled || !state.shares.has(entry.producerId)) return;

        const root = el('div', 'replay-popover');
        root.id = 'replayPopover';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-label', 'Salvar replay');
        root.setAttribute('translate', 'no');
        root.tabIndex = -1; // a click on its text keeps the focus inside
        const title = el('strong', 'replay-pop-title');
        const sub = el('span', 'replay-pop-sub');
        const list = el('div', 'replay-opts');
        const note = el('p', 'replay-pop-note');
        note.id = 'replayPopNote';
        note.hidden = true;
        root.append(title, sub, list, note);
        document.body.append(root);

        const pop = { entry, root, title, sub, list, note, options: new Map(), picked: false, timer: 0 };
        state.popover = pop;
        entry.button.setAttribute('aria-expanded', 'true');
        entry.button.setAttribute('aria-controls', root.id);
        entry.button.classList.add('is-open');
        entry.bar.classList.add('replay-keep');
        if (entry.button._tippy) entry.button._tippy.hide();

        renderPopover();
        place();
        pop.timer = setInterval(() => {
            renderPopover();
            place();
        }, timings.tickMs);
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('focusin', onFocusIn, true);
        document.addEventListener('keydown', onEscape, true);
        root.addEventListener('keydown', onPopoverKey);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);

        const first =
            [...pop.options.values()].find((b) => b.getAttribute('aria-disabled') !== 'true') ||
            [...pop.options.values()][0];
        if (first) first.focus({ preventScroll: true });
    }

    function renderPopover() {
        const pop = state.popover;
        if (!pop) return;
        const { entry } = pop;
        const share = state.shares.get(entry.producerId);
        if (!share || !entry.tile.isConnected) {
            closePopover({ restoreFocus: false });
            return;
        }
        const kept = keptSeconds(share);
        pop.title.textContent = labelOf(entry, share);
        if (state.available) {
            pop.sub.replaceChildren(
                'Disponível: últimos ',
                strong(L.formatClock(L.availableSeconds(kept, state.maxSeconds)))
            );
        } else {
            pop.sub.textContent = 'Indisponível no momento';
        }

        const options = L.optionsAvailability({
            options: state.options,
            maxSeconds: state.maxSeconds,
            bufferSeconds: state.available ? kept : 0,
        });
        let hint = '';
        for (const option of options) {
            let button = pop.options.get(option.seconds);
            if (!button) {
                button = el('button', 'replay-opt');
                button.type = 'button';
                button.dataset.seconds = String(option.seconds);
                button.addEventListener('click', () => pick(pop, option.seconds, button));
                pop.options.set(option.seconds, button);
                pop.list.append(button);
            }
            const enabled = option.enabled && state.available;
            button.setAttribute('aria-disabled', String(!enabled));
            button.textContent = option.label;
            // A disabled option says why: the hint under the list, also as its tooltip and its description.
            if (enabled) {
                button.removeAttribute('title');
                button.removeAttribute('aria-describedby');
            } else {
                button.title = capitalize(option.hint || 'indisponível agora');
                button.setAttribute('aria-describedby', pop.note.id);
            }
            if (!enabled && state.available && !hint) hint = option.hint;
        }
        if (!state.available) {
            pop.note.textContent = 'Replay indisponível agora. Tente de novo em instantes.';
        } else if (hint) {
            pop.note.replaceChildren(strong(capitalize(hint)), ' · as opções maiores ficam disponíveis com o tempo.');
        }
        pop.note.hidden = state.available && !hint;
    }

    function place() {
        const pop = state.popover;
        if (!pop) return;
        const { button } = pop.entry;
        if (!button.isConnected) {
            closePopover({ restoreFocus: false });
            return;
        }
        const rect = button.getBoundingClientRect();
        if (!rect.width && !rect.height) return; // its bar is hidden for a moment: stay where we are
        const { root } = pop;
        const width = root.offsetWidth;
        const height = root.offsetHeight;
        const margin = 8;
        const gap = 10;
        const left = clamp(
            rect.left + rect.width / 2 - width / 2,
            margin,
            Math.max(margin, window.innerWidth - width - margin)
        );
        let top = rect.bottom + gap;
        let above = false;
        if (top + height > window.innerHeight - margin) {
            const over = rect.top - gap - height;
            if (over >= margin) {
                top = over;
                above = true;
            } else {
                top = clamp(top, margin, Math.max(margin, window.innerHeight - height - margin));
            }
        }
        root.style.left = `${Math.round(left)}px`;
        root.style.top = `${Math.round(top)}px`;
        root.style.setProperty(
            '--replay-arrow',
            `${Math.round(clamp(rect.left + rect.width / 2 - left, 20, Math.max(20, width - 20)))}px`
        );
        root.classList.toggle('is-above', above);
    }

    function closePopover({ restoreFocus = true } = {}) {
        const pop = state.popover;
        if (!pop) return;
        state.popover = null;
        clearInterval(pop.timer);
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('focusin', onFocusIn, true);
        document.removeEventListener('keydown', onEscape, true);
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', place, true);
        const hadFocus = pop.root.contains(document.activeElement);
        pop.root.remove();
        const { entry } = pop;
        entry.button.setAttribute('aria-expanded', 'false');
        entry.button.removeAttribute('aria-controls');
        entry.button.classList.remove('is-open');
        entry.bar.classList.remove('replay-keep');
        if (
            restoreFocus &&
            (hadFocus || document.activeElement === document.body) &&
            entry.button.isConnected &&
            !entry.button.hidden
        ) {
            entry.button.focus({ preventScroll: true });
        }
    }

    function onOutside(event) {
        const pop = state.popover;
        if (!pop) return;
        const target = event.target;
        if (pop.root.contains(target) || pop.entry.button.contains(target)) return;
        closePopover({ restoreFocus: false });
    }

    function onEscape(event) {
        if (event.key !== 'Escape' || !state.popover) return;
        event.preventDefault();
        event.stopPropagation(); // the room must not also close something else
        closePopover();
    }

    // Tab (or anything else) put the focus somewhere else on the page: close it, and leave the focus where it went.
    function onFocusIn(event) {
        const pop = state.popover;
        if (!pop) return;
        const target = event.target;
        if (pop.root.contains(target) || pop.entry.button.contains(target)) return;
        closePopover({ restoreFocus: false });
    }

    function onPopoverKey(event) {
        const pop = state.popover;
        if (!pop) return;
        const buttons = [...pop.options.values()];
        const at = buttons.indexOf(document.activeElement);
        let next = -1;
        if (event.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % buttons.length;
        else if (event.key === 'ArrowUp') next = at <= 0 ? buttons.length - 1 : at - 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        if (next >= 0) {
            event.preventDefault();
            buttons[next].focus({ preventScroll: true });
        }
        // Space and Enter press the option; the room's push-to-talk must not see the Space.
        if (event.key === ' ' || event.key === 'Enter' || next >= 0) event.stopPropagation();
    }

    function pick(pop, seconds, button) {
        if (pop.picked || button.getAttribute('aria-disabled') === 'true') return;
        pop.picked = true; // one click, one request
        const { entry } = pop;
        closePopover();
        request(entry, seconds);
    }

    // ---- asking for a clip -------------------------------------------------------------------------------------

    function request(entry, seconds) {
        const share = state.shares.get(entry.producerId);
        const job = {
            seq: ++state.seq,
            producerId: entry.producerId,
            seconds,
            whose: `tela de ${nameOf(entry, share)}`,
            requestId: '',
            done: false,
            timer: 0,
            toast: null,
        };
        state.jobs.push(job);
        job.toast = showToast({
            kind: 'generating',
            title: 'Gerando replay…',
            detail: `${capitalize(job.whose)} · ${L.optionLabel(seconds)}`,
            ttl: 0,
        });
        armJob(job);
        emit(
            'replayRequest',
            { producerId: entry.producerId, seconds },
            (response) => onAck(job, response),
            timings.ackMs
        );
    }

    const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

    function armJob(job) {
        clearTimeout(job.timer);
        job.timer = setTimeout(() => fail(job), timings.requestMs);
    }

    function onAck(job, response) {
        if (job.done) return;
        if (!response || response.ok !== true) {
            fail(job, response);
            return;
        }
        job.requestId = String(response.requestId || '');
        const early = job.requestId && state.early.get(job.requestId);
        if (early) {
            state.early.delete(job.requestId);
            applyStatus(job, early);
        }
    }

    function onStatus(payload) {
        if (!payload || typeof payload !== 'object') return;
        const requestId = String(payload.requestId || '');
        let job = state.jobs.find((j) => !j.done && j.requestId && j.requestId === requestId);
        if (!job) {
            // The status can beat the answer to the request: it belongs to the one request still waiting for it.
            const waiting = state.jobs.filter((j) => !j.done && !j.requestId);
            if (waiting.length === 1 && requestId) {
                job = waiting[0];
                job.requestId = requestId;
            }
        }
        if (!job) {
            if (requestId) {
                state.early.set(requestId, payload);
                if (state.early.size > 20) state.early.delete(state.early.keys().next().value);
            }
            return;
        }
        applyStatus(job, payload);
    }

    function applyStatus(job, payload) {
        if (job.done) return;
        if (payload.state === 'done') succeed(job, payload.clip);
        else if (payload.state === 'error') fail(job, payload);
        else armJob(job); // "preparing": still on it
    }

    function finish(job) {
        job.done = true;
        clearTimeout(job.timer);
        state.jobs = state.jobs.filter((j) => j !== job);
    }

    function succeed(job, clip) {
        finish(job);
        const id = clip && L.isClipId(clip.id) ? clip.id : '';
        if (id) {
            state.created.add(id);
            state.unseen.add(id);
            updateBadge();
        }
        paintToast(job.toast, {
            kind: 'saved',
            title: 'Replay salvo na galeria',
            detail: `${capitalize(job.whose)} · ${L.optionLabel(job.seconds)}`,
            link: { href: L.galleryUrl({ clip: id, fromRoom: true }), text: 'Ver ▸', label: 'Ver o replay na galeria' },
            ttl: timings.savedMs,
        });
    }

    function fail(job) {
        if (job.done) return;
        finish(job);
        paintToast(job.toast, {
            kind: 'error',
            title: 'Não deu para gerar o replay — tente de novo',
            ttl: timings.errorMs,
        });
    }

    // What other people save in the room.
    function onCreated(payload) {
        const clip = payload && payload.clip;
        if (!clip || !L.isClipId(clip.id) || state.created.has(clip.id)) return;
        state.created.add(clip.id);
        state.unseen.add(clip.id);
        updateBadge();
        const who = String(payload.requestedBy || clip.requestedBy || '' || '').trim();
        if (who && who === me().name) return; // my own toast already says it
        showToast({
            kind: 'other',
            parts: [strong(who || 'Alguém'), ' salvou um replay da tela de ', strong(clip.sharer || 'alguém')],
            link: {
                href: L.galleryUrl({ clip: clip.id, fromRoom: true }),
                text: 'Ver',
                label: 'Ver o replay na galeria',
            },
            ttl: timings.otherMs,
        });
    }

    // ---- toasts ------------------------------------------------------------------------------------------------

    function toastRoot() {
        let root = document.getElementById('replayToasts');
        if (!root) {
            root = el('div', 'replay-toasts');
            root.id = 'replayToasts';
            root.setAttribute('role', 'status');
            root.setAttribute('aria-live', 'polite');
            root.setAttribute('translate', 'no');
            document.body.append(root);
        }
        return root;
    }

    function showToast(options) {
        const node = el('div', 'replay-toast');
        const toast = { node, timer: 0, remaining: 0, startedAt: 0, closed: false };
        node.addEventListener('mouseenter', () => pauseToast(toast));
        node.addEventListener('mouseleave', () => resumeToast(toast));
        node.addEventListener('focusin', () => pauseToast(toast));
        node.addEventListener('focusout', () => resumeToast(toast));
        paintToast(toast, options);
        toastRoot().append(node);
        state.toasts.push(toast);
        // Never a wall of toasts: the oldest finished ones go first.
        while (state.toasts.length > MAX_TOASTS) {
            const old =
                state.toasts.find((t) => !t.node.classList.contains('replay-toast--generating')) || state.toasts[0];
            closeToast(old, true);
        }
        return toast;
    }

    function paintToast(toast, { kind, title, detail, parts, link, ttl }) {
        const { node } = toast;
        node.className = `replay-toast replay-toast--${kind}`;
        const children = [];
        if (kind !== 'other') {
            const badge = el('span', 'replay-toast-icon');
            badge.setAttribute('aria-hidden', 'true');
            if (kind === 'saved') badge.append(icon('check'));
            if (kind === 'error') badge.append(icon('alert'));
            children.push(badge);
        }
        const body = el('div', 'replay-toast-body');
        if (parts) {
            body.append(...parts.map((part) => (typeof part === 'string' ? document.createTextNode(part) : part)));
        } else {
            body.append(el('span', 'replay-toast-title', title));
            if (detail) body.append(el('span', 'replay-toast-detail', detail));
            if (kind === 'generating') {
                const bar = el('span', 'replay-toast-bar');
                bar.setAttribute('aria-hidden', 'true');
                body.append(bar);
            }
        }
        children.push(body);
        if (link) {
            const anchor = el('a', 'replay-toast-link', link.text);
            anchor.href = link.href;
            anchor.target = '_blank';
            anchor.rel = 'noopener';
            if (link.label) anchor.setAttribute('aria-label', link.label);
            anchor.addEventListener('click', () => {
                state.unseen.clear(); // the gallery is about to be opened
                updateBadge();
                closeToast(toast);
            });
            if (kind === 'other') {
                // Part of the sentence: "... da tela de Beltrano · Ver", never split in two lines.
                const tail = el('span', 'replay-toast-tail');
                tail.append(document.createTextNode('\u00a0· '), anchor);
                body.append(tail);
            } else {
                children.push(anchor);
            }
        }
        if (kind !== 'generating') {
            const close = el('button', 'replay-toast-close');
            close.type = 'button';
            close.setAttribute('aria-label', 'Fechar aviso');
            close.append(icon('close'));
            close.addEventListener('click', () => closeToast(toast));
            children.push(close);
        }
        node.replaceChildren(...children);
        armToast(toast, ttl || 0);
    }

    function armToast(toast, ms) {
        clearTimeout(toast.timer);
        toast.timer = 0;
        toast.remaining = ms;
        if (!ms) return;
        toast.startedAt = Date.now();
        toast.timer = setTimeout(() => closeToast(toast), ms);
    }

    // The toast stays while the pointer or the keyboard is on it.
    function pauseToast(toast) {
        if (!toast.timer) return;
        clearTimeout(toast.timer);
        toast.timer = 0;
        toast.remaining -= Date.now() - toast.startedAt;
    }

    function resumeToast(toast) {
        if (toast.timer || toast.closed || toast.remaining <= 0) return;
        if (toast.node.matches(':hover') || toast.node.contains(document.activeElement)) return;
        armToast(toast, Math.max(toast.remaining, 2000));
    }

    function closeToast(toast, now = false) {
        if (toast.closed) return;
        toast.closed = true;
        clearTimeout(toast.timer);
        state.toasts = state.toasts.filter((t) => t !== toast);
        const done = () => {
            toast.node.remove();
            const root = document.getElementById('replayToasts');
            if (root && !root.children.length) root.remove();
        };
        if (now || !toast.node.isConnected) {
            done();
            return;
        }
        toast.node.classList.add('is-leaving');
        setTimeout(done, timings.leaveMs);
    }

    // ---- the gallery ---------------------------------------------------------------------------------------------

    function updateBadge() {
        const button = document.getElementById(GALLERY_BUTTON_ID);
        const badge = document.getElementById(GALLERY_BADGE_ID);
        const count = state.unseen.size;
        if (badge) {
            badge.textContent = count > 9 ? '9+' : String(count);
            badge.classList.toggle('hidden', count === 0);
        }
        if (button) {
            button.setAttribute(
                'aria-label',
                count ? `Galeria de replays, ${count} ${count === 1 ? 'novo' : 'novos'}` : 'Galeria de replays'
            );
        }
    }

    function openGallery(clipId) {
        const url = L.galleryUrl({ clip: clipId, fromRoom: true });
        window.open(url, '_blank', 'noopener');
        state.unseen.clear();
        updateBadge();
    }

    function wireGalleryButton() {
        const button = document.getElementById(GALLERY_BUTTON_ID);
        if (!button) return;
        if (!button.dataset.replayWired) {
            button.dataset.replayWired = '1';
            button.addEventListener('click', () => openGallery());
            const bar = document.getElementById('bottomButtons');
            const placement = () => (bar && bar.dataset.position === 'horizontal' ? 'right' : 'top');
            tip(button, 'Galeria de replays', placement());
            button.addEventListener('mouseenter', () => button._tippy?.setProps({ placement: placement() }));
        }
        button.classList.toggle('hidden', !state.enabled);
        updateBadge();
    }

    // ---- start ---------------------------------------------------------------------------------------------------

    function enable(config = {}) {
        state.enabled = true;
        if (isNumber(config.maxSeconds) && config.maxSeconds > 0) state.maxSeconds = config.maxSeconds;
        if (Array.isArray(config.options)) {
            const options = config.options.filter((value) => isNumber(value) && value > 0);
            if (options.length) state.options = options;
        }
        wireGalleryButton();
        renderAll();
    }

    function disable() {
        state.enabled = false;
        closePopover({ restoreFocus: false });
        wireGalleryButton();
        renderAll();
    }

    async function start() {
        // The events can come before /config answers (the join may be fast): listen first, show later.
        if (!wireSocket()) {
            let tries = 0;
            const timer = setInterval(() => {
                if (wireSocket() || ++tries > 150) clearInterval(timer);
            }, 100);
        }
        try {
            const response = await fetch('/config', { cache: 'no-store' });
            const config = await response.json();
            if (config && config.replay && config.replay.enabled) enable(config.replay);
        } catch {
            // the room works without it
        }
    }

    const api = {
        attachScreen,
        enable,
        disable,
        openGallery,
        closePopover,
        wireSocket,
        start,
        timings,
        state,
        version: 1,
    };
    start();
    return api;
})();
