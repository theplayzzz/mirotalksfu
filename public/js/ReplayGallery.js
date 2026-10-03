'use strict';

// Replay gallery (/replay/): the list with filters and live updates, the player with its own controls, the
// downloads (the MP4 one shows the real progress) and the password form. Same shape as LivePix.js: a self
// contained IIFE, fetch + EventSource, text in Portuguese. See docs/REPLAY.md, section 7.
window.ReplayGallery = (() => {
    const L = window.ReplayLogic;
    if (!L) {
        console.error('ReplayLogic.js did not load');
        return null;
    }

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const STREAM_EVENTS = ['clip.created', 'clip.deleted', 'mp4.progress', 'mp4.ready', 'mp4.error'];
    const SEEK_STEP_S = 5;
    const MP4_RATIO_KEY = 'replay.mp4Ratio';
    const VOLUME_KEY = 'replay.volume';
    const EXPIRES_SOON_MS = 24 * 3600 * 1000;
    const dayFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const hourFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const reducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Tests shorten these.
    const timings = {
        idleMs: 2800, // controls fade after this long without the pointer
        tickMs: 30000, // "há 3 min" and "expira em" are refreshed
        mp4PollMs: 2500, // fallback when the stream is silent while a conversion runs
        mp4QuietMs: 4000, // how long the stream may be silent before polling
        reconnectMs: 3000,
        refreshDelayMs: 300,
        leaveMs: 220,
    };

    const $ = (id) => document.getElementById(id);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function icon(name, className = '') {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', `rg-i ${className}`.trim());
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', `#i-${name}`);
        svg.append(use);
        return svg;
    }

    function setIcon(button, name) {
        button.querySelector('use')?.setAttribute('href', `#i-${name}`);
    }

    let storage = null;
    try {
        storage = window.localStorage;
    } catch {
        storage = null;
    }
    const store = {
        get(key) {
            try {
                return storage ? storage.getItem(key) : null;
            } catch {
                return null;
            }
        },
        set(key, value) {
            try {
                if (storage) storage.setItem(key, value);
            } catch {
                // private mode: nothing to remember
            }
        },
    };

    const query = new URLSearchParams(location.search);
    const fromRoom = query.get('from') === 'room';
    const wantedClip = L.isClipId(query.get('clip')) ? query.get('clip') : '';
    const peer = L.readPeerUuid(storage);

    const app = {
        view: 'loading', // loading | login | browse | player
        clips: [],
        offset: 0, // the server clock minus this one, ms
        retentionDays: 7,
        scope: 'all',
        person: '',
        loaded: false,
        listError: false,
        stream: null,
        streamDown: false,
        reconnectTimer: 0,
        refreshTimer: 0,
        tickTimer: 0,
        openId: null,
        returnFocus: null,
        returnScroll: 0,
        cards: new Map(), // id -> { el, link, refs }
        freshIds: new Set(), // clips that arrived live: they get the entrance animation
        peopleKey: '',
        mp4Ratio: Number(store.get(MP4_RATIO_KEY)) || L.DEFAULT_MP4_RATIO,
    };
    const now = () => Date.now() + app.offset;

    // ---- talking to the server ------------------------------------------------------------------------------

    async function api(path, { method = 'GET', body } = {}) {
        const headers = { Accept: 'application/json' };
        if (peer) headers['X-Replay-Peer'] = peer;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            credentials: 'same-origin',
            cache: 'no-store',
        });
        let data = null;
        try {
            data = await response.json();
        } catch {
            data = null;
        }
        if (response.status === 401 && !path.endsWith('/login')) onUnauthorized();
        return {
            ok: response.ok,
            status: response.status,
            data,
            retryAfter: Number(response.headers.get('Retry-After')) || 0,
        };
    }

    // ---- small pieces of the page --------------------------------------------------------------------------

    const live = {
        text: { on: 'ao vivo', retry: 'reconectando…', off: '' },
        hint: {
            on: 'Os replays novos aparecem aqui na hora',
            retry: 'Reconectando para receber os replays novos',
            off: '',
        },
    };
    function setLive(state) {
        $('rgLive').dataset.state = state;
        $('rgLive').title = live.hint[state] || '';
        $('rgLiveText').textContent = live.text[state] || '';
    }

    let toastTimer = 0;
    function toast(text, ms = 3600) {
        const node = $('rgToast');
        node.textContent = text;
        node.hidden = false;
        node.style.animation = 'none';
        void node.offsetWidth;
        node.style.animation = '';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (node.hidden = true), ms);
    }

    function showView(name) {
        app.view = name;
        $('rgLoading').hidden = name !== 'loading';
        $('rgLogin').hidden = name !== 'login';
        $('rgBrowse').hidden = name !== 'browse';
        $('rgPlayerView').hidden = name !== 'player';
        $('rgMain').setAttribute('aria-busy', name === 'loading' ? 'true' : 'false');
        if (name === 'login' || name === 'loading') setLive('off');
    }

    function setUrl(clipId) {
        const next = new URLSearchParams();
        if (clipId) next.set('clip', clipId);
        if (fromRoom) next.set('from', 'room');
        const text = next.toString();
        // Never push: the tab keeps one history entry, so window.close() keeps working for "Voltar para a sala".
        history.replaceState(null, '', `${location.pathname}${text ? `?${text}` : ''}`);
    }

    const clipTitle = (clip) => `Tela de ${clip.sharer || 'alguém'}`;
    const lengthOf = (clip) => L.playerRange(clip, NaN).length;
    const currentClip = () => app.clips.find((clip) => clip.id === app.openId) || null;

    // ---- the list ---------------------------------------------------------------------------------------------

    async function loadList() {
        let res;
        try {
            res = await api('/replay/api/clips');
        } catch {
            return listFailed();
        }
        if (res.status === 401) return; // the form is showing
        if (!res.ok || !res.data || !Array.isArray(res.data.clips)) return listFailed();
        applyList(res.data);
    }

    function applyList(data) {
        app.clips = L.sortNewestFirst(data.clips.filter((clip) => clip && L.isClipId(clip.id)));
        if (isNumber(data.now)) app.offset = data.now - Date.now();
        if (isNumber(data.retentionDays)) app.retentionDays = data.retentionDays;
        app.listError = false;
        if (!app.loaded) {
            app.loaded = true;
            connectStream();
            clearInterval(app.tickTimer);
            app.tickTimer = setInterval(updateTimes, timings.tickMs);
            if (wantedClip) {
                openClip(wantedClip, null).then((opened) => {
                    if (!opened) showBrowse();
                });
            } else {
                showBrowse();
            }
            return;
        }
        if (app.view === 'loading') showBrowse();
        else if (app.view === 'browse') renderBrowse();
        else if (app.view === 'player') {
            const open = currentClip();
            if (!open) return closePlayer({ notice: 'Este replay foi excluído.' });
            syncOpenClip();
            renderOwner(open);
            renderDownloads(open);
            if (open.files && open.files.mp4 && M.phase !== 'ready') {
                stopMp4Watch();
                M.phase = 'ready';
                mp4Render();
            }
        }
    }

    // The player keeps its own reference to the clip: point it at the newest copy after the list changes.
    function syncOpenClip() {
        if (!P.clip) return;
        const fresh = app.clips.find((clip) => clip.id === P.clip.id);
        if (fresh && fresh !== P.clip) P.clip = fresh;
    }

    function listFailed() {
        app.listError = true;
        if (app.view === 'loading' || app.view === 'browse') {
            showView('browse');
            renderBrowse();
        }
    }

    // Reloads the list soon: it also tells which clips are mine, which a live event cannot.
    function refreshSoon() {
        clearTimeout(app.refreshTimer);
        app.refreshTimer = setTimeout(loadList, timings.refreshDelayMs);
    }

    function showBrowse() {
        showView('browse');
        renderBrowse();
    }

    function visibleClips() {
        return L.filterClips(app.clips, { scope: app.scope, person: app.person });
    }

    function renderBrowse() {
        const toolbar = document.querySelector('.rg-toolbar');
        const failed = app.listError && !app.clips.length;
        toolbar.hidden = failed || !app.clips.length;
        $('rgGrid').hidden = failed;
        $('rgError').hidden = !failed;
        $('rgFoot').hidden = failed;
        if (failed) {
            $('rgEmpty').hidden = true;
            return;
        }

        syncPeople();
        const shown = visibleClips();
        syncGrid(shown);
        syncEmpty(shown);

        for (const button of document.querySelectorAll('.rg-seg-btn')) {
            button.setAttribute('aria-pressed', String(button.dataset.scope === app.scope));
        }
        const total = app.clips.length;
        $('rgCount').textContent =
            shown.length === total
                ? `${total} ${total === 1 ? 'replay' : 'replays'}`
                : `${shown.length} de ${total} ${total === 1 ? 'replay' : 'replays'}`;
        $('rgFoot').textContent =
            `Os replays ficam guardados por ${app.retentionDays} ${app.retentionDays === 1 ? 'dia' : 'dias'}. ` +
            'Quem salvou o replay ou compartilhou a tela pode excluí-lo.';
    }

    function syncPeople() {
        const names = L.people(app.clips);
        if (app.person && !names.includes(app.person)) app.person = '';
        const key = names.join('\u0000');
        const select = $('rgPerson');
        if (key !== app.peopleKey) {
            app.peopleKey = key;
            select.replaceChildren(new Option('Todas', ''), ...names.map((name) => new Option(name, name)));
        }
        select.value = app.person;
    }

    function syncEmpty(shown) {
        const empty = $('rgEmpty');
        empty.hidden = shown.length > 0;
        if (shown.length) return;
        const filtered = !!app.person || app.scope === 'mine';
        const action = $('rgEmptyAction');
        action.hidden = !filtered;
        if (!app.clips.length) {
            $('rgEmptyTitle').textContent = 'Nenhum replay ainda';
            $('rgEmptyText').textContent =
                'Na sala, passe o mouse sobre uma tela compartilhada e use o botão de replay para salvar os últimos minutos.';
        } else if (app.scope === 'mine' && !peer && !app.person) {
            $('rgEmptyTitle').textContent = 'Não dá para saber quais são seus';
            $('rgEmptyText').textContent =
                'Este navegador não entrou na sala. Abra a galeria pelo botão Galeria dentro da sala para ver os seus replays.';
        } else {
            $('rgEmptyTitle').textContent = 'Nenhum replay com esses filtros';
            $('rgEmptyText').textContent = 'Tente outra pessoa, ou mostre todos os replays.';
        }
    }

    // Keeps the cards of the list in step with the clips: adds, removes and reorders without rebuilding the rest.
    function syncGrid(shown) {
        const grid = $('rgGrid');
        const wanted = new Set(shown.map((clip) => clip.id));
        for (const [id, card] of app.cards) {
            if (wanted.has(id)) continue;
            app.cards.delete(id);
            leave(card.el);
        }
        // The cards that are fading out stay where they are; the others follow the order of the list.
        const current = [...grid.children].filter((node) => !node.classList.contains('is-leaving'));
        shown.forEach((clip, index) => {
            let card = app.cards.get(clip.id);
            if (!card) {
                card = createCard(clip);
                app.cards.set(clip.id, card);
            }
            updateCard(card, clip);
            if (current[index] === card.el) return;
            grid.insertBefore(card.el, current[index] || null);
            const old = current.indexOf(card.el);
            if (old !== -1) current.splice(old, 1);
            current.splice(index, 0, card.el);
        });
    }

    function leave(node) {
        if (reducedMotion || !node.isConnected) return node.remove();
        node.classList.add('is-leaving');
        setTimeout(() => node.remove(), timings.leaveMs);
    }

    function cardHref(clip) {
        return L.galleryUrl({ clip: clip.id, fromRoom });
    }

    function createCard(clip) {
        const li = el('li', 'rg-card');
        li.dataset.id = clip.id;

        const link = el('a', 'rg-card-link');
        link.href = cardHref(clip);

        const thumb = el('span', 'rg-thumb');
        const img = new Image();
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => thumb.classList.add('is-empty'));
        img.src = L.mediaUrl(clip.id, 'thumb.jpg');
        const empty = el('span', 'rg-thumb-empty');
        empty.append(icon('film'));
        const dur = el('span', 'rg-dur');
        const pill = el('span', 'rg-pill');
        pill.append(icon('check'), document.createTextNode('MP4 pronto'));
        thumb.append(img, empty, dur, pill);

        const body = el('span', 'rg-card-body');
        const title = el('strong', 'rg-card-title');
        const sub = el('span', 'rg-card-sub');
        const foot = el('span', 'rg-card-foot');
        body.append(title, sub, foot);
        link.append(thumb, body);
        li.append(link);

        link.addEventListener('click', (event) => {
            if (
                event.defaultPrevented ||
                event.button ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
            )
                return;
            event.preventDefault();
            openClip(clip.id, link);
        });

        if (app.freshIds.delete(clip.id) && !reducedMotion) {
            li.classList.add('is-new');
            setTimeout(() => li.classList.remove('is-new'), 2600);
        }
        return { el: li, link, img, dur, pill, title, sub, foot, del: null, mine: false };
    }

    function updateCard(card, clip) {
        card.title.textContent = clipTitle(clip);
        card.title.title = clipTitle(clip);
        card.sub.textContent = [
            clip.requestedBy ? `Salvo por ${clip.requestedBy}` : '',
            L.formatAgo(now() - clip.createdAt),
        ]
            .filter(Boolean)
            .join(' · ');
        const left = clip.expiresAt - now();
        card.foot.textContent = L.formatLeft(left);
        card.foot.classList.toggle('is-soon', left < EXPIRES_SOON_MS);
        card.dur.textContent = L.formatClock(lengthOf(clip));
        card.pill.hidden = !(clip.files && clip.files.mp4);
        card.link.setAttribute(
            'aria-label',
            `${clipTitle(clip)}, ${clip.requestedBy ? `salvo por ${clip.requestedBy}, ` : ''}${L.formatAgo(now() - clip.createdAt)}, ` +
                `duração ${L.formatClock(lengthOf(clip))}`
        );
        if (clip.mine && !card.del) {
            card.del = el('button', 'rg-card-del');
            card.del.type = 'button';
            card.del.setAttribute('aria-label', `Excluir o replay de ${clip.sharer || 'alguém'}`);
            card.del.title = 'Excluir';
            card.del.append(icon('trash'));
            card.del.addEventListener('click', () => askDeleteCard(card, clip.id));
            card.el.append(card.del);
        } else if (!clip.mine && card.del) {
            card.del.remove();
            card.del = null;
        }
    }

    function updateTimes() {
        for (const clip of app.clips) {
            const card = app.cards.get(clip.id);
            if (card) updateCard(card, clip);
        }
        const open = currentClip();
        if (open && app.view === 'player') renderMeta(open);
    }

    // ---- deleting ---------------------------------------------------------------------------------------------

    function askDeleteCard(card, id) {
        if (card.el.querySelector('.rg-card-confirm')) return;
        card.el.classList.add('is-confirming');
        const box = el('div', 'rg-card-confirm');
        box.setAttribute('role', 'alertdialog');
        box.setAttribute('aria-label', 'Excluir este replay?');
        const question = el('p', '', 'Excluir este replay para todo mundo?');
        const row = el('div');
        const yes = el('button', 'rg-btn rg-btn-danger', 'Excluir');
        const no = el('button', 'rg-btn', 'Cancelar');
        yes.type = no.type = 'button';
        row.append(yes, no);
        box.append(question, row);
        const close = () => {
            box.remove();
            card.el.classList.remove('is-confirming');
            card.del?.focus();
        };
        no.addEventListener('click', close);
        yes.addEventListener('click', async () => {
            yes.disabled = no.disabled = true;
            yes.textContent = 'Excluindo…';
            const done = await deleteClip(id);
            if (!done) {
                box.remove();
                card.el.classList.remove('is-confirming');
            }
        });
        box.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            close();
        });
        card.el.append(box);
        no.focus();
    }

    async function deleteClip(id) {
        let res;
        try {
            res = await api(`/replay/api/clips/${id}`, { method: 'DELETE' });
        } catch {
            toast('Sem conexão. Não deu para excluir o replay.');
            return false;
        }
        if (res.status === 401) return false;
        if (res.status === 403) {
            toast('Só quem salvou o replay ou compartilhou a tela pode excluí-lo.');
            return false;
        }
        if (!res.ok) {
            toast('Não deu para excluir o replay. Tente de novo.');
            return false;
        }
        // The stream may have told the page before this answer did: either way the person hears it.
        removeClipLocal(id, { notice: 'Replay excluído.' });
        toast('Replay excluído.');
        return true;
    }

    function removeClipLocal(id, { notice } = {}) {
        app.clips = L.removeClip(app.clips, id);
        if (app.openId === id) {
            closePlayer({ notice: notice || 'Este replay foi excluído.' });
            return;
        }
        if (app.view === 'browse') renderBrowse();
    }

    // ---- live updates -----------------------------------------------------------------------------------------

    function connectStream() {
        if (app.stream || typeof EventSource === 'undefined') return;
        clearTimeout(app.reconnectTimer);
        const source = new EventSource('/replay/api/stream');
        app.stream = source;
        source.onopen = () => {
            setLive('on');
            if (app.streamDown) {
                app.streamDown = false;
                refreshSoon(); // something may have happened while it was down
            }
        };
        source.onerror = () => {
            setLive('retry');
            app.streamDown = true;
            if (source.readyState === EventSource.CLOSED) {
                app.stream = null;
                scheduleReconnect();
            }
        };
        const take = (type, text) => {
            try {
                handleEvent(type, JSON.parse(text));
            } catch (error) {
                console.warn('Replay stream event ignored', type, error);
            }
        };
        // The server may send named events (event: clip.created) or plain messages with the type inside.
        source.onmessage = (event) => {
            let type = '';
            try {
                type = JSON.parse(event.data).type;
            } catch {
                return;
            }
            if (STREAM_EVENTS.includes(type)) take(type, event.data);
        };
        for (const type of STREAM_EVENTS) source.addEventListener(type, (event) => take(type, event.data));
    }

    function scheduleReconnect() {
        clearTimeout(app.reconnectTimer);
        app.reconnectTimer = setTimeout(async () => {
            let res = null;
            try {
                res = await api('/replay/api/me');
            } catch {
                res = null;
            }
            if (res && res.ok) connectStream();
            else if (!res || res.status !== 401) scheduleReconnect();
        }, timings.reconnectMs);
    }

    function handleEvent(type, data) {
        if (!data || typeof data !== 'object') return;
        switch (type) {
            case 'clip.created':
                if (data.clip && L.isClipId(data.clip.id)) {
                    const known = app.clips.find((clip) => clip.id === data.clip.id);
                    if (!known) app.freshIds.add(data.clip.id);
                    app.clips = L.upsertClip(app.clips, { mine: false, ...known, ...data.clip });
                    syncOpenClip();
                    if (app.view === 'browse') renderBrowse();
                    refreshSoon();
                }
                break;
            case 'clip.deleted':
                if (L.isClipId(data.id)) removeClipLocal(data.id);
                break;
            case 'mp4.progress':
                if (data.id === app.openId) {
                    mp4Apply(
                        data.id,
                        { state: 'running', progress: data.progress, etaSeconds: data.etaSeconds, ahead: data.ahead },
                        { stream: true }
                    );
                }
                break;
            case 'mp4.ready':
                if (data.id === app.openId) M.streamAt = Date.now();
                markMp4Ready(data.id, data.mp4);
                break;
            case 'mp4.error':
                if (data.id === app.openId) {
                    M.streamAt = Date.now();
                    mp4Fail();
                }
                break;
            default:
                break;
        }
    }

    function markMp4Ready(id, mp4) {
        const clip = app.clips.find((c) => c.id === id);
        if (!clip) return;
        clip.files = { ...clip.files, mp4: { name: 'clip.mp4', mime: 'video/mp4', ...(mp4 || {}) } };
        syncOpenClip();
        const card = app.cards.get(id);
        if (card) updateCard(card, clip);
        if (id === app.openId) mp4Done(clip);
    }

    // ---- the password form -----------------------------------------------------------------------------------

    function showLogin(message = '') {
        showView('login');
        $('rgLoginError').textContent = message;
        $('rgLoginSubmit').disabled = false;
        $('rgLoginSubmit').textContent = 'Entrar';
        setTimeout(() => $('rgPassword').focus({ preventScroll: true }), 30);
    }

    function onUnauthorized() {
        if (app.view === 'login') return;
        app.stream?.close();
        app.stream = null;
        clearTimeout(app.reconnectTimer);
        clearInterval(app.tickTimer);
        clearTimeout(app.refreshTimer);
        stopMp4Watch();
        resetPlayer();
        app.loaded = false;
        app.openId = null;
        app.cards.clear();
        $('rgGrid').replaceChildren();
        showLogin();
    }

    let lockTimer = 0;
    function wireLogin() {
        $('rgLoginForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            const input = $('rgPassword');
            const submit = $('rgLoginSubmit');
            const error = $('rgLoginError');
            if (!input.value) {
                error.textContent = 'Digite a senha da sala.';
                input.focus();
                return;
            }
            error.textContent = '';
            submit.disabled = true;
            submit.textContent = 'Entrando…';
            let res = null;
            try {
                res = await api('/replay/api/login', { method: 'POST', body: { password: input.value } });
            } catch {
                res = null;
            }
            if (res && res.ok) {
                input.value = '';
                showView('loading');
                loadList();
                return;
            }
            submit.disabled = false;
            submit.textContent = 'Entrar';
            if (!res) error.textContent = 'Sem conexão. Tente de novo.';
            else if (res.status === 429) lockLogin(res.retryAfter || 5);
            else if (res.status === 401) {
                error.textContent = 'Senha incorreta. Confira e tente de novo.';
                input.select();
            } else error.textContent = 'Não deu para entrar agora. Tente de novo.';
        });
    }

    function lockLogin(seconds) {
        const submit = $('rgLoginSubmit');
        const error = $('rgLoginError');
        let left = Math.max(1, Math.ceil(seconds));
        const paint = () => {
            error.textContent = `Muitas tentativas. Tente de novo em ${left} s.`;
            submit.disabled = true;
        };
        paint();
        clearInterval(lockTimer);
        lockTimer = setInterval(() => {
            left -= 1;
            if (left <= 0) {
                clearInterval(lockTimer);
                error.textContent = '';
                submit.disabled = false;
                $('rgPassword').focus();
            } else paint();
        }, 1000);
    }

    // ---- the player -------------------------------------------------------------------------------------------

    const video = $('rpVideo');
    const stage = $('rpStage');
    const timeline = $('rpTimeline');

    const P = {
        clip: null,
        range: { start: 0, end: 0, length: 0 },
        source: null,
        triedMp4: false,
        dragging: false,
        dragMedia: 0,
        pendingSeek: null,
        raf: 0,
        idleTimer: 0,
        lastAria: -1,
        startRetried: false,
        tapWasIdle: false,
        fullscreenChangedAt: 0,
    };

    function chooseSource(clip) {
        const original = clip.files && clip.files.original;
        const mp4 = clip.files && clip.files.mp4;
        const probe = document.createElement('video');
        const can = (file) => !!file && !!file.mime && probe.canPlayType(String(file.mime).split(';')[0]) !== '';
        if (can(original)) return { kind: 'original', name: original.name, url: L.mediaUrl(clip.id, original.name) };
        if (mp4) return { kind: 'mp4', name: mp4.name || 'clip.mp4', url: L.mediaUrl(clip.id, mp4.name || 'clip.mp4') };
        if (original) return { kind: 'original', name: original.name, url: L.mediaUrl(clip.id, original.name) };
        return null;
    }

    async function openClip(id, trigger) {
        if (!L.isClipId(id)) return false;
        let clip = app.clips.find((c) => c.id === id);
        if (!clip) {
            let res = null;
            try {
                res = await api(`/replay/api/clips/${id}`);
            } catch {
                res = null;
            }
            if (res && res.status === 401) return false;
            if (!res || !res.ok || !res.data || !L.isClipId(res.data.id)) {
                toast('Esse replay não existe mais. Ele pode ter expirado ou sido excluído.', 5200);
                return false;
            }
            clip = { mine: false, ...res.data };
            app.clips = L.upsertClip(app.clips, clip);
        }

        if (app.view === 'browse') app.returnScroll = window.scrollY;
        app.returnFocus = trigger || null;
        app.openId = clip.id;
        showView('player');
        const card = app.cards.get(clip.id);
        const ratio = card && card.img.naturalWidth ? card.img.naturalWidth / card.img.naturalHeight : 0;
        loadPlayer(clip, ratio);
        setUrl(clip.id);
        document.title = `${clipTitle(clip)} · Replays`;
        window.scrollTo(0, 0);
        $('rpTitle').focus({ preventScroll: true });
        return true;
    }

    function closePlayer({ notice } = {}) {
        if (app.view !== 'player') {
            app.openId = null;
            return;
        }
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        resetPlayer();
        app.openId = null;
        setUrl(null);
        document.title = 'Replays · LinkDoNotle';
        showBrowse();
        window.scrollTo(0, app.returnScroll || 0);
        const target = app.returnFocus && app.returnFocus.isConnected ? app.returnFocus : $('rgMain');
        target.focus({ preventScroll: true });
        app.returnFocus = null;
        if (notice) toast(notice);
    }

    function resetPlayer() {
        cancelAnimationFrame(P.raf);
        clearTimeout(P.idleTimer);
        video.pause();
        video.removeAttribute('src');
        video.removeAttribute('poster');
        try {
            video.load();
        } catch {
            // nothing loaded yet
        }
        P.clip = null;
        P.source = null;
        P.dragging = false;
        P.pendingSeek = null;
        stage.classList.remove('is-playing', 'is-ended', 'is-idle');
        $('rpFail').hidden = true;
        $('rpSpinner').hidden = true;
        $('rpConfirm').hidden = true;
        stopMp4Watch();
    }

    function loadPlayer(clip, ratio) {
        resetPlayer();
        P.clip = clip;
        P.triedMp4 = false;
        P.startRetried = false;
        P.range = L.playerRange(clip, NaN);
        P.lastAria = -1;
        stage.style.setProperty('--rp-ar', String(ratio ? clamp(ratio, 0.4, 3.2).toFixed(4) : 1.7778));
        for (const button of document.querySelectorAll('.rp-speed-btn')) {
            button.setAttribute('aria-pressed', String(button.dataset.rate === '1'));
        }
        video.playbackRate = 1;
        applyStoredVolume();

        const thumb = L.mediaUrl(clip.id, 'thumb.jpg');
        if (thumb) video.poster = thumb;
        P.source = chooseSource(clip);
        if (P.source) {
            $('rpSpinner').hidden = false;
            video.src = P.source.url;
        } else {
            showFail('Este replay não tem um arquivo para reproduzir.');
        }

        $('rpTitle').textContent = clipTitle(clip);
        renderMeta(clip);
        renderOwner(clip);
        renderDownloads(clip);
        mp4Reset(clip);
        paintTimeline();
        syncPlayButtons();
    }

    function renderMeta(clip) {
        const meta = $('rpMeta');
        const parts = [];
        if (clip.requestedBy) {
            const who = document.createDocumentFragment();
            who.append(document.createTextNode('Salvo por '), el('strong', '', clip.requestedBy));
            parts.push(who);
        }
        const created = new Date(clip.createdAt);
        parts.push(document.createTextNode(`${dayFormat.format(created)} às ${hourFormat.format(created)}`));
        parts.push(document.createTextNode(`duração ${L.formatClock(lengthOf(clip))}`));
        parts.push(document.createTextNode(L.formatLeft(clip.expiresAt - now())));
        const nodes = [];
        parts.forEach((part, index) => {
            if (index) nodes.push(document.createTextNode(' · '));
            nodes.push(part);
        });
        meta.replaceChildren(...nodes);
    }

    function renderOwner(clip) {
        $('rpDelete').hidden = !clip.mine;
    }

    function renderDownloads(clip) {
        const original = clip.files && clip.files.original;
        const link = $('rpOriginal');
        const note = [original && original.bytes ? L.formatBytes(original.bytes) : '', 'pode começar até ~1 min antes']
            .filter(Boolean)
            .join(' · ');
        $('rpOriginalNote').textContent = note;
        if (original) {
            link.href = L.mediaUrl(clip.id, original.name, true) || '#';
            link.removeAttribute('aria-disabled');
        } else {
            link.href = '#';
            link.setAttribute('aria-disabled', 'true');
        }
    }

    function showFail(message) {
        const fail = $('rpFail');
        fail.textContent = message;
        fail.hidden = false;
        $('rpSpinner').hidden = true;
    }

    // -- playing

    function syncPlayButtons() {
        const playing = !video.paused && !video.ended;
        const ended = video.ended;
        stage.classList.toggle('is-playing', playing);
        stage.classList.toggle('is-ended', ended);
        const label = ended ? 'Ver de novo' : playing ? 'Pausar' : 'Reproduzir';
        const play = $('rpPlay');
        setIcon(play, playing ? 'pause' : 'play');
        play.setAttribute('aria-label', label);
        play.title = `${label} (Espaço)`;
        const big = $('rpBig');
        setIcon(big, ended ? 'restart' : 'play');
        big.setAttribute('aria-label', label);
        big.tabIndex = playing ? -1 : 0;
    }

    function togglePlay() {
        if (!P.clip || !P.source) return;
        if (video.ended || (P.range.end && video.currentTime >= P.range.end - 0.05)) seekTimeline(0);
        if (video.paused) video.play().catch(() => {});
        else video.pause();
    }

    function seekMedia(seconds) {
        if (!P.clip) return;
        const target = clamp(seconds, P.range.start, P.range.end || seconds);
        try {
            video.currentTime = target;
        } catch {
            // metadata not loaded yet
        }
    }

    function seekTimeline(seconds) {
        seekMedia(L.toMedia(seconds, P.range));
    }

    function skip(delta) {
        const current = L.toTimeline(video.currentTime, P.range);
        seekTimeline(current + delta);
        paintTimeline();
    }

    function paintTimeline() {
        const range = P.range;
        const mediaTime = P.dragging ? P.dragMedia : video.currentTime || 0;
        const at = L.toTimeline(mediaTime, range);
        const fraction = range.length ? at / range.length : 0;
        timeline.style.setProperty('--pos', `${(fraction * 100).toFixed(3)}%`);
        let buffered = 0;
        try {
            for (let i = 0; i < video.buffered.length; i++) {
                if (video.buffered.start(i) <= mediaTime + 0.25 && video.buffered.end(i) >= mediaTime) {
                    buffered = video.buffered.end(i);
                }
            }
        } catch {
            buffered = 0;
        }
        const bufferedFraction = range.length ? L.toTimeline(buffered, range) / range.length : 0;
        timeline.style.setProperty('--buf', `${(Math.max(bufferedFraction, fraction) * 100).toFixed(3)}%`);
        $('rpTime').textContent = `${L.formatClock(at)} / ${L.formatClock(range.length)}`;
        const whole = Math.floor(at);
        if (whole !== P.lastAria) {
            P.lastAria = whole;
            timeline.setAttribute('aria-valuemax', String(Math.round(range.length)));
            timeline.setAttribute('aria-valuenow', String(whole));
            timeline.setAttribute('aria-valuetext', `${L.formatClock(at)} de ${L.formatClock(range.length)}`);
        }
    }

    function loop() {
        P.raf = 0;
        paintTimeline();
        if (!video.paused && !video.ended && P.clip) P.raf = requestAnimationFrame(loop);
    }

    function startLoop() {
        if (!P.raf) P.raf = requestAnimationFrame(loop);
    }

    function bumpActivity() {
        stage.classList.remove('is-idle');
        clearTimeout(P.idleTimer);
        P.idleTimer = setTimeout(() => {
            const busy = stage.querySelector('.rp-controls:hover, .rp-controls:focus-within');
            if (!video.paused && !video.ended && !busy && !P.dragging) stage.classList.add('is-idle');
        }, timings.idleMs);
    }

    function wireVideo() {
        video.addEventListener('loadedmetadata', () => {
            if (!P.clip) return;
            $('rpSpinner').hidden = true;
            P.range = L.playerRange(P.clip, video.duration);
            if (video.videoWidth && video.videoHeight) {
                stage.style.setProperty('--rp-ar', clamp(video.videoWidth / video.videoHeight, 0.4, 3.2).toFixed(4));
            }
            // The file starts at a key frame up to ~1 min before the part that was asked for: hide the lead-in.
            if (P.range.start > 0 && video.currentTime < P.range.start - 0.05) video.currentTime = P.range.start;
            paintTimeline();
        });
        video.addEventListener('loadeddata', () => {
            $('rpSpinner').hidden = true;
            if (P.clip && P.range.start > 0 && video.currentTime < P.range.start - 0.05 && !P.dragging) {
                video.currentTime = P.range.start;
            }
        });
        video.addEventListener('durationchange', () => {
            if (!P.clip) return;
            P.range = L.playerRange(P.clip, video.duration);
            paintTimeline();
        });
        video.addEventListener('play', () => {
            syncPlayButtons();
            startLoop();
            bumpActivity();
        });
        video.addEventListener('playing', () => {
            $('rpSpinner').hidden = true;
            syncPlayButtons();
            startLoop();
            // A browser that could not seek yet starts from the first frame (the lead-in): once, try again now.
            if (P.clip && !P.startRetried && P.range.start > 0 && video.currentTime < P.range.start - 0.3) {
                P.startRetried = true;
                video.currentTime = P.range.start;
            }
        });
        video.addEventListener('pause', () => {
            syncPlayButtons();
            paintTimeline();
            stage.classList.remove('is-idle');
            clearTimeout(P.idleTimer);
        });
        video.addEventListener('ended', () => {
            syncPlayButtons();
            paintTimeline();
            stage.classList.remove('is-idle');
        });
        video.addEventListener('waiting', () => ($('rpSpinner').hidden = !P.source));
        video.addEventListener('seeking', () => {
            if (!P.dragging) $('rpSpinner').hidden = false;
        });
        video.addEventListener('seeked', () => {
            $('rpSpinner').hidden = true;
            if (P.pendingSeek !== null) {
                const next = P.pendingSeek;
                P.pendingSeek = null;
                video.currentTime = next;
            }
            paintTimeline();
        });
        video.addEventListener('canplay', () => ($('rpSpinner').hidden = true));
        video.addEventListener('timeupdate', paintTimeline);
        video.addEventListener('progress', paintTimeline);
        video.addEventListener('volumechange', syncVolume);
        video.addEventListener('error', () => {
            if (!P.clip) return;
            // The original could be in a format this browser does not play: the MP4 does, if it exists.
            const mp4 = P.clip.files && P.clip.files.mp4;
            if (P.source && P.source.kind === 'original' && mp4 && !P.triedMp4) {
                P.triedMp4 = true;
                P.source = {
                    kind: 'mp4',
                    name: mp4.name || 'clip.mp4',
                    url: L.mediaUrl(P.clip.id, mp4.name || 'clip.mp4'),
                };
                video.src = P.source.url;
                return;
            }
            showFail(
                P.clip.files && P.clip.files.mp4
                    ? 'Não foi possível reproduzir este replay. Você pode baixar o arquivo abaixo.'
                    : 'Este navegador não consegue reproduzir este replay. Use Baixar MP4: ele toca em qualquer navegador.'
            );
        });

        // Click on the picture: play or pause. A first tap on a phone, while the controls are hidden, only brings
        // them back.
        stage.addEventListener(
            'pointerdown',
            (event) => {
                P.tapWasIdle = event.pointerType === 'touch' && stage.classList.contains('is-idle');
            },
            true
        );
        video.addEventListener('click', () => {
            if (P.tapWasIdle) {
                P.tapWasIdle = false;
                return;
            }
            togglePlay();
        });
        video.addEventListener('dblclick', toggleFullscreen);
        $('rpBig').addEventListener('click', () => {
            togglePlay();
            $('rpBig').blur();
        });
        $('rpPlay').addEventListener('click', togglePlay);

        for (const type of ['pointermove', 'pointerdown', 'touchstart'])
            stage.addEventListener(type, bumpActivity, { passive: true });
        stage.addEventListener('focusin', bumpActivity);
        stage.addEventListener('pointerleave', () => {
            if (!video.paused) bumpActivity();
        });

        // A button the mouse just pressed gives the keyboard back, so Space plays or pauses instead of pressing it again.
        stage.addEventListener('click', (event) => {
            const button = event.target.closest && event.target.closest('button');
            if (button && event.detail > 0 && button !== $('rpBig')) button.blur();
        });
    }

    // -- the timeline

    function fractionOf(event) {
        const rect = timeline.getBoundingClientRect();
        return rect.width ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
    }

    function dragTo(fraction, force = false) {
        P.dragMedia = L.toMedia(fraction * P.range.length, P.range);
        if (force || !video.seeking) {
            seekMedia(P.dragMedia);
            P.pendingSeek = null;
        } else {
            P.pendingSeek = P.dragMedia;
        }
        paintTimeline();
    }

    function showHover(event) {
        const rect = timeline.getBoundingClientRect();
        const hover = $('rpHover');
        hover.hidden = false;
        hover.textContent = L.formatClock(fractionOf(event) * P.range.length);
        timeline.style.setProperty('--hx', `${clamp(event.clientX - rect.left, 24, Math.max(24, rect.width - 24))}px`);
    }

    function wireTimeline() {
        timeline.addEventListener('pointerdown', (event) => {
            if (!P.clip || (event.pointerType === 'mouse' && event.button !== 0)) return;
            event.preventDefault();
            try {
                timeline.setPointerCapture(event.pointerId);
            } catch {
                // the pointer is already gone: the drag still follows the events it gets
            }
            P.dragging = true;
            timeline.classList.add('is-drag');
            timeline.focus({ preventScroll: true });
            dragTo(fractionOf(event), true);
        });
        timeline.addEventListener('pointermove', (event) => {
            if (event.pointerType === 'mouse' || P.dragging) showHover(event);
            if (P.dragging) dragTo(fractionOf(event));
        });
        const end = (event) => {
            if (!P.dragging) return;
            dragTo(fractionOf(event), true);
            P.dragging = false;
            timeline.classList.remove('is-drag');
            $('rpHover').hidden = true;
            paintTimeline();
        };
        timeline.addEventListener('pointerup', end);
        timeline.addEventListener('pointercancel', end);
        timeline.addEventListener('pointerleave', () => {
            if (!P.dragging) $('rpHover').hidden = true;
        });
    }

    // -- volume, speed, full screen, picture in picture

    function applyStoredVolume() {
        const saved = store.get(VOLUME_KEY);
        let volume = 1;
        let muted = false;
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (isNumber(parsed.volume)) volume = clamp(parsed.volume, 0, 1);
                muted = !!parsed.muted;
            } catch {
                // keep the defaults
            }
        }
        video.volume = volume;
        video.muted = muted;
        syncVolume();
    }

    function syncVolume() {
        const silent = video.muted || video.volume === 0;
        const mute = $('rpMute');
        setIcon(mute, silent ? 'mute' : 'volume');
        mute.setAttribute('aria-label', silent ? 'Ativar o som' : 'Silenciar');
        mute.title = `${silent ? 'Ativar o som' : 'Silenciar'} (M)`;
        $('rpVolume').value = String(silent ? 0 : video.volume);
        store.set(VOLUME_KEY, JSON.stringify({ volume: video.volume, muted: video.muted }));
    }

    function toggleMute() {
        if (video.muted || video.volume === 0) {
            video.muted = false;
            if (video.volume === 0) video.volume = 0.6;
        } else {
            video.muted = true;
        }
    }

    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else if (stage.requestFullscreen) {
            stage.requestFullscreen().catch(() => {});
        } else if (video.webkitEnterFullscreen) {
            video.webkitEnterFullscreen(); // iPhone: only the video itself goes full screen
        }
    }

    function wireControls() {
        $('rpMute').addEventListener('click', toggleMute);
        $('rpVolume').addEventListener('input', (event) => {
            const value = Number(event.target.value);
            video.volume = value;
            video.muted = value === 0;
        });
        for (const button of document.querySelectorAll('.rp-speed-btn')) {
            button.addEventListener('click', () => {
                video.playbackRate = Number(button.dataset.rate);
                for (const other of document.querySelectorAll('.rp-speed-btn')) {
                    other.setAttribute('aria-pressed', String(other === button));
                }
            });
        }
        $('rpFull').addEventListener('click', toggleFullscreen);
        document.addEventListener('fullscreenchange', () => {
            const on = document.fullscreenElement === stage;
            setIcon($('rpFull'), on ? 'collapse' : 'expand');
            $('rpFull').setAttribute('aria-label', on ? 'Sair da tela cheia' : 'Tela cheia');
            $('rpFull').title = `${on ? 'Sair da tela cheia' : 'Tela cheia'} (F)`;
            P.fullscreenChangedAt = Date.now();
        });
        const pip = $('rpPip');
        if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
            pip.hidden = false;
            pip.addEventListener('click', () => {
                if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
                else video.requestPictureInPicture().catch(() => {});
            });
        }
        $('rpBack').addEventListener('click', () => closePlayer());
    }

    // -- keys

    function onKey(event) {
        if (app.view !== 'player' || event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target;
        const tag = target && target.tagName;
        const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && target.type !== 'range');
        if (typing) return;
        if (tag === 'INPUT' && target.type === 'range' && event.key.startsWith('Arrow')) return; // the volume slider uses them

        if (event.key === 'Escape') {
            if (!$('rpConfirm').hidden) {
                closeConfirm();
                event.preventDefault();
            } else if (document.fullscreenElement || Date.now() - (P.fullscreenChangedAt || 0) < 250) {
                // the browser leaves full screen by itself
            } else {
                closePlayer();
                event.preventDefault();
            }
            return;
        }
        const onButton = target && target.closest && target.closest('button, a[href], summary');
        switch (event.key) {
            case ' ':
            case 'k':
                if (onButton) return; // Space presses the button that has the focus
                event.preventDefault();
                togglePlay();
                break;
            case 'ArrowLeft':
                event.preventDefault();
                skip(-SEEK_STEP_S);
                break;
            case 'ArrowRight':
                event.preventDefault();
                skip(SEEK_STEP_S);
                break;
            case 'Home':
                event.preventDefault();
                seekTimeline(0);
                break;
            case 'End':
                event.preventDefault();
                seekTimeline(P.range.length);
                break;
            case 'f':
            case 'F':
                toggleFullscreen();
                break;
            case 'm':
            case 'M':
                toggleMute();
                break;
            default:
                return;
        }
        bumpActivity();
    }

    // -- delete from the player

    function closeConfirm() {
        $('rpConfirm').hidden = true;
        $('rpDelete').focus({ preventScroll: true });
    }

    function wireDelete() {
        $('rpDelete').addEventListener('click', () => {
            $('rpConfirm').hidden = false;
            $('rpConfirmNo').focus({ preventScroll: true });
        });
        $('rpConfirmNo').addEventListener('click', closeConfirm);
        $('rpConfirmYes').addEventListener('click', async () => {
            const id = app.openId;
            if (!id) return;
            const yes = $('rpConfirmYes');
            yes.disabled = true;
            yes.textContent = 'Excluindo…';
            const done = await deleteClip(id);
            yes.disabled = false;
            yes.textContent = 'Excluir';
            if (!done) $('rpConfirm').hidden = true;
        });
    }

    // -- the MP4 download

    const M = {
        phase: 'idle',
        progress: 0,
        eta: null,
        ahead: undefined,
        firstRunAt: 0,
        lastEventAt: 0, // the last time anything told the page how it is going
        streamAt: 0, // the last time the stream did
        timer: 0,
        auto: false, // the person asked for it here: download it by itself when it is ready
        saidKey: '',
    };

    function mp4Reset(clip) {
        stopMp4Watch();
        const ready = !!(clip.files && clip.files.mp4);
        Object.assign(M, {
            phase: ready ? 'ready' : 'idle',
            progress: 0,
            eta: null,
            ahead: undefined,
            firstRunAt: 0,
            streamAt: 0,
            auto: false,
            saidKey: '',
        });
        mp4Render();
    }

    function mp4Render() {
        const clip = P.clip;
        if (!clip) return;
        const button = $('rpMp4');
        let title = 'Baixar MP4';
        let detail = '';
        if (M.phase === 'idle') {
            detail = L.estimateText(L.estimateMp4Seconds(clip.durationS, app.mp4Ratio));
        } else if (M.phase === 'ready') {
            const bytes = clip.files && clip.files.mp4 && clip.files.mp4.bytes;
            detail = `${bytes ? `${L.formatBytes(bytes)} · ` : ''}pronto para baixar`;
        } else if (M.phase === 'error') {
            const status = L.mp4Status({ state: 'error' });
            title = status.title;
            detail = status.detail;
        } else {
            const status = L.mp4Status({ state: M.phase, progress: M.progress, etaSeconds: M.eta, ahead: M.ahead });
            title = status.title;
            detail = status.detail;
            button.style.setProperty('--p', String(status.percent));
        }
        button.dataset.phase = M.phase;
        button.setAttribute('aria-disabled', String(M.phase === 'queued' || M.phase === 'running'));
        $('rpMp4Label').textContent = title;
        $('rpMp4Note').textContent = detail;
        announceMp4(title, detail);
    }

    // The screen reader hears the phase changes and every quarter of the way, not every tick.
    function announceMp4(title, detail) {
        const step = M.phase === 'running' ? Math.floor((Number(M.progress) || 0) * 4) : -1;
        const key = `${M.phase}:${step}`;
        if (key === M.saidKey) return;
        M.saidKey = key;
        $('rpMp4Status').textContent = M.phase === 'idle' ? '' : [title, detail].filter(Boolean).join(' ');
    }

    // `sentAt`: when the question that got this answer was asked; `stream`: it came on the stream. An answer to a
    // question asked before the stream said something newer is stale (it can arrive late): the stream wins.
    function mp4Apply(id, data, { sentAt = 0, stream = false } = {}) {
        if (id !== app.openId || !data) return;
        if (stream) M.streamAt = Date.now();
        else if (sentAt && M.streamAt > sentAt) return;
        const clip = P.clip;
        M.lastEventAt = Date.now();
        switch (data.state) {
            case 'ready':
                if (clip) mp4Done(clip);
                return;
            case 'error':
                mp4Fail();
                return;
            case 'queued':
                M.phase = 'queued';
                M.ahead = isNumber(data.ahead) ? data.ahead : undefined;
                M.progress = 0;
                break;
            case 'running':
                M.phase = 'running';
                M.ahead = undefined;
                if (isNumber(data.progress)) M.progress = data.progress;
                if (isNumber(data.etaSeconds)) M.eta = data.etaSeconds;
                if (!M.firstRunAt) M.firstRunAt = Date.now();
                break;
            default:
                return;
        }
        startMp4Watch();
        mp4Render();
    }

    function mp4Done(clip) {
        stopMp4Watch();
        if (M.firstRunAt && isNumber(clip.durationS)) {
            app.mp4Ratio = L.learnRatio(app.mp4Ratio, (Date.now() - M.firstRunAt) / 1000, clip.durationS);
            store.set(MP4_RATIO_KEY, String(app.mp4Ratio));
        }
        if (!clip.files || !clip.files.mp4)
            clip.files = { ...clip.files, mp4: { name: 'clip.mp4', mime: 'video/mp4' } };
        M.phase = 'ready';
        M.progress = 1;
        const card = app.cards.get(clip.id);
        if (card) updateCard(card, clip);
        mp4Render();
        // The size is not in the event: ask for the meta again.
        api(`/replay/api/clips/${clip.id}`)
            .then((res) => {
                if (res.ok && res.data && res.data.id === clip.id) {
                    clip.files = res.data.files;
                    if (app.openId === clip.id) mp4Render();
                }
            })
            .catch(() => {});
        // A browser that could not play the original plays the MP4.
        if (!$('rpFail').hidden && P.source && P.source.kind === 'original' && !P.triedMp4) {
            P.triedMp4 = true;
            P.source = { kind: 'mp4', name: 'clip.mp4', url: L.mediaUrl(clip.id, 'clip.mp4') };
            $('rpFail').hidden = true;
            video.src = P.source.url;
        }
        if (M.auto) {
            M.auto = false;
            toast('MP4 pronto. Baixando…');
            downloadMp4(clip);
        }
    }

    function mp4Fail() {
        stopMp4Watch();
        M.phase = 'error';
        M.auto = false;
        mp4Render();
        toast('Não deu para converter para MP4. Tente de novo.');
    }

    function downloadMp4(clip) {
        const url = L.mediaUrl(clip.id, 'clip.mp4', true);
        if (!url) return;
        const link = document.createElement('a');
        link.href = url;
        link.download = '';
        link.rel = 'noopener';
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
    }

    async function onMp4Click() {
        const clip = P.clip;
        if (!clip) return;
        if (M.phase === 'ready' || (clip.files && clip.files.mp4)) {
            downloadMp4(clip);
            return;
        }
        if (M.phase === 'queued' || M.phase === 'running') return;
        M.auto = true;
        M.firstRunAt = 0;
        M.phase = 'running';
        M.progress = 0;
        M.eta = null;
        M.lastEventAt = Date.now();
        mp4Render();
        const sentAt = Date.now();
        let res = null;
        try {
            res = await api(`/replay/api/clips/${clip.id}/mp4`, { method: 'POST' });
        } catch {
            res = null;
        }
        if (clip.id !== app.openId) return; // moved to another clip: the conversion goes on in the server
        if (!res || !res.ok || !res.data) {
            if (M.streamAt <= sentAt && (!res || res.status !== 401)) mp4Fail();
            return;
        }
        mp4Apply(clip.id, res.data, { sentAt });
    }

    // If the stream stays silent while a conversion runs, ask again: the answer of the server is always the truth.
    function startMp4Watch() {
        if (M.timer) return;
        M.timer = setInterval(async () => {
            const clip = P.clip;
            if (!clip || (M.phase !== 'queued' && M.phase !== 'running')) return stopMp4Watch();
            if (Date.now() - M.lastEventAt < timings.mp4QuietMs) return;
            const sentAt = Date.now();
            try {
                const res = await api(`/replay/api/clips/${clip.id}/mp4`, { method: 'POST' });
                if (res.ok && res.data) mp4Apply(clip.id, res.data, { sentAt });
            } catch {
                // offline for a moment: try again on the next tick
            }
        }, timings.mp4PollMs);
    }

    function stopMp4Watch() {
        clearInterval(M.timer);
        M.timer = 0;
    }

    // ---- toolbar and boot ----------------------------------------------------------------------------------

    function wireToolbar() {
        for (const button of document.querySelectorAll('.rg-seg-btn')) {
            button.addEventListener('click', () => {
                app.scope = button.dataset.scope;
                renderBrowse();
            });
        }
        $('rgPerson').addEventListener('change', (event) => {
            app.person = event.target.value;
            renderBrowse();
        });
        $('rgEmptyAction').addEventListener('click', () => {
            app.scope = 'all';
            app.person = '';
            renderBrowse();
        });
        $('rgRetry').addEventListener('click', () => {
            showView('loading');
            loadList();
        });
    }

    function wireBack() {
        if (!fromRoom) return; // a plain link to the room
        const back = $('rgBack');
        back.title = 'Fecha esta aba e volta para a sala';
        back.addEventListener('click', (event) => {
            event.preventDefault();
            window.close();
            // Not every tab can be closed by the page; never open the room again from here (it would be a second session).
            setTimeout(() => {
                if (!window.closed) toast('Pode fechar esta aba para voltar para a sala.', 6000);
            }, 300);
        });
    }

    function boot() {
        wireBack();
        wireToolbar();
        wireLogin();
        wireVideo();
        wireTimeline();
        wireControls();
        wireDelete();
        $('rpMp4').addEventListener('click', onMp4Click);
        document.addEventListener('keydown', onKey);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && app.loaded && app.view !== 'login') refreshSoon();
        });
        showView('loading');
        loadList();
    }

    boot();

    return { timings, state: app, player: P, openClip, closePlayer, refresh: loadList };
})();
