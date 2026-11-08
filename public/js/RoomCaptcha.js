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
    let challenge,
        ballot,
        dock,
        barObserver,
        lastOpener,
        starting = false,
        proposing = false;
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
        activeDice = [],
        batchTimer,
        revealTimer,
        diceDeadline,
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
        hub = node('section', '', 'room-play notranslate');
        hub.setAttribute('translate', 'no');
        hub.id = 'roomPlayHub';
        hub.hidden = true;
        hub.setAttribute('role', 'dialog');
        hub.setAttribute('aria-label', 'Jogos e utilidades');
        hub.setAttribute('aria-modal', 'false');
        hub.innerHTML = `<header class="rp-header"><span class="rp-brand">◈</span><b>Jogos e utilidades</b><button id="rpContinue" hidden>Continuar partida →</button><span id="rpSession">Sala conectada</span><div class="rp-window-actions"><button id="rpMinimize" title="Minimizar" aria-label="Minimizar jogos">−</button><button id="rpMaximize" title="Maximizar" aria-label="Maximizar jogos">⛶</button><button id="rpClose" title="Fechar" aria-label="Fechar jogos">×</button></div></header>
        <div class="rp-body"><nav class="rp-nav" aria-label="Seções do painel"><button data-view="games"><span>◈</span><b>Jogos</b></button><button data-view="ranking"><span>♜</span><b>Ranking</b></button><button data-view="vote"><span>◎</span><b>Boiolômetro</b><i id="rpBadge" hidden>1</i></button><button data-view="dice"><span>⚄</span><b>Dados</b></button><details class="rp-preferences"><summary aria-label="Preferências de som" title="Preferências de som">⚙ <span>Som</span></summary><label class="rp-sound"><input id="rpSound" type="checkbox"> Som de votação</label><input id="rpVolume" class="rp-volume" type="range" min="0" max="0.5" step="0.02" aria-label="Volume da votação"></details></nav>
        <main class="rp-main"><div id="rpPending" hidden><span id="rpPendingText"></span><button id="rpActivate">Fazer verificação →</button></div>
        <section id="rpGames" class="rp-pane"><div id="rpLibrary"><div class="rp-heading"><div><h2>Escolha um jogo.</h2></div><button id="rpResume" hidden>Retomar partida →</button></div><p class="rp-muted">Jogue com o mouse. Sua melhor marca fica no ranking.</p><div id="rpCatalog" class="rp-catalog"></div></div><div id="rpStage" hidden><div class="rp-stage-tools"><button id="rpBack">‹ Jogos</button><span id="rpGameName"></span><button id="rpPause" aria-label="Pausar ou continuar partida" title="Pausar ou continuar">Ⅱ</button></div><div id="rpFrameHost"></div></div></section>
        <section id="rpRanking" class="rp-pane" hidden><div class="rp-heading"><div><small>RECORDES DA SALA</small><h2>Ranking</h2></div><select id="rpRankGame" aria-label="Jogo do ranking"></select></div><details id="rpProfileDetails"><summary>Sua sigla · <b id="rpProfileLabel">JOG</b></summary><form id="rpProfile"><label>Sua sigla <input id="rpInitials" maxlength="3" minlength="3" pattern="[A-Za-z]{3}" required autocomplete="off" aria-label="Sua sigla no ranking"></label><button>Salvar</button><span id="rpProfileStatus"></span></form></details><p id="rpRankRules" class="rp-muted"></p><div id="rpRankRows"></div><button id="rpRankMore" hidden>Ver ranking completo</button></section>
        <section id="rpVote" class="rp-pane" hidden><div class="rp-heading"><h2>Boiolômetro</h2></div><p class="rp-muted">Quem passa pela análise?</p><label class="rp-target-label" for="rpVoteTarget">Participante</label><select id="rpVoteTarget" aria-label="Participante da votação"></select><button id="rpPropose" class="rp-primary">Propor e votar Sim</button><details class="rp-secondary"><summary>Escolher jogo e ver regras</summary><label>Jogo<select id="rpVoteGame"><option value="random">Jogo aleatório</option></select></label><p class="rp-muted">Mais de 30% da sala na abertura aprovam. Seu voto Sim já conta. Uma votação por vez.</p></details><div id="rpQueue"></div><details class="rp-secondary"><summary>Participantes online</summary><div id="rpUsers" class="rp-users"></div></details></section>
        <section id="rpDice" class="rp-pane" hidden><div class="rp-heading"><h2>Dados e moeda</h2></div><p class="rp-dice-copy">Todo mundo na sala vê as mesmas rolagens.</p><div class="rp-roll-actions"><button data-roll="d6" aria-label="Rolar d6"><span aria-hidden="true">⚄</span><b>d6</b></button><button data-roll="d10" aria-label="Rolar d10"><span aria-hidden="true">◇</span><b>d10</b></button><button data-roll="d20" aria-label="Rolar d20"><span aria-hidden="true">⬡</span><b>d20</b></button><button data-roll="coin" aria-label="Lançar cara ou coroa"><span aria-hidden="true">◉</span><b>Cara ou coroa</b></button></div><p id="rpRollStatus" role="status" aria-live="polite">Escolha um dado ou lance a moeda.</p><div id="rpDiceMount"></div><h3 class="rp-history-title">Histórico da sala</h3><ol id="rpHistory" aria-label="Histórico compartilhado de rolagens"></ol><button id="rpHistoryMore" hidden>Ver histórico completo</button></section>
        <p id="rpStatus" role="status" aria-live="polite"></p></main></div>`;
        document.body.append(hub);
        dock = node('div', '', 'rp-dock');
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
        const vote = (ballot = node('aside', '', 'rp-ballot'));
        vote.id = 'roomPlayBallot';
        vote.hidden = true;
        vote.setAttribute('aria-label', 'Votação da sala');
        document.body.append(vote);
        challenge = node('section', '', 'rp-challenge notranslate');
        challenge.id = 'roomPlayChallenge';
        challenge.hidden = true;
        challenge.setAttribute('translate', 'no');
        challenge.setAttribute('aria-label', 'CAPTCHA do Boiolômetro');
        challenge.innerHTML =
            '<button id="rpChallengeClose" class="rp-challenge-close" aria-label="Fechar verificação" title="Fechar">×</button><span class="rp-challenge-mark" aria-hidden="true">◎</span><h2>CAPTCHA do Boiolômetro</h2><p>Você foi escolhido para a análise.</p><button id="rpChallengeStart" class="rp-primary">Começar</button>';
        document.body.append(challenge);
        $('rpChallengeClose').onclick = close;
        $('rpChallengeStart').onclick = openVerification;
        const dice = node('aside', '', 'rp-dice-viewer');
        dice.id = 'roomPlayDiceViewer';
        dice.hidden = true;
        dice.innerHTML =
            '<div class="rp-dice-top"><span id="rpDiceWho">Mesa de dados</span><button id="rpDiceDismiss" aria-label="Fechar animação">×</button></div><div id="rpDiceScene"></div><p id="rpDiceResult" role="status" aria-live="polite">Role um dado para começar.</p>';
        document.body.append(dice);
        $('rpMinimize').onclick = () => hide(true);
        $('rpClose').onclick = close;
        $('rpDockClose').onclick = close;
        $('rpRestore').onclick = () => (data?.active ? openGame(data.active.phase === 'assigned') : show(view));
        $('rpContinue').onclick = () => openGame(data?.active?.phase === 'assigned');
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
        $('rpResume').onclick = () => openGame(data?.active?.phase === 'assigned');
        $('rpPause').onclick = () => post('captcha:toggle-pause');
        $('rpActivate').onclick = () => openVerification();
        $('rpPropose').onclick = propose;
        $('rpVoteTarget').onchange = proposalButton;
        $('rpRankMore').onclick = () => {
            $('rpRankMore').dataset.expanded = 'true';
            loadRanking();
        };
        $('rpHistoryMore').onclick = () => {
            $('rpHistoryMore').dataset.expanded = 'true';
            diceUpdate(window.RoomUtilities.current());
        };
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
                    if (button.disabled) return;
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
            stopDice();
            $('roomPlayDiceViewer').hidden = true;
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
        document.addEventListener('fullscreenchange', layout);
        document.addEventListener('keydown', escapeWindow);
        barObserver = new ResizeObserver(layout);
        barObserver.observe($('bottomButtons') || document.body);
        unsubscribe = window.RoomUtilities?.subscribe(diceUpdate);
        layout();
    }
    function overlayHost() {
        const fs = document.fullscreenElement;
        return fs &&
            fs !== document.documentElement &&
            fs !== document.body &&
            !['VIDEO', 'IFRAME'].includes(fs.tagName)
            ? fs
            : document.body;
    }
    function layout() {
        const barNode = $('bottomButtons'),
            bar = barNode?.getBoundingClientRect();
        const column =
            bar && bar.width && bar.height
                ? bar.height > bar.width && bar.width < innerWidth * 0.4
                : getComputedStyle(document.documentElement).getPropertyValue('--bottom-btns-flex-direction').trim() ===
                  'column';
        let left = 14,
            right = 14,
            top = 14,
            bottom = 90;
        if (column) {
            bottom = 14;
            if (bar?.width && bar.left > innerWidth / 2) right = Math.max(80, innerWidth - bar.left + 12);
            else left = Math.max(88, (bar?.right || 76) + 12);
        } else if (bar?.width && bar.height && bar.top < innerHeight * 0.3) {
            top = bar.bottom + 12;
            bottom = 14;
        } else if (bar?.height && bar.top > innerHeight * 0.45) bottom = Math.max(76, innerHeight - bar.top + 14);
        for (const [side, value] of Object.entries({ left, right, top, bottom }))
            document.documentElement.style.setProperty('--rp-safe-' + side, value + 'px');
        const host = overlayHost();
        if (challenge && challenge.parentElement !== host) host.append(challenge);
        if (dock && dock.parentElement !== host) host.append(dock);
        renderBallot();
        tiles();
    }
    function escapeWindow(event) {
        if (event.key === 'Escape' && visible && !event.defaultPrevented) {
            event.preventDefault();
            close();
        }
    }
    function paused(value) {
        if (frame) post(value ? 'captcha:minimize' : 'captcha:expand');
    }
    function show(next = view) {
        mount();
        unlockAudio();
        if (!visible) lastOpener = document.activeElement;
        visible = true;
        minimized = false;
        hub.hidden = false;
        document.body.classList.add('room-play-open');
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
        if (view === 'dice') {
            moveDice(true);
            diceUpdate(window.RoomUtilities.current());
        } else moveDice(false);
        if (view === 'games' && frame) {
            stopDice();
            $('roomPlayDiceViewer').hidden = true;
        }
        renderBallot();
        $('roomUtilitiesButton')?.setAttribute('aria-expanded', 'true');
        tell('');
        render();
        layout();
    }
    function hide(minimize) {
        if (!hub) return;
        visible = false;
        minimized = !!minimize;
        hub.hidden = true;
        $('roomPlayDock').hidden = !minimize;
        document.body.classList.remove('room-play-open');
        paused(true);
        moveDice(false);
        renderBallot();
        tiles();
        $('roomUtilitiesButton')?.setAttribute('aria-expanded', 'false');
    }
    async function close(reason = 'closed') {
        if (!hub) return;
        reason = reason === 'load_error' ? reason : 'closed';
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
        lastOpener?.isConnected && lastOpener.focus({ preventScroll: true });
        try {
            await request('playClose', { reason }, true);
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
        $('rpResume').hidden = !data?.active;
    }
    function post(type, extra = {}) {
        if (frame?.contentWindow)
            frame.contentWindow.postMessage({ type, nonce, assignmentId: assignment?.id, ...extra }, location.origin);
    }
    async function openGame(begin = true) {
        const a = data?.active,
            g = epoch;
        if (!a || starting) return;
        const fs = document.fullscreenElement;
        if (fs && fs !== document.documentElement && fs !== document.body) {
            starting = true;
            try {
                await document.exitFullscreen();
            } catch {
                tell('Saia da tela cheia para abrir o jogo.');
                return;
            } finally {
                starting = false;
            }
            if (g !== epoch || data?.active?.id !== a.id) return;
        }
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
        stopDice();
        $('roomPlayDiceViewer').hidden = true;
        render();
        const loadedId = a.id;
        loadTimer = setTimeout(async () => {
            if (frame && assignment?.id === loadedId) {
                const closeEpoch = epoch + 1;
                await close('load_error');
                if (epoch !== closeEpoch || !socket?.connected || visible || data?.active || data?.pending || frame)
                    return;
                show('games');
                tell('O jogo não carregou. A verificação foi encerrada e suas imagens estão liberadas.');
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
        const activeUnfinished = a && a.phase !== 'result';
        const onGame = visible && view === 'games' && frame && !$('rpStage').hidden;
        hub.classList.toggle('is-playing', !!onGame && activeUnfinished);
        $('rpPending').hidden = (!p && !available) || (waiting && onGame);
        $('rpContinue').hidden = !a || onGame;
        $('rpContinue').textContent = a?.source === 'manual' ? 'Continuar partida →' : 'Continuar verificação →';
        $('rpPendingText').textContent = waiting
            ? 'Uma verificação aguarda sua partida.'
            : available
              ? 'Há uma verificação disponível.'
              : 'Sua partida foi registrada. Há uma verificação disponível.';
        $('rpActivate').disabled = waiting;
        $('rpResume').hidden = !a;
        $('rpRestore').textContent = a ? '◈ Continuar' : '◈ Jogos';
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
                button.append(node('span', icons[i % icons.length], 'rp-game-icon'), node('b', g.title));
                button.onclick = async () => {
                    if (!data || !socket?.connected) {
                        tell('A conexão com a sala está sendo restabelecida.');
                        return;
                    }
                    if (data.active && data.active.phase !== 'result') {
                        openGame(data.active.phase === 'assigned');
                        return;
                    }
                    if (data.busyElsewhere) {
                        tell('Sua partida está aberta em outra janela.');
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
        if (document.activeElement !== $('rpInitials'))
            $('rpInitials').value = /^[A-Z]{3}$/.test(data.profile.initials) ? data.profile.initials : 'JOG';
        $('rpProfileLabel').textContent = data.profile.initials;
        const uk = JSON.stringify([data.users, data.votes, data.participantVotes, data.proposalAvailableAt]);
        if (uk !== usersKey) {
            usersKey = uk;
            renderUsers();
            renderQueue();
        }
        proposalButton();
        renderBallot();
        const rankKey = `${data.version}:${rankingGame}`;
        if (visible && view === 'ranking' && rankKey !== lastRankingKey) {
            lastRankingKey = rankKey;
            loadRanking();
        }
    }
    function renderUsers() {
        const select = $('rpVoteTarget'),
            selected = select.value;
        select.replaceChildren(new Option('Escolha alguém online', ''));
        $('rpUsers').replaceChildren();
        for (const user of data.users) {
            const option = new Option(user.name + (user.mine ? ' · você' : ''), user.id);
            option.disabled = !user.canChallenge;
            select.append(option);
            const row = node('div', '', 'rp-user');
            row.append(
                node('span', user.name.slice(0, 2).toUpperCase(), 'rp-avatar'),
                node('b', user.name),
                node('small', user.canChallenge ? 'Disponível' : 'Indisponível agora')
            );
            $('rpUsers').append(row);
        }
        if ([...select.options].some((o) => o.value === selected && !o.disabled)) select.value = selected;
        proposalButton();
    }
    function proposalButton() {
        if (!data || !$('rpPropose')) return;
        const user = data.users.find((u) => u.id === $('rpVoteTarget').value);
        $('rpPropose').disabled = proposing || !data.participantVotes || !user?.canChallenge;
    }
    async function propose() {
        if (proposing) return;
        proposing = true;
        proposalButton();
        unlockAudio();
        try {
            const reply = await request(
                'playPropose',
                { peerId: $('rpVoteTarget').value, gameId: $('rpVoteGame').value },
                true
            );
            if (reply) tell(reply.vote?.status === 'queued' ? 'Proposta na fila.' : 'Voto enviado.');
        } catch (error) {
            tell(error.message);
        } finally {
            proposing = false;
            proposalButton();
            changed();
        }
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
        const box = ballot,
            v = data?.votes.find((v) => v.status === 'open');
        const target = visible ? hub.querySelector('.rp-main') : overlayHost();
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
            `${v.yes} de ${v.threshold} votos · ${Math.max(0, Math.ceil((v.expiresAt - Date.now()) / 1000))}s`;
    }
    async function loadRanking() {
        if (!data || !visible || view !== 'ranking') return;
        const id = $('rpRankGame').value;
        if (!id) return;
        rankingGame = id;
        try {
            const reply = await request('playRanking', { gameId: id });
            if (!reply || $('rpRankGame').value !== id) return;
            $('rpRankRules').textContent = 'Melhor marca por pessoa.';
            $('rpRankRows').replaceChildren();
            $('rpRankMore').hidden = true;
            if (!reply.rows.length) {
                $('rpRankRows').append(node('p', 'Ainda sem marcas. A primeira pode ser sua.', 'rp-empty'));
                return;
            }
            const table = node('table');
            table.innerHTML = '<thead><tr><th>Posição</th><th>Jogador</th><th>Marca</th></tr></thead>';
            const body = node('tbody');
            const expanded = $('rpRankMore').dataset.expanded === 'true';
            $('rpRankMore').hidden = expanded || reply.rows.length <= 5;
            const shown = expanded ? reply.rows : reply.rows.slice(0, 5);
            for (const r of shown) {
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
            if (reply.mine && !shown.some((r) => r.mine))
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
        const media = document.querySelectorAll(
            '.Camera > video,.Camera > img.videoAvatarImage,.pinned-video-container > video,.pinned-video-container > img.videoAvatarImage'
        );
        document.querySelectorAll('[data-room-play-obscured]').forEach((element) => {
            if (!blur || ![...media].includes(element)) element.removeAttribute('data-room-play-obscured');
        });
        for (const image of media) {
            if (!blur) continue;
            image.setAttribute('data-room-play-obscured', 'true');
            const tile = image.parentElement;
            if (wanted.has(tile)) continue;
            wanted.add(tile);
            let button = tile.querySelector(':scope > .rp-captcha-prompt');
            if (!button) {
                button = node('button', '◎', 'rp-captcha-prompt');
                button.type = 'button';
                button.setAttribute('aria-label', 'Abrir CAPTCHA do Boiolômetro');
                button.title = 'CAPTCHA do Boiolômetro';
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
        if (challenge) challenge.hidden = !blur || visible || !!frame;
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
                        savedInitials: !!data.profile.saved,
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
    function ownDie(roll, state = window.RoomUtilities?.current()) {
        return roll.localOwn === true || roll.peerId === socket?.id || !!state?.selfRollIds?.includes(roll.id);
    }
    function diceSummary(rolls) {
        const result = $('rpDiceResult');
        result.replaceChildren();
        for (const roll of rolls) {
            const item = node('span', '', 'rp-dice-outcome');
            item.dataset.rollId = roll.id;
            item.title = roll.peerName;
            const name = node('span', roll.peerName, 'rp-outcome-name');
            item.append(
                name,
                node('small', roll.kind === 'coin' ? 'Moeda' : roll.kind),
                node('b', window.RoomUtilities.result(roll))
            );
            result.append(item);
        }
    }
    function diceControls(state = window.RoomUtilities?.current()) {
        if (!hub || !state) return;
        const own = (roll) => ownDie(roll, state);
        const showingOwn = activeDice.some(own),
            waitingOwn = batch.some(own);
        const busy = !state.online || state.busy || showingOwn || waitingOwn;
        hub.querySelectorAll('[data-roll]').forEach((button) => {
            button.disabled = busy;
            button.setAttribute('aria-disabled', String(busy));
        });
        const status = $('rpRollStatus');
        status.dataset.state = !state.online
            ? 'offline'
            : state.pending || state.synchronizing
              ? 'request'
              : showingOwn
                ? 'rolling'
                : waitingOwn
                  ? 'queued'
                  : state.busy
                    ? 'rolling'
                    : 'ready';
        status.textContent = !state.online
            ? 'Reconectando à sala…'
            : state.pending || state.synchronizing
              ? 'Confirmando sua rolagem…'
              : waitingOwn
                ? 'Sua rolagem aparece em seguida.'
                : showingOwn || state.busy
                  ? 'Aguarde sua rolagem terminar.'
                  : 'Escolha um dado ou lance a moeda.';
    }
    function stopDice() {
        sceneGeneration++;
        clearTimeout(batchTimer);
        clearTimeout(revealTimer);
        clearTimeout(diceDeadline);
        batch = [];
        activeDice = [];
        scene?.stop();
        if (!scene) scenePromise = null;
        const viewer = $('roomPlayDiceViewer');
        if (viewer) {
            viewer.dataset.rolling = 'false';
            viewer.dataset.activeRollIds = '[]';
        }
        diceControls();
    }
    function diceUpdate(state, incoming = []) {
        if (!hub) return;
        if (!state.online) stopDice();
        const list = $('rpHistory');
        list.replaceChildren();
        const expanded = $('rpHistoryMore').dataset.expanded === 'true';
        $('rpHistoryMore').hidden = expanded || state.rolls.length <= 3;
        $('rpHistoryMore').textContent = `Ver as ${state.rolls.length} rolagens`;
        for (const r of expanded ? state.rolls : state.rolls.slice(0, 3)) {
            const li = node('li');
            const settled = r.revealAt <= state.now;
            const person = node('span', '', 'rp-roll-person');
            const name = node('span', r.peerName);
            name.title = r.peerName;
            const time = node(
                'time',
                new Date(r.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
            );
            time.dateTime = new Date(r.at).toISOString();
            person.append(name, time);
            li.append(
                person,
                node('small', r.kind === 'coin' ? 'Moeda' : r.kind),
                node('b', settled ? window.RoomUtilities.result(r) : 'Rolando…')
            );
            li.dataset.rollId = r.id;
            list.append(li);
        }
        if (!state.rolls.length) list.append(node('li', 'Ninguém rolou ainda.', 'rp-empty'));
        const playingGame = visible && view === 'games' && frame && !$('rpStage').hidden;
        if (incoming.length && !playingGame) {
            for (const roll of incoming) {
                if (batch.some((r) => r.id === roll.id) || activeDice.some((r) => r.id === roll.id)) continue;
                batch.push({ ...roll, localOwn: ownDie(roll, state) });
            }
            // Presentation stays bounded; every accepted roll remains in shared history.
            while (batch.length > 12) {
                const other = batch.findIndex((r) => !ownDie(r, state));
                batch.splice(other < 0 ? 0 : other, 1);
            }
            clearTimeout(batchTimer);
            batchTimer = setTimeout(animateDice, 120);
        }
        if (!activeDice.length && !batch.length) {
            const latest = state.rolls[0];
            $('rpDiceWho').textContent = latest
                ? `${latest.peerName} · ${latest.kind === 'coin' ? 'moeda' : latest.kind}`
                : 'Mesa de dados';
            if (latest && latest.revealAt <= state.now) diceSummary([latest]);
            else $('rpDiceResult').textContent = latest ? 'Rolando…' : 'Role um dado para começar.';
        }
        diceControls(state);
    }
    async function animateDice() {
        if (!hub || activeDice.length || !batch.length) return;
        if (visible && view === 'games' && frame && !$('rpStage').hidden) {
            batch = [];
            diceControls();
            return;
        }
        // A new physical throw cannot alter a throw already in flight. Coalesce nearby
        // arrivals, then serve the next group without dropping staggered participants.
        batch.sort((a, b) => Number(ownDie(b)) - Number(ownDie(a)) || a.sequence - b.sequence);
        const rolls = batch.splice(0, 4).sort((a, b) => a.sequence - b.sequence);
        activeDice = rolls;
        const viewer = $('roomPlayDiceViewer');
        viewer.hidden = false;
        viewer.dataset.rolling = 'true';
        viewer.dataset.activeRollIds = JSON.stringify(rolls.map((r) => r.id));
        if (visible && view === 'dice' && innerHeight <= 480 && rolls.some((roll) => ownDie(roll))) {
            const pane = $('rpDice');
            const top = pane.scrollTop + viewer.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8;
            pane.scrollTo({
                top: Math.max(0, top),
                behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            });
        }
        $('rpDiceWho').textContent =
            rolls.length === 1
                ? `${rolls[0].peerName} · ${rolls[0].kind === 'coin' ? 'moeda' : rolls[0].kind}`
                : `${rolls.length} rolagens da sala`;
        $('rpDiceResult').textContent = 'Rolando…';
        diceControls();
        const g = ++sceneGeneration;
        const revealAt = Math.max(...rolls.map((r) => r.revealAt));
        let motionDone = false;
        const finish = () => {
            if (g !== sceneGeneration || !hub || !motionDone || window.RoomUtilities.now() < revealAt) return;
            sceneGeneration++;
            clearTimeout(revealTimer);
            clearTimeout(diceDeadline);
            viewer.dataset.rolling = 'false';
            viewer.dataset.activeRollIds = '[]';
            diceSummary(rolls);
            activeDice = [];
            diceControls();
            if (batch.length) {
                clearTimeout(batchTimer);
                batchTimer = setTimeout(animateDice, 350);
            }
        };
        clearTimeout(revealTimer);
        revealTimer = setTimeout(finish, Math.max(0, revealAt - window.RoomUtilities.now()) + 25);
        clearTimeout(diceDeadline);
        diceDeadline = setTimeout(() => {
            if (g !== sceneGeneration || !hub) return;
            scene?.stop();
            if (!scene) scenePromise = null;
            motionDone = true;
            $('rpDiceWho').textContent = 'Resultado da sala · modo simples';
            finish();
        }, 10000);
        try {
            if (!scenePromise)
                scenePromise = import('/captcha/play/dice.js').then((m) => {
                    if (!hub || g !== sceneGeneration) throw new Error('Animação encerrada.');
                    return m.createDiceScene($('rpDiceScene'));
                });
            const loaded = await scenePromise;
            if (!hub || g !== sceneGeneration) {
                if (loaded !== scene) loaded.dispose();
                return;
            }
            scene = loaded;
            await scene.roll(rolls);
            motionDone = true;
            finish();
        } catch (error) {
            if (g !== sceneGeneration || !hub) return;
            console.warn('3D dice unavailable:', error.message);
            scene?.dispose();
            scene = null;
            scenePromise = null;
            motionDone = true;
            $('rpDiceWho').textContent = 'Resultado da sala · modo simples';
            finish();
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
        clearTimeout(diceDeadline);
        unsubscribe?.();
        observer?.disconnect();
        barObserver?.disconnect();
        window.removeEventListener('resize', layout);
        window.removeEventListener('message', bridge);
        document.removeEventListener('fullscreenchange', layout);
        document.removeEventListener('keydown', escapeWindow);
        dropFrame();
        sceneGeneration++;
        scene?.dispose();
        scene = null;
        scenePromise = null;
        batch = [];
        activeDice = [];
        for (const id of ['roomPlayHub', 'roomPlayDock', 'roomPlayBallot', 'roomPlayDiceViewer', 'roomPlayChallenge'])
            $(id)?.remove();
        document.querySelectorAll('.rp-captcha-prompt').forEach((e) => e.remove());
        document.body.classList.remove('room-captcha-blur');
        document.body.classList.remove('room-play-open');
        hub = null;
        challenge = ballot = dock = null;
        starting = proposing = false;
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
