'use strict';

// Small shared room toys. No media processing, dependencies, modal backdrop or animation loop at rest.
window.RoomUtilities = (() => {
    const kinds = {
        d6: { label: 'd6', sides: 6 },
        d10: { label: 'd10', sides: 10 },
        d20: { label: 'd20', sides: 20 },
        coin: { label: 'Cara ou coroa', sides: 2 },
    };
    const state = {
        socket: null,
        session: '',
        rolls: [],
        queue: [],
        active: null,
        timer: null,
        ackTimer: null,
        historyTimer: null,
        busyTimer: null,
        busy: false,
        online: false,
        generation: 0,
    };
    let root, panel, trigger, list, status, viewer;
    const $ = (id) => document.getElementById(id);
    const result = (roll) => (roll.kind === 'coin' ? (roll.value === 1 ? 'Cara' : 'Coroa') : String(roll.value));
    const valid = (roll) =>
        roll &&
        typeof roll.id === 'string' &&
        Number.isInteger(roll.sequence) &&
        Number.isFinite(roll.at) &&
        kinds[roll.kind] &&
        Number.isInteger(roll.value) &&
        roll.value >= 1 &&
        roll.value <= kinds[roll.kind].sides;
    const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    function mount() {
        if (root) return;
        trigger = $('roomUtilitiesButton');
        if (!trigger) return;
        root = document.createElement('div');
        root.id = 'roomUtilities';
        root.className = 'room-utilities';
        root.innerHTML = `
            <section class="room-utilities__panel" id="roomUtilitiesPanel" aria-label="Utilidades da sala" hidden>
                <header class="room-utilities__header"><div><span class="room-utilities__eyebrow">Todo mundo vê o resultado</span><h2>Que a sorte decida.</h2></div><button type="button" id="roomUtilitiesClose" class="room-utilities__close" aria-label="Fechar utilidades">×</button></header>
                <div class="room-utilities__actions" role="group" aria-label="Escolha o que rolar">
                    <button type="button" data-roll="d6" aria-label="Rolar dado de 6 lados"><span class="room-utilities__symbol" aria-hidden="true">⚄</span><b>d6</b></button>
                    <button type="button" data-roll="d10" aria-label="Rolar dado de 10 lados"><span class="room-utilities__symbol room-utilities__shape--d10" aria-hidden="true">10</span><b>d10</b></button>
                    <button type="button" data-roll="d20" aria-label="Rolar dado de 20 lados"><span class="room-utilities__symbol room-utilities__shape--d20" aria-hidden="true">20</span><b>d20</b></button>
                    <button type="button" data-roll="coin" aria-label="Jogar cara ou coroa"><span class="room-utilities__symbol room-utilities__shape--coin" aria-hidden="true">↔</span><b>Moeda</b></button>
                </div>
                <p class="room-utilities__status" id="roomUtilitiesStatus" role="status" aria-live="polite"></p>
                <div class="room-utilities__history-heading"><h3>Últimas rolagens</h3><span>Histórico da sala · até 50</span></div>
                <ol class="room-utilities__history" id="roomUtilitiesHistory" aria-label="Histórico compartilhado"></ol>
                <p class="room-utilities__note">Vale enquanto a sala estiver aberta.</p>
            </section>
            <section class="room-utilities__viewer" id="roomUtilitiesViewer" aria-label="Resultado da rolagem" hidden>
                <div class="room-utilities__viewer-top"><span id="roomUtilitiesWho"></span><button type="button" id="roomUtilitiesDismiss" class="room-utilities__close" aria-label="Fechar resultado">×</button></div>
                <div class="room-utilities__arena"><span class="room-utilities__shadow"></span><div class="room-utilities__die" id="roomUtilitiesDie" aria-hidden="true"></div></div>
                <div class="room-utilities__outcome"><strong id="roomUtilitiesResult"></strong><span id="roomUtilitiesKind"></span></div>
                <span class="room-utilities__announcement" id="roomUtilitiesAnnouncement" role="status" aria-live="polite" aria-atomic="true"></span>
            </section>`;
        document.body.appendChild(root);
        panel = $('roomUtilitiesPanel');
        list = $('roomUtilitiesHistory');
        status = $('roomUtilitiesStatus');
        viewer = $('roomUtilitiesViewer');
        trigger.classList.remove('hidden');
        trigger.hidden = false;
        trigger.addEventListener('click', () => togglePanel(panel.hidden));
        $('roomUtilitiesClose').addEventListener('click', () => togglePanel(false, true));
        $('roomUtilitiesDismiss').addEventListener('click', next);
        root.querySelectorAll('[data-roll]').forEach((button) =>
            button.addEventListener('click', () => roll(button.dataset.roll))
        );
        document.addEventListener('pointerdown', (event) => {
            if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) togglePanel(false);
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !panel.hidden) {
                event.stopPropagation();
                togglePanel(false, true);
            }
        });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                state.queue.length = 0;
                clearTimeout(state.timer);
                viewer.hidden = true;
                state.active = null;
            }
        });
        renderHistory();
    }

    function togglePanel(open, focus = false) {
        panel.hidden = !open;
        trigger.setAttribute('aria-expanded', String(open));
        trigger.classList.toggle('is-active', open);
        if (open) {
            root.querySelector('[data-roll]')?.focus({ preventScroll: true });
            if (!state.online) sync();
        } else if (focus) trigger.focus({ preventScroll: true });
    }

    function updateButtons() {
        root?.querySelectorAll('[data-roll]').forEach((button) => {
            button.disabled = state.busy || !state.online;
        });
    }

    function remember(roll) {
        if (!valid(roll) || state.rolls.some((item) => item.id === roll.id)) return false;
        state.rolls.push(roll);
        state.rolls.sort((a, b) => a.sequence - b.sequence);
        state.rolls = state.rolls.slice(-50);
        renderHistory();
        return true;
    }

    function session(value) {
        if (typeof value !== 'string' || !value) return false;
        if (state.session && state.session !== value) {
            state.rolls = [];
            state.queue = [];
            clearTimeout(state.timer);
            viewer.hidden = true;
            state.active = null;
        }
        state.session = value;
        return true;
    }

    function receive(data, animate = true) {
        if (!data || !session(data.session) || !remember(data.roll)) return;
        if (!animate || document.hidden) return;
        state.queue.push(data.roll);
        // A busy room must not leave a minute of stale animations waiting to play.
        if (state.queue.length > 6) state.queue.splice(0, state.queue.length - 6);
        if (!state.active) next();
    }

    function renderHistory() {
        if (!list) return;
        list.replaceChildren();
        if (!state.rolls.length) {
            const empty = document.createElement('li');
            empty.className = 'room-utilities__empty';
            empty.textContent = 'A sorte ainda não foi lançada. Escolha um dado ou a moeda.';
            list.appendChild(empty);
            return;
        }
        for (const item of [...state.rolls].reverse()) {
            const row = document.createElement('li');
            const badge = document.createElement('span');
            badge.className = `room-utilities__history-type${item.kind === 'coin' ? ' is-coin' : ''}`;
            badge.textContent = item.kind === 'coin' ? '↔' : item.kind;
            const copy = document.createElement('div');
            const name = document.createElement('b');
            name.textContent = item.peerName;
            const detail = document.createElement('span');
            const time = new Date(item.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            detail.textContent = `${kinds[item.kind].label} · ${time}`;
            copy.append(name, detail);
            const value = document.createElement('strong');
            value.textContent = result(item);
            row.append(badge, copy, value);
            list.appendChild(row);
        }
    }

    function dieArt(roll) {
        const value = result(roll);
        const svg = (body) => `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
        if (roll.kind === 'coin')
            return svg(
                `<circle cx="60" cy="60" r="44" fill="#c08a42" stroke="#f6cf89" stroke-width="3"/><circle cx="60" cy="60" r="36" fill="#e5b868" stroke="#f8dc9f"/><text x="60" y="72" text-anchor="middle" fill="#6a492d" font-family="Georgia,serif" font-size="38">${roll.value === 1 ? 'C' : '♛'}</text>`
            );
        if (roll.kind === 'd6') {
            const positions = {
                1: [[57, 57]],
                2: [
                    [42, 42],
                    [72, 72],
                ],
                3: [
                    [42, 42],
                    [57, 57],
                    [72, 72],
                ],
                4: [
                    [42, 42],
                    [72, 42],
                    [42, 72],
                    [72, 72],
                ],
                5: [
                    [42, 42],
                    [72, 42],
                    [57, 57],
                    [42, 72],
                    [72, 72],
                ],
                6: [
                    [42, 39],
                    [72, 39],
                    [42, 57],
                    [72, 57],
                    [42, 75],
                    [72, 75],
                ],
            };
            return svg(
                `<path d="M24 18H89L105 33V98L89 109H24L12 94V33Z" fill="#794050" stroke="#db9ca9" stroke-width="2"/><path d="M24 18L89 18L89 94H12V33Z" fill="#b85869"/><path d="M89 18L105 33V98L89 94Z" fill="#653643"/>${positions[roll.value].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.3" fill="#fff0df"/>`).join('')}`
            );
        }
        const shape =
            roll.kind === 'd20'
                ? '<path d="M60 8L105 34L105 86L60 112L15 86L15 34Z" fill="#754554"/><path d="M60 8L85 42L105 34M85 42L60 91L105 86M60 91L35 42L15 86M35 42L60 8L15 34M35 42H85M60 91V112" fill="none" stroke="#e0acb5" stroke-width="1.6"/><path d="M35 42H85L60 91Z" fill="#b85869"/>'
                : '<path d="M60 6L104 46L95 86L60 114L25 86L16 46Z" fill="#754554"/><path d="M60 6L35 46L60 94L85 46Z" fill="#b85869"/><path d="M16 46H35L60 114L85 46H104M35 46L60 6L85 46M60 94V114" fill="none" stroke="#e0acb5" stroke-width="1.6"/>';
        return svg(
            `${shape}<text x="60" y="${roll.kind === 'd20' ? 65 : 57}" text-anchor="middle" fill="#fff0df" font-family="Consolas,monospace" font-weight="700" font-size="24">${value}</text>`
        );
    }

    function next() {
        clearTimeout(state.timer);
        viewer.hidden = true;
        viewer.classList.remove('is-rolling', 'is-revealed');
        state.active = state.queue.shift() || null;
        if (!state.active) return;
        const item = state.active;
        $('roomUtilitiesWho').textContent =
            `${item.peerName} ${item.kind === 'coin' ? 'jogou a moeda' : `rolou ${item.kind}`}`;
        $('roomUtilitiesDie').innerHTML = dieArt(item);
        $('roomUtilitiesDie').classList.toggle('is-coin', item.kind === 'coin');
        $('roomUtilitiesResult').textContent = '…';
        $('roomUtilitiesKind').textContent = item.kind === 'coin' ? 'A moeda está no ar' : 'Rolando…';
        $('roomUtilitiesAnnouncement').textContent = '';
        viewer.hidden = false;
        void viewer.offsetWidth;
        viewer.classList.add('is-rolling');
        state.timer = setTimeout(
            () => {
                viewer.classList.remove('is-rolling');
                viewer.classList.add('is-revealed');
                $('roomUtilitiesResult').textContent = result(item);
                $('roomUtilitiesKind').textContent = kinds[item.kind].label;
                $('roomUtilitiesAnnouncement').textContent =
                    `${item.peerName}: ${kinds[item.kind].label}, ${result(item)}.`;
                state.timer = setTimeout(next, state.queue.length ? 1600 : 3500);
            },
            reducedMotion() ? 0 : 1450
        );
    }

    function sync() {
        if (!state.socket?.connected) return;
        const generation = state.generation;
        clearTimeout(state.historyTimer);
        state.historyTimer = setTimeout(() => {
            if (generation !== state.generation) return;
            state.online = false;
            status.textContent = 'Não foi possível carregar. Feche e reabra as utilidades para tentar de novo.';
            updateButtons();
        }, 6000);
        state.socket.emit('utilityHistory', {}, (data) => {
            if (generation !== state.generation) return;
            clearTimeout(state.historyTimer);
            if (!data || data.error || !session(data.session) || !Array.isArray(data.rolls)) {
                status.textContent = data?.error || 'Não foi possível carregar o histórico.';
                state.online = false;
                updateButtons();
                return;
            }
            // Merge events received while the history request was in flight, without replaying old animations.
            data.rolls.forEach(remember);
            state.online = true;
            status.textContent = '';
            updateButtons();
        });
    }

    function roll(kind) {
        if (state.busy || !state.online || !state.socket?.connected) return;
        state.busy = true;
        updateButtons();
        status.textContent = 'Enviando…';
        const generation = state.generation;
        let settled = false;
        const finish = (data) => {
            if (generation !== state.generation || settled) return;
            settled = true;
            clearTimeout(state.ackTimer);
            status.textContent = data?.error || '';
            if (data?.roll) receive(data);
            clearTimeout(state.busyTimer);
            state.busyTimer = setTimeout(() => {
                state.busy = false;
                updateButtons();
            }, 1200);
        };
        const requestId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        state.ackTimer = setTimeout(
            () => finish({ error: 'Sem resposta. Consulte o histórico antes de tentar novamente.' }),
            6000
        );
        state.socket.emit('utilityRoll', { kind, requestId }, finish);
    }

    function disconnected() {
        if (!root) return;
        state.generation++;
        state.online = false;
        state.busy = false;
        clearTimeout(state.ackTimer);
        clearTimeout(state.busyTimer);
        clearTimeout(state.historyTimer);
        clearTimeout(state.timer);
        state.queue.length = 0;
        state.active = null;
        viewer.hidden = true;
        status.textContent = 'Sem conexão com a sala.';
        updateButtons();
    }

    function connect(socket) {
        mount();
        if (!root || !socket) return;
        if (state.socket !== socket) {
            if (state.socket) {
                state.socket.off('utilityRolled', receive);
                state.socket.off('disconnect', disconnected);
            }
            state.socket = socket;
            socket.on('utilityRolled', receive);
            socket.on('disconnect', disconnected);
        }
        state.generation++;
        state.busy = false;
        clearTimeout(state.ackTimer);
        clearTimeout(state.busyTimer);
        sync();
    }

    return { connect, disconnect: disconnected };
})();
