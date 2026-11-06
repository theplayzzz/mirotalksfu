/* Independent room hub. Media and call membership always stay owned by RoomClient. */
window.RoomCaptcha = (() => {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const node = (tag, text, cls) => {
        const e = document.createElement(tag);
        if (text) e.textContent = text;
        if (cls) e.className = cls;
        return e;
    };
    const names = { games: 'Jogos', ranking: 'Ranking', vote: 'Boiolômetro', dice: 'Dados' };
    let socket,
        hub,
        frame,
        assignment,
        nonce,
        view = 'games',
        visible = false,
        minimized = false,
        maximized = false;
    let data,
        epoch = 0,
        poll,
        layoutTimer,
        syncTimer,
        loadTimer,
        observer,
        unsubscribe,
        fetching = false,
        resync = false,
        autoBegin = false;
    let scene,
        scenePromise,
        batch = [],
        batchTimer,
        revealTimer,
        sceneGeneration = 0,
        diceMounted = false,
        rankingGame,
        catalogKey,
        usersKey,
        lastRankingKey;
    const handlers = [],
        closedIds = new Set(),
        soundedVotes = new Set();
    let sound = true,
        volume = 0.18,
        audio;
    try {
        sound = localStorage.getItem('roomPlaySound') !== 'off';
        volume = Number(localStorage.getItem('roomPlayVolume') || 0.18);
    } catch {
        /* Local preferences are optional. */
    }
    function listen(event, fn) {
        socket.on(event, fn);
        handlers.push([event, fn]);
    }
    function tell(text) {
        if ($('rpStatus')) $('rpStatus').textContent = text || '';
    }
    function request(event, payload = {}, mutation = false) {
        const g = epoch;
        return new Promise((resolve, reject) => {
            if (!socket?.connected) return reject(new Error('A conexão com a sala está sendo restabelecida.'));
            const timeout = setTimeout(() => reject(new Error('Sem confirmação do servidor. Tente novamente.')), 8000);
            socket.emit(event, { ...payload, ...(mutation ? { requestId: crypto.randomUUID() } : {}) }, (reply) => {
                clearTimeout(timeout);
                if (g !== epoch) return resolve(null);
                if (reply?.error) return reject(new Error(reply.error));
                if (reply?.state) apply(reply.state);
                resolve(reply);
            });
        });
    }
    function sync() {
        if (!socket?.connected) return;
        if (fetching) {
            resync = true;
            return;
        }
        fetching = true;
        request('playState')
            .then((value) => {
                if (value) apply(value);
            })
            .catch((error) => tell(error.message))
            .finally(() => {
                fetching = false;
                if (resync) {
                    resync = false;
                    clearTimeout(syncTimer);
                    syncTimer = setTimeout(sync, 100);
                }
            });
    }
    function changed() {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(sync, 80);
    }
    function mount() {
        if (hub) return;
        hub = node('section', '', 'room-play');
        hub.id = 'roomPlayHub';
        hub.hidden = true;
        hub.setAttribute('role', 'dialog');
        hub.setAttribute('aria-label', 'Jogos e utilidades');
        hub.setAttribute('aria-modal', 'false');
        hub.innerHTML = `<header class="rp-header"><span class="rp-brand">◈</span><b>Jogos e utilidades</b><span id="rpSession">Sala conectada</span><div class="rp-window-actions"><button id="rpMinimize" title="Minimizar" aria-label="Minimizar jogos">−</button><button id="rpMaximize" title="Maximizar" aria-label="Maximizar jogos">⛶</button><button id="rpClose" title="Fechar" aria-label="Fechar jogos">×</button></div></header>
        <div class="rp-body"><nav class="rp-nav" aria-label="Seções do painel"><button data-view="games"><span>◈</span><b>Jogos</b></button><button data-view="ranking"><span>♜</span><b>Ranking</b></button><button data-view="vote"><span>◎</span><b>Boiolômetro</b><i id="rpBadge" hidden>1</i></button><button data-view="dice"><span>⚄</span><b>Dados</b></button><label class="rp-sound" title="Som das votações"><input id="rpSound" type="checkbox"> Som de votação</label><input id="rpVolume" class="rp-volume" type="range" min="0" max="0.5" step="0.02" aria-label="Volume da votação"></nav>
        <main class="rp-main"><div id="rpPending" hidden><span id="rpPendingText"></span><button id="rpActivate">Fazer verificação →</button></div>
        <section id="rpGames" class="rp-pane"><div id="rpLibrary"><div class="rp-heading"><div><small>ESCOLHA SUA PRÓXIMA PARTIDA</small><h2>Um intervalo para jogar.</h2></div><button id="rpResume" hidden>Retomar partida →</button></div><p class="rp-muted">Só o mouse. Sua melhor marca vai para o ranking da sala.</p><div id="rpCatalog" class="rp-catalog"></div></div><div id="rpStage" hidden><div class="rp-stage-tools"><button id="rpBack">‹ Jogos</button><span id="rpGameName"></span><button id="rpPause" aria-label="Pausar ou continuar partida" title="Pausar ou continuar">Ⅱ</button></div><div id="rpFrameHost"></div></div></section>
        <section id="rpRanking" class="rp-pane" hidden><div class="rp-heading"><div><small>RECORDES DA SALA</small><h2>Ranking</h2></div><select id="rpRankGame" aria-label="Jogo do ranking"></select></div><form id="rpProfile"><label>Sua sigla <input id="rpInitials" maxlength="3" pattern="[A-Za-z0-9]{1,3}" required autocomplete="off" aria-label="Sua sigla no ranking"></label><button>Salvar</button><span id="rpProfileStatus"></span></form><p id="rpRankRules" class="rp-muted"></p><div id="rpRankRows"></div></section>
        <section id="rpVote" class="rp-pane" hidden><div class="rp-heading"><div><small>QUEM PASSA PELA ANÁLISE?</small><h2>Boiolômetro</h2></div><select id="rpVoteGame" aria-label="Jogo da proposta"><option value="random">Jogo aleatório</option></select></div><p class="rp-muted">Propor já conta como seu voto Sim. Mais de 30% das pessoas online na abertura aprovam. Uma votação por vez; as demais aguardam na fila.</p><div id="rpQueue"></div><div id="rpUsers" class="rp-users"></div></section>
        <section id="rpDice" class="rp-pane" hidden><div class="rp-heading"><div><small>A SORTE É COMPARTILHADA</small><h2>Dados e moeda</h2></div><span class="rp-muted">Histórico da sala</span></div><div class="rp-roll-actions"><button data-roll="d6">⚄ <b>d6</b></button><button data-roll="d10">◇ <b>d10</b></button><button data-roll="d20">⬡ <b>d20</b></button><button data-roll="coin">◉ <b>Cara ou coroa</b></button></div><div id="rpDiceMount"></div><ol id="rpHistory" aria-label="Histórico compartilhado de rolagens"></ol></section>
        <p id="rpStatus" role="status" aria-live="polite"></p></main></div>`;
        document.body.append(hub);
        const dock = node('div', '', 'rp-dock');
        dock.id = 'roomPlayDock';
        dock.hidden = true;
        dock.append(
            Object.assign(node('button', '◈'), {
                id: 'rpRestore',
                title: 'Restaurar jogos',
                ariaLabel: 'Restaurar jogos',
            }),
            Object.assign(node('button', '×'), { id: 'rpDockClose', title: 'Fechar jogos', ariaLabel: 'Fechar jogos' })
        );
        document.body.append(dock);
        const vote = node('aside', '', 'rp-ballot');
        vote.id = 'roomPlayBallot';
        vote.hidden = true;
        vote.setAttribute('aria-label', 'Votação da sala');
        document.body.append(vote);
        const dice = node('aside', '', 'rp-dice-viewer');
        dice.id = 'roomPlayDiceViewer';
        dice.hidden = true;
        dice.innerHTML =
            '<div class="rp-dice-top"><span id="rpDiceWho">Mesa de dados</span><button id="rpDiceDismiss" aria-label="Fechar animação">×</button></div><div id="rpDiceScene"></div><p id="rpDiceResult" role="status" aria-live="polite">Role um dado para começar.</p>';
        document.body.append(dice);
        $('rpMinimize').onclick = () => hide(true);
        $('rpClose').onclick = close;
        $('rpDockClose').onclick = close;
        $('rpRestore').onclick = () => show(view);
        $('rpMaximize').onclick = () => {
            maximized = !maximized;
            hub.classList.toggle('is-max', maximized);
            $('rpMaximize').setAttribute('aria-label', maximized ? 'Restaurar tamanho' : 'Maximizar jogos');
            layout();
        };
        hub.querySelectorAll('[data-view]').forEach((button) => {
            button.setAttribute('aria-label', names[button.dataset.view]);
            button.title = names[button.dataset.view];
            button.onclick = () => show(button.dataset.view);
        });
        $('rpBack').onclick = () => library(true);
        $('rpResume').onclick = () => openGame(false);
        $('rpPause').onclick = () => post('captcha:toggle-pause');
        $('rpActivate').onclick = () => openVerification();
        $('rpRankGame').onchange = () => {
            rankingGame = $('rpRankGame').value;
            loadRanking();
        };
        $('rpProfile').onsubmit = (event) => {
            event.preventDefault();
            request('playProfile', { initials: $('rpInitials').value.toUpperCase() }, true)
                .then((reply) => {
                    if (reply) {
                        $('rpProfileStatus').textContent = 'Sigla salva.';
                        loadRanking();
                        post('play:profile', { initials: reply.profile.initials });
                    }
                })
                .catch((error) => tell(error.message));
        };
        hub.querySelectorAll('[data-roll]').forEach(
            (button) =>
                (button.onclick = () => {
                    unlockAudio();
                    window.RoomUtilities.roll(button.dataset.roll).catch((error) => tell(error.message));
                })
        );
        $('rpSound').checked = sound;
        $('rpVolume').value = volume;
        $('rpSound').onchange = () => {
            sound = $('rpSound').checked;
            unlockAudio();
            try {
                localStorage.setItem('roomPlaySound', sound ? 'on' : 'off');
            } catch {}
        };
        $('rpVolume').oninput = () => {
            volume = Number($('rpVolume').value);
            try {
                localStorage.setItem('roomPlayVolume', volume);
            } catch {}
        };
        $('rpDiceDismiss').onclick = () => {
            $('roomPlayDiceViewer').hidden = true;
            scene?.stop();
        };
        const trigger = $('roomUtilitiesButton');
        if (trigger) {
            trigger.hidden = false;
            trigger.classList.remove('hidden');
            trigger.title = 'Jogos e utilidades';
            trigger.setAttribute('aria-label', 'Jogos e utilidades');
            trigger.innerHTML = '<i class="fas fa-gamepad" aria-hidden="true"></i>';
            trigger.onclick = () => (visible ? hide(true) : show(view));
        }
        observer = new MutationObserver(() => {
            clearTimeout(layoutTimer);
            layoutTimer = setTimeout(tiles, 60);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', layout);
        window.addEventListener('message', bridge);
        unsubscribe = window.RoomUtilities?.subscribe(diceUpdate);
        layout();
    }
    function layout() {
        const bar = $('bottomButtons')?.getBoundingClientRect();
        const safe = bar && bar.top > innerHeight * 0.45 && bar.height ? Math.max(76, innerHeight - bar.top + 14) : 90;
        document.documentElement.style.setProperty('--rp-safe-bottom', `${safe}px`);
        tiles();
    }
    function paused(value) {
        if (frame) post(value ? 'captcha:minimize' : 'captcha:expand');
    }
    function show(next = view) {
        mount();
        unlockAudio();
        visible = true;
        minimized = false;
        hub.hidden = false;
        $('roomPlayDock').hidden = true;
        view = next;
        hub.querySelectorAll('[data-view]').forEach((b) => {
            b.classList.toggle('is-active', b.dataset.view === view);
            b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
        });
        for (const [key, id] of Object.entries({
            games: 'rpGames',
            ranking: 'rpRanking',
            vote: 'rpVote',
            dice: 'rpDice',
        }))
            $(id).hidden = key !== view;
        if (view !== 'games') paused(true);
        else if (frame && !$('rpStage').hidden) paused(false);
        if (view === 'ranking') loadRanking();
        if (view === 'dice') moveDice(true);
        else moveDice(false);
        if (view === 'games' && frame) {
            $('roomPlayDiceViewer').hidden = true;
            scene?.stop();
        }
        renderBallot();
        $('roomUtilitiesButton')?.setAttribute('aria-expanded', 'true');
        tell('');
        layout();
    }
    function hide(minimize) {
        if (!hub) return;
        visible = false;
        minimized = !!minimize;
        hub.hidden = true;
        $('roomPlayDock').hidden = !minimize;
        paused(true);
        moveDice(false);
        renderBallot();
        tiles();
        $('roomUtilitiesButton')?.setAttribute('aria-expanded', 'false');
    }
    async function close() {
        if (!hub) return;
        for (const a of [data?.active, data?.pending]) if (a) closedIds.add(a.id);
        while (closedIds.size > 50) closedIds.delete(closedIds.values().next().value);
        epoch++;
        fetching = false;
        resync = false;
        if (data) {
            data.active = null;
            data.pending = null;
        }
        dropFrame();
        hide(false);
        tiles();
        render();
        try {
            await request('playClose', {}, true);
        } catch (error) {
            tell(error.message);
            sync();
        }
    }
    function dropFrame() {
        clearTimeout(loadTimer);
        frame?.remove();
        frame = null;
        assignment = null;
        nonce = null;
        autoBegin = false;
        if ($('rpStage')) library(false);
    }
    function library(pause = true) {
        if (!hub) return;
        if (pause) paused(true);
        $('rpLibrary').hidden = false;
        $('rpStage').hidden = true;
        $('rpResume').hidden = !frame;
    }
    function post(type, extra = {}) {
        if (frame?.contentWindow)
            frame.contentWindow.postMessage({ type, nonce, assignmentId: assignment?.id, ...extra }, location.origin);
    }
    function openGame(begin = true) {
        const a = data?.active;
        if (!a) return;
        show('games');
        $('rpLibrary').hidden = true;
        $('rpStage').hidden = false;
        $('rpGameName').textContent = a.config.title;
        if (frame && assignment?.id === a.id) {
            paused(false);
            return;
        }
        dropFrame();
        $('rpLibrary').hidden = true;
        $('rpStage').hidden = false;
        assignment = a;
        nonce = crypto.randomUUID();
        autoBegin = begin && a.phase === 'assigned';
        frame = node('iframe');
        frame.title = a.config.title;
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
        frame.setAttribute('allow', "camera 'none'; microphone 'none'; display-capture 'none'");
        frame.src = '/captcha/play/room.html';
        frame.onload = () => post('captcha:init', { assignment: a, profile: data.profile });
        $('rpFrameHost').append(frame);
        $('roomPlayDiceViewer').hidden = true;
        scene?.stop();
        render();
        loadTimer = setTimeout(() => {
            if (frame) {
                tell('O jogo não carregou. Feche a janela para continuar.');
                document.body.classList.remove('room-captcha-blur');
            }
        }, 18000);
    }
    async function openVerification() {
        try {
            if (data?.pending) {
                const reply = await request('playActivate', {}, true);
                if (!reply) return;
            }
            if (data?.active?.source !== 'manual') openGame(true);
        } catch (error) {
            tell(error.message);
        }
    }
    function apply(value) {
        if (value?.enabled === false) {
            mount();
            dropFrame();
            data = null;
            document.body.classList.remove('room-captcha-blur');
            hub.querySelectorAll('[data-view]').forEach((button) => (button.disabled = button.dataset.view !== 'dice'));
            view = 'dice';
            return;
        }
        if (!value || !value.enabled || (data && value.version < data.version)) return;
        for (const key of ['active', 'pending']) if (value[key] && closedIds.has(value[key].id)) value[key] = null;
        if (frame && value.active?.id !== assignment?.id) dropFrame();
        data = value;
        mount();
        render();
        tiles();
    }
    function render() {
        if (!data || !hub) return;
        const a = data.active,
            p = data.pending,
            waiting = p?.phase === 'waiting';
        $('rpSession').textContent = !socket?.connected
            ? 'Reconectando…'
            : a
              ? a.phase === 'result'
                  ? 'Resultado salvo'
                  : a.source === 'manual'
                    ? 'Partida livre'
                    : 'Verificação'
              : p
                ? 'Verificação disponível'
                : 'Sala conectada';
        $('rpBadge').hidden = !p && !(a && a.source !== 'manual' && a.phase !== 'result');
        const available = a && a.source !== 'manual' && a.phase === 'assigned' && !frame;
        $('rpPending').hidden = !p && !available;
        $('rpPendingText').textContent = waiting
            ? 'Uma verificação aguarda sua partida.'
            : available
              ? 'Há uma verificação disponível.'
              : 'Sua partida foi registrada. Há uma verificação disponível.';
        $('rpActivate').disabled = waiting;
        $('rpResume').hidden = !frame;
        if (frame && a?.phase === 'result') post('play:pending', { pending: !!p });
        const key = JSON.stringify(data.catalog);
        if (key !== catalogKey) {
            catalogKey = key;
            $('rpCatalog').replaceChildren();
            $('rpRankGame').replaceChildren();
            $('rpVoteGame').replaceChildren(new Option('Jogo aleatório', 'random'));
            const icons = ['↗', '☂', '◎', '◔', '⚒', '⇅', '✎', '↗', '╱', '⌁', 'ϟ', '↔', '⇡', '⌇'];
            for (const [i, g] of data.catalog.entries()) {
                if (!g.config) continue;
                const button = node('button', '', 'rp-game-card');
                button.type = 'button';
                button.dataset.game = g.id;
                button.append(
                    node('span', icons[i % icons.length], 'rp-game-icon'),
                    node('b', g.title),
                    node('small', `${g.config.duration}s · só mouse`)
                );
                button.onclick = async () => {
                    if (!data || !socket?.connected) {
                        tell('A conexão com a sala está sendo restabelecida.');
                        return;
                    }
                    if (data.active && data.active.phase !== 'result') {
                        if (frame) openGame(false);
                        else tell('Sua partida está aberta em outra janela.');
                        return;
                    }
                    if (data.pending) {
                        tell('Há uma verificação disponível.');
                        return;
                    }
                    button.disabled = true;
                    try {
                        const reply = await request('playManualStart', { gameId: g.id }, true);
                        if (reply) openGame(true);
                    } catch (error) {
                        tell(error.message);
                    } finally {
                        button.disabled = false;
                    }
                };
                $('rpCatalog').append(button);
                $('rpRankGame').append(new Option(g.title, g.id));
                $('rpVoteGame').append(new Option(g.title, g.id));
            }
            if (rankingGame && [...$('rpRankGame').options].some((o) => o.value === rankingGame))
                $('rpRankGame').value = rankingGame;
        }
        if (document.activeElement !== $('rpInitials')) $('rpInitials').value = data.profile.initials;
        const uk = JSON.stringify([data.users, data.votes, data.participantVotes]);
        if (uk !== usersKey) {
            usersKey = uk;
            renderUsers();
            renderQueue();
        }
        renderBallot();
        const rankKey = `${data.version}:${rankingGame}`;
        if (visible && view === 'ranking' && rankKey !== lastRankingKey) {
            lastRankingKey = rankKey;
            loadRanking();
        }
    }
    function renderUsers() {
        $('rpUsers').replaceChildren();
        for (const user of data.users) {
            const row = node('div', '', 'rp-user');
            const avatar = node('span', user.name.slice(0, 2).toUpperCase(), 'rp-avatar');
            const copy = node('div');
            copy.append(
                node('b', user.name + (user.mine ? ' · você' : '')),
                node(
                    'small',
                    user.canChallenge
                        ? 'Online'
                        : user.ready
                          ? 'Em partida ou intervalo de proteção'
                          : 'Atualize a página para participar'
                )
            );
            const button = node('button', 'Propor e votar Sim');
            button.disabled = !data.participantVotes || !user.canChallenge;
            button.onclick = async () => {
                button.disabled = true;
                unlockAudio();
                try {
                    await request('playPropose', { peerId: user.id, gameId: $('rpVoteGame').value }, true);
                    tell('Proposta registrada.');
                } catch (error) {
                    tell(error.message);
                } finally {
                    changed();
                }
            };
            row.append(avatar, copy, button);
            $('rpUsers').append(row);
        }
        if (!data.participantVotes)
            $('rpUsers').prepend(node('p', 'Propostas estão desativadas pelo líder.', 'rp-muted'));
    }
    function renderQueue() {
        $('rpQueue').replaceChildren();
        for (const v of data.votes) {
            const item = node(
                'p',
                v.status === 'queued'
                    ? `Na fila ${v.queuePosition}: ${v.name}`
                    : `Em votação: ${v.name} · ${v.yes}/${v.threshold} votos Sim`,
                'rp-queue-item'
            );
            $('rpQueue').append(item);
        }
    }
    function renderBallot() {
        if (!hub) return;
        const box = $('roomPlayBallot'),
            v = data?.votes.find((v) => v.status === 'open');
        const target = visible ? hub.querySelector('.rp-main') : document.body;
        if (box.parentElement !== target) target.prepend(box);
        box.hidden = !v;
        if (!v) return;
        if (box.dataset.vote !== `${v.id}:${v.choice}:${v.eligible}:${v.yes}`) {
            box.dataset.vote = `${v.id}:${v.choice}:${v.eligible}:${v.yes}`;
            box.replaceChildren(node('small', 'VOTAÇÃO DA SALA'), node('b', `${v.name} deve passar pelo Boiolômetro?`));
            const info = node('span');
            info.id = 'rpVoteInfo';
            box.append(info);
            const actions = node('div', '', 'rp-ballot-actions');
            for (const [choice, label] of [
                ['yes', 'Sim'],
                ['no', 'Agora não'],
            ]) {
                const b = node('button', label);
                b.disabled = !!v.choice || !v.eligible;
                b.onclick = () =>
                    request('captchaVoteCast', { voteId: v.id, choice })
                        .then(changed)
                        .catch((e) => tell(e.message));
                actions.append(b);
            }
            box.append(
                actions,
                node(
                    'small',
                    v.choice
                        ? `Você votou ${v.choice === 'yes' ? 'Sim' : 'Agora não'}.`
                        : v.eligible
                          ? 'Mais de 30% aprovam.'
                          : 'Você poderá participar da próxima votação.'
                )
            );
        }
        $('rpVoteInfo').textContent =
            `${v.yes}/${v.threshold} votos Sim · ${Math.max(0, Math.ceil((v.expiresAt - Date.now()) / 1000))}s`;
    }
    async function loadRanking() {
        if (!data || !visible || view !== 'ranking') return;
        const id = $('rpRankGame').value;
        if (!id) return;
        rankingGame = id;
        try {
            const reply = await request('playRanking', { gameId: id });
            if (!reply || $('rpRankGame').value !== id) return;
            $('rpRankRules').textContent =
                `Melhor marca por pessoa · ${reply.config.duration}s · intensidade ${reply.config.intensity.toFixed(2)}. Partidas livres e verificações compartilham este ranking.`;
            $('rpRankRows').replaceChildren();
            if (!reply.rows.length) {
                $('rpRankRows').append(node('p', 'Ainda sem marcas. A primeira pode ser sua.', 'rp-empty'));
                return;
            }
            const table = node('table');
            table.innerHTML = '<thead><tr><th>Posição</th><th>Jogador</th><th>Marca</th></tr></thead>';
            const body = node('tbody');
            for (const r of reply.rows) {
                const row = node('tr');
                if (r.mine) row.className = 'is-mine';
                row.append(
                    node('td', String(r.rank).padStart(2, '0')),
                    node('td', r.initials + (r.mine ? ' · você' : '')),
                    node('td', r.label)
                );
                body.append(row);
            }
            table.append(body);
            $('rpRankRows').append(table);
            if (reply.mine && !reply.rows.some((r) => r.mine))
                $('rpRankRows').append(node('p', `Sua posição: ${reply.mine.rank} · ${reply.mine.label}`, 'rp-muted'));
        } catch (error) {
            tell(error.message);
        }
    }
    function needsBlur() {
        return (
            socket?.connected &&
            (data?.pending?.phase === 'assigned' ||
                (data?.active && data.active.source !== 'manual' && data.active.phase !== 'result'))
        );
    }
    function tiles() {
        const blur = !!needsBlur();
        document.body.classList.toggle('room-captcha-blur', blur);
        const wanted = new Set();
        if (blur)
            for (const tile of document.querySelectorAll('.Camera')) {
                if (!tile.querySelector('video,.videoAvatarImage')) continue;
                wanted.add(tile);
                let button = tile.querySelector(':scope > .rp-captcha-prompt');
                if (!button) {
                    button = node('button', '', 'rp-captcha-prompt');
                    button.type = 'button';
                    button.append(node('b', 'CAPTCHA do Boiolômetro'), node('small', 'Iniciar verificação →'));
                    button.onclick = (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openVerification();
                    };
                    tile.append(button);
                }
                button.hidden = visible;
            }
        document.querySelectorAll('.rp-captcha-prompt').forEach((button) => {
            if (!wanted.has(button.parentElement)) button.remove();
        });
        const trigger = $('roomUtilitiesButton');
        if (trigger) trigger.classList.toggle('rp-has-captcha', blur);
    }
    async function bridge(event) {
        const m = event.data;
        if (
            event.origin !== location.origin ||
            event.source !== frame?.contentWindow ||
            !m ||
            m.nonce !== nonce ||
            m.assignmentId !== assignment?.id
        )
            return;
        const id = assignment.id;
        try {
            if (m.type === 'captcha:ready') {
                clearTimeout(loadTimer);
                if (autoBegin) {
                    autoBegin = false;
                    post('captcha:begin');
                }
            } else if (m.type === 'captcha:start') {
                if (data.active?.phase === 'result') {
                    const gameId = data.active.config.id;
                    const reply = await request('playManualStart', { gameId }, true);
                    if (reply) openGame(true);
                    return;
                }
                const reply = await request('captchaAttemptStart', { assignmentId: id });
                if (reply && assignment?.id === id) {
                    post('captcha:attempt', { ...reply });
                    changed();
                }
            } else if (m.type === 'captcha:finished') {
                const reply = await request('captchaAttemptFinish', {
                    assignmentId: id,
                    attemptId: m.attemptId,
                    reason: m.reason,
                    elapsed: m.elapsed,
                    metrics: m.metrics,
                });
                if (reply && assignment?.id === id)
                    post('play:recorded', {
                        score: reply.attempt.score,
                        initials: data.profile.initials,
                        pending: !!data.pending,
                    });
                sync();
            } else if (m.type === 'captcha:rating') {
                await request('captchaRate', { assignmentId: id, attemptId: m.attemptId, value: m.value });
                if (assignment?.id === id) post('captcha:rated');
            } else if (m.type === 'captcha:release') await close();
            else if (m.type === 'play:ranking') {
                show('ranking');
                $('rpRankGame').value = assignment.config.id;
                loadRanking();
            } else if (m.type === 'play:activate') await openVerification();
            else if (m.type === 'play:profile') {
                const reply = await request('playProfile', { initials: m.initials }, true);
                if (reply) post('play:profile', { initials: reply.profile.initials });
            } else if (m.type === 'play:phase') {
                if (['playing', 'countdown', 'paused'].includes(m.phase))
                    await request('playPause', { assignmentId: id, paused: m.phase === 'paused' }, true);
            } else if (m.type === 'captcha:load-error') {
                tell('O jogo não carregou. Feche a janela para continuar.');
                await close();
            }
        } catch (error) {
            if (assignment?.id === id) post('captcha:error', { error: error.message });
            tell(error.message);
            changed();
        }
    }
    function unlockAudio() {
        try {
            audio ||= new (window.AudioContext || window.webkitAudioContext)();
            if (audio.state === 'suspended') audio.resume().catch(() => {});
        } catch {}
    }
    function chime() {
        if (!sound || !volume) return;
        unlockAudio();
        if (!audio || audio.state !== 'running') return;
        const start = audio.currentTime;
        [660, 880].forEach((hz, i) => {
            const o = audio.createOscillator(),
                g = audio.createGain();
            o.frequency.value = hz;
            g.gain.setValueAtTime(0, start + i * 0.11);
            g.gain.linearRampToValueAtTime(Math.min(0.5, volume) * 0.22, start + i * 0.11 + 0.01);
            g.gain.exponentialRampToValueAtTime(0.001, start + i * 0.11 + 0.11);
            o.connect(g).connect(audio.destination);
            o.start(start + i * 0.11);
            o.stop(start + i * 0.11 + 0.12);
        });
    }
    function moveDice(inside) {
        if (!hub) return;
        const viewer = $('roomPlayDiceViewer');
        if (inside) {
            $('rpDiceMount').append(viewer);
            viewer.hidden = false;
            diceMounted = true;
        } else if (diceMounted) {
            document.body.append(viewer);
            viewer.hidden = true;
            diceMounted = false;
        }
    }
    function diceUpdate(state, incoming = []) {
        if (!hub) return;
        const list = $('rpHistory');
        list.replaceChildren();
        for (const r of state.rolls) {
            const li = node('li');
            const settled = r.revealAt <= state.now;
            li.append(
                node('span', r.peerName),
                node('small', r.kind === 'coin' ? 'Moeda' : r.kind),
                node('b', settled ? window.RoomUtilities.result(r) : 'Rolando…')
            );
            li.dataset.rollId = r.id;
            list.append(li);
        }
        if (!state.rolls.length) list.append(node('li', 'Ninguém rolou ainda.', 'rp-empty'));
        hub.querySelectorAll('[data-roll]').forEach((button) => (button.disabled = !state.online || state.busy));
        if (incoming.length) {
            batch.push(...incoming);
            clearTimeout(batchTimer);
            batchTimer = setTimeout(animateDice, 90);
        }
    }
    async function animateDice() {
        const rolls = batch
            .splice(0)
            .sort((a, b) => a.sequence - b.sequence)
            .slice(0, 4);
        if (!rolls.length || !hub) return;
        if (
            (visible && view === 'games' && frame && !$('rpStage').hidden) ||
            (scenePromise && !scene) ||
            $('roomPlayDiceViewer').dataset.rolling === 'true'
        )
            return;
        const viewer = $('roomPlayDiceViewer');
        viewer.hidden = false;
        viewer.dataset.rolling = 'true';
        $('rpDiceWho').textContent =
            rolls.length === 1
                ? `${rolls[0].peerName} · ${rolls[0].kind === 'coin' ? 'moeda' : rolls[0].kind}`
                : `${rolls.length} rolagens da sala`;
        $('rpDiceResult').textContent = 'Rolando…';
        const g = ++sceneGeneration;
        clearTimeout(revealTimer);
        revealTimer = setTimeout(
            () => {
                if (g !== sceneGeneration) return;
                viewer.dataset.rolling = 'false';
                $('rpDiceResult').textContent = rolls
                    .map((r) => `${r.peerName}: ${window.RoomUtilities.result(r)}`)
                    .join(' · ');
            },
            Math.max(0, Math.max(...rolls.map((r) => r.revealAt)) - window.RoomUtilities.now())
        );
        try {
            if (!scenePromise)
                scenePromise = import('/captcha/play/dice.js').then((m) => m.createDiceScene($('rpDiceScene')));
            const loaded = await scenePromise;
            if (!hub || g !== sceneGeneration) {
                loaded.dispose();
                return;
            }
            scene = loaded;
            await scene.roll(rolls);
        } catch (error) {
            console.warn('3D dice unavailable:', error.message);
            if (g === sceneGeneration && $('rpDiceWho'))
                $('rpDiceWho').textContent = 'Resultado da sala · modo simples';
        }
    }
    async function connect(value) {
        if (socket === value) {
            sync();
            return;
        }
        disconnect();
        socket = value;
        mount();
        listen('playChanged', changed);
        listen('captchaAssigned', changed);
        listen('captchaReleased', changed);
        listen('captchaVote', (v) => {
            if (v.status === 'open' && v.announce && !soundedVotes.has(v.id)) {
                soundedVotes.add(v.id);
                chime();
            }
            changed();
        });
        listen('disconnect', () => {
            epoch++;
            fetching = false;
            resync = false;
            dropFrame();
            data = null;
            document.body.classList.remove('room-captcha-blur');
            $('rpSession').textContent = 'Reconectando…';
            renderBallot();
            tiles();
        });
        listen('connect', () =>
            request('playHello')
                .then(apply)
                .catch((e) => tell(e.message))
        );
        try {
            apply(await request('playHello'));
        } catch (error) {
            tell(error.message);
        }
        poll = setInterval(() => {
            sync();
            renderBallot();
            layout();
        }, 2500);
    }
    function disconnect() {
        epoch++;
        for (const [event, fn] of handlers.splice(0)) socket?.off(event, fn);
        clearInterval(poll);
        clearTimeout(layoutTimer);
        clearTimeout(syncTimer);
        clearTimeout(loadTimer);
        clearTimeout(batchTimer);
        clearTimeout(revealTimer);
        unsubscribe?.();
        observer?.disconnect();
        window.removeEventListener('resize', layout);
        window.removeEventListener('message', bridge);
        dropFrame();
        sceneGeneration++;
        scene?.dispose();
        scene = null;
        scenePromise = null;
        batch = [];
        for (const id of ['roomPlayHub', 'roomPlayDock', 'roomPlayBallot', 'roomPlayDiceViewer']) $(id)?.remove();
        document.querySelectorAll('.rp-captcha-prompt').forEach((e) => e.remove());
        document.body.classList.remove('room-captcha-blur');
        hub = null;
        data = null;
        socket = null;
        catalogKey = null;
        usersKey = null;
        lastRankingKey = null;
        visible = false;
        minimized = false;
        maximized = false;
        diceMounted = false;
        fetching = false;
        resync = false;
        closedIds.clear();
        soundedVotes.clear();
    }
    return { connect, disconnect };
})();
