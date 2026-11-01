(() => {
    'use strict';
    const $ = (id) => document.getElementById(id),
        base = '/captcha';
    let token = sessionStorage.getItem('captcha-admin-token'),
        state,
        selectedRoom = '',
        noticeTimer,
        roomDirty = false,
        gamesDirty = false,
        polling = false;
    const defaults = () => ({
        enabled: false,
        mode: 'one',
        intervalSeconds: 300,
        cooldownSeconds: 300,
        jitterPercent: 20,
    });
    const node = (tag, text, className) => {
        const e = document.createElement(tag);
        if (text !== undefined) e.textContent = text;
        if (className) e.className = className;
        return e;
    };
    const date = (time) =>
        new Date(time).toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    const gameName = (id) => state.catalog.find((g) => g.id === id)?.title || id;
    function notice(text, error = false) {
        $('notice').textContent = text;
        $('notice').classList.toggle('error', error);
        $('notice').hidden = false;
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => ($('notice').hidden = true), 6500);
    }
    async function api(route, body) {
        const response = await fetch(`${base}${route}`, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(8000),
        });
        const data = await response.json();
        if (!response.ok) {
            if (response.status === 401 && route !== '/login') logout();
            throw new Error(data.error || 'Não foi possível concluir.');
        }
        return data;
    }
    function logout() {
        token = null;
        sessionStorage.removeItem('captcha-admin-token');
        $('dashboard').hidden = $('logout').hidden = true;
        $('login').hidden = false;
        $('connection').textContent = 'Acesso restrito';
        $('liveDot').classList.remove('live');
    }
    $('logout').onclick = async () => {
        try {
            await api('/api/logout', {});
        } finally {
            logout();
        }
    };
    $('loginForm').onsubmit = async (event) => {
        event.preventDefault();
        try {
            const data = await api('/login', { key: $('key').value });
            token = data.token;
            sessionStorage.setItem('captcha-admin-token', token);
            $('key').value = '';
            await refresh();
        } catch (error) {
            notice(error.message, true);
        }
    };
    for (const button of document.querySelectorAll('[data-tab]'))
        button.onclick = () => {
            for (const b of document.querySelectorAll('[data-tab]'))
                b.setAttribute('aria-selected', String(b === button));
            for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== button.dataset.tab;
        };
    $('room').addEventListener('change', () => {
        selectedRoom = $('room').value.trim();
        roomDirty = false;
        renderRoom();
    });
    for (const id of ['randomEnabled', 'randomMode', 'interval', 'cooldown', 'jitter'])
        $(id).addEventListener('input', () => {
            roomDirty = true;
            $('saveRoom').textContent = 'Salvar alterações';
        });
    function action(label, fn, className) {
        const b = node('button', label, className);
        b.onclick = async () => {
            b.disabled = true;
            try {
                await fn();
                await refresh();
            } catch (error) {
                notice(error.message, true);
            } finally {
                b.disabled = false;
            }
        };
        return b;
    }
    function settingsCopy() {
        return JSON.parse(JSON.stringify(state.settings));
    }
    $('saveRoom').onclick = async () => {
        if (!selectedRoom) return notice('Selecione ou digite uma sala.', true);
        try {
            const settings = settingsCopy();
            settings.rooms[selectedRoom] = {
                enabled: $('randomEnabled').checked,
                mode: $('randomMode').value,
                intervalSeconds: Number($('interval').value),
                cooldownSeconds: Number($('cooldown').value),
                jitterPercent: Number($('jitter').value),
            };
            await api('/api/settings', settings);
            roomDirty = false;
            notice('Automação salva para esta sala.');
            await refresh();
        } catch (error) {
            notice(error.message, true);
        }
    };
    $('pauseRoom').onclick = async () => {
        try {
            await api('/api/pause-room', { roomId: selectedRoom });
            roomDirty = false;
            notice('Automação pausada. Todos os jogos e votações desta sala foram encerrados.');
            await refresh();
        } catch (error) {
            notice(error.message, true);
        }
    };
    const trigger = (peerId) => api('/api/trigger', { roomId: selectedRoom, peerId, gameId: $('triggerGame').value });
    const openVote = (peerId) =>
        api('/api/votes', {
            roomId: selectedRoom,
            peerId,
            gameId: $('triggerGame').value,
            mode: $('voteMode').value,
            required: Number($('voteRequired').value),
            seconds: Number($('voteSeconds').value),
        });
    $('randomTrigger').onclick = async () => {
        try {
            const data = await trigger();
            notice(
                data.assignments?.length
                    ? 'Participante sorteado. Jogo enviado.'
                    : 'Não há participante disponível para receber agora.'
            );
            await refresh();
        } catch (error) {
            notice(error.message, true);
        }
    };
    function renderRoom() {
        if (!state) return;
        const room = state.rooms.find((r) => r.id === selectedRoom),
            users = room?.users || [];
        $('onlineSummary').textContent =
            `${users.length} online nesta sala · ${state.rooms.reduce((n, r) => n + r.users.length, 0)} na plataforma`;
        $('pauseRoom').disabled = !selectedRoom;
        $('randomTrigger').disabled = !users.some((u) => u.ready && !u.active);
        $('users').replaceChildren();
        if (!users.length)
            $('users').append(node('p', 'Ninguém online nesta sala. A lista é atualizada automaticamente.', 'empty'));
        for (const user of users) {
            const row = node('div', undefined, 'user'),
                name = node('div', undefined, 'user-name'),
                actions = node('div', undefined, 'user-actions');
            name.append(
                node('strong', user.name),
                node(
                    'small',
                    !user.ready
                        ? 'Atualize a página para receber jogos'
                        : user.active
                          ? {
                                assigned: 'Verificação pendente',
                                playing: 'Verificação em andamento',
                                result: 'Avaliando o resultado',
                            }[user.phase] || 'Jogo aberto'
                          : 'Disponível'
                )
            );
            const play = action('Jogar', async () => {
                await trigger(user.id);
                notice(`Jogo enviado para ${user.name}.`);
            });
            const vote = action('Votar', async () => {
                await openVote(user.id);
                notice('Votação aberta para os presentes.');
            });
            play.disabled = vote.disabled = !user.ready || user.active;
            actions.append(play, vote);
            row.append(node('span', user.name.slice(0, 2).toUpperCase(), 'avatar'), name, actions);
            $('users').append(row);
        }
        if (!roomDirty) {
            const config = state.settings.rooms[selectedRoom] || defaults();
            $('randomEnabled').checked = config.enabled;
            $('randomMode').value = config.mode;
            $('interval').value = config.intervalSeconds;
            $('cooldown').value = config.cooldownSeconds;
            $('jitter').value = config.jitterPercent;
            $('saveRoom').textContent = 'Salvar automação';
        }
        $('nextRandom').textContent = room?.nextRandomAt
            ? `Próximo sorteio previsto: ${date(room.nextRandomAt)}. Pessoas ocupadas ou em pausa são puladas.`
            : 'Aleatório desligado ou aguardando o próximo ciclo.';
        $('active').replaceChildren();
        const active = state.active.filter((a) => a.roomId === selectedRoom);
        for (const a of active) {
            const row = node('div', undefined, 'active-row'),
                text = node('span', a.name);
            text.append(
                node(
                    'small',
                    `${a.config.title} · ${a.phase === 'result' ? 'resultado liberado' : a.phase === 'playing' ? 'jogando' : 'aguardando início'}`
                )
            );
            row.append(
                text,
                action('Liberar telas', () => api('/api/release', { peerId: a.peerId }))
            );
            $('active').append(row);
        }
        if (!active.length) $('active').append(node('p', 'Nenhum jogo aberto.', 'empty'));
        const votes = state.votes.filter((v) => v.roomId === selectedRoom && v.status === 'open');
        $('votes').replaceChildren();
        $('voteStatus').textContent = votes.length ? 'Votação aberta' : 'Nenhuma votação';
        for (const v of votes) {
            const row = node('div', undefined, 'vote-row'),
                text = node('span', v.name);
            text.append(node('small', `${v.yes}/${v.threshold} a favor · ${v.no} contra · até ${date(v.expiresAt)}`));
            row.append(
                text,
                action('Encerrar votação', () => api('/api/cancel-vote', { id: v.id }))
            );
            $('votes').append(row);
        }
        renderLogs();
    }
    function renderGames() {
        if (!gamesDirty) {
            $('gameRows').replaceChildren();
            for (const game of state.catalog) {
                const settings = state.settings.games[game.id],
                    row = node('tr');
                row.dataset.game = game.id;
                const name = node('td'),
                    label = node('label'),
                    enabled = node('input');
                enabled.type = 'checkbox';
                enabled.checked = settings.enabled;
                enabled.dataset.field = 'enabled';
                label.append(enabled, node('span', game.title));
                name.append(label);
                row.append(name);
                for (const [field, min, max, step] of [
                    ['duration', 8, 40, 1],
                    ['intensity', 0.7, 1.5, 0.05],
                ]) {
                    const cell = node('td'),
                        input = node('input');
                    Object.assign(input, { type: 'number', min, max, step, value: settings[field] });
                    input.dataset.field = field;
                    input.setAttribute(
                        'aria-label',
                        `${field === 'duration' ? 'Duração' : 'Intensidade'} · ${game.title}`
                    );
                    cell.append(input);
                    row.append(cell);
                }
                for (const field of ['starts', 'outcomes', 'winRate', 'retries', 'rating']) {
                    const cell = node('td');
                    cell.dataset.stat = field;
                    row.append(cell);
                }
                row.addEventListener('input', () => {
                    gamesDirty = true;
                    $('saveGames').textContent = 'Salvar alterações';
                });
                $('gameRows').append(row);
            }
            $('saveGames').textContent = 'Salvar jogos';
        }
        for (const stat of state.stats) {
            const row = [...$('gameRows').children].find((r) => r.dataset.game === stat.gameId);
            if (!row) continue;
            row.querySelector('[data-stat=starts]').replaceChildren(
                node('span', stat.starts),
                node('small', `${stat.users} pessoas · ${stat.completed} concluídas`)
            );
            row.querySelector('[data-stat=outcomes]').replaceChildren(
                node('span', `${stat.wins} / ${stat.losses}`),
                node('small', `${stat.abandoned} interrompidas`)
            );
            row.querySelector('[data-stat=winRate]').textContent =
                stat.winRate === null ? '—' : `${Math.round(stat.winRate * 100)}%`;
            row.querySelector('[data-stat=retries]').textContent = stat.retries;
            row.querySelector('[data-stat=rating]').replaceChildren(
                node(
                    'span',
                    stat.averageRating === null ? '☆☆☆☆☆' : `★ ${stat.averageRating.toFixed(1)} / 5`,
                    'stars-note'
                ),
                node(
                    'small',
                    `${stat.ratings} avaliações${stat.averageSeconds === null ? '' : ` · média ${stat.averageSeconds.toFixed(1)}s`}`
                )
            );
        }
        const total = state.stats.reduce(
            (s, g) => ({
                starts: s.starts + g.starts,
                done: s.done + g.completed,
                retries: s.retries + g.retries,
                ratings: s.ratings + g.ratings,
            }),
            { starts: 0, done: 0, retries: 0, ratings: 0 }
        );
        $('totals').textContent =
            `${total.starts} jogadas · ${total.done} concluídas · ${total.retries} repetições · ${total.ratings} avaliações · todas as salas`;
    }
    $('saveGames').onclick = async () => {
        try {
            const settings = settingsCopy();
            for (const row of $('gameRows').children) {
                const game = settings.games[row.dataset.game];
                game.enabled = row.querySelector('[data-field=enabled]').checked;
                for (const field of ['duration', 'intensity'])
                    game[field] = Number(row.querySelector(`[data-field=${field}]`).value);
            }
            await api('/api/settings', settings);
            gamesDirty = false;
            notice('Jogos salvos. As próximas tentativas usarão estes ajustes.');
            await refresh();
        } catch (error) {
            notice(error.message, true);
        }
    };
    function renderLogs() {
        const outcomes = { won: 'Vitória', lost: 'Derrota', abandoned: 'Interrompida', error: 'Falha do jogo' },
            sources = { admin: 'Painel', random: 'Aleatório', vote: 'Votação' };
        $('attempts').replaceChildren();
        for (const a of state.attempts.filter((a) => a.roomId === selectedRoom)) {
            const row = node('tr');
            for (const text of [
                date(a.startedAt),
                a.name,
                gameName(a.gameId),
                outcomes[a.outcome] || 'Em andamento',
                a.elapsed === undefined ? '—' : `${a.elapsed.toFixed(1)}s`,
                a.number === 1 ? '1 · primeira' : `${a.number} · repetiu`,
                sources[a.source] || a.source,
                a.intensity.toFixed(2),
            ])
                row.append(node('td', text));
            $('attempts').append(row);
        }
        $('events').replaceChildren();
        const labels = {
            assigned: 'Jogo enviado',
            released: 'Telas liberadas',
            vote: 'Votação',
            configuration: 'Configuração salva',
        };
        for (const e of state.events.filter(
            (e) => e.roomId === selectedRoom || e.vote?.roomId === selectedRoom || e.kind === 'configuration'
        ))
            $('events').append(
                node(
                    'p',
                    `${date(e.at)} · ${labels[e.kind] || e.kind}${e.name ? ` · ${e.name}` : ''}${e.gameId ? ` · ${gameName(e.gameId)}` : ''}${e.reason ? ` · ${e.reason}` : ''}${e.vote ? ` · ${e.vote.name} · ${e.vote.yes}/${e.vote.threshold} · ${e.vote.status}` : ''}`
                )
            );
    }
    async function refresh() {
        if (!token || polling) return;
        polling = true;
        try {
            state = await api('/api/state');
            $('login').hidden = true;
            $('dashboard').hidden = $('logout').hidden = false;
            $('connection').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
            $('liveDot').classList.add('live');
            const rooms = [...new Set([...state.rooms.map((r) => r.id), ...Object.keys(state.settings.rooms)])];
            $('rooms').replaceChildren(
                ...rooms.map((id) => {
                    const option = node('option');
                    option.value = id;
                    return option;
                })
            );
            if (!selectedRoom && rooms.length && document.activeElement !== $('room')) {
                selectedRoom = rooms[0];
                $('room').value = selectedRoom;
            }
            if ($('triggerGame').options.length === 1)
                for (const game of state.catalog) {
                    const option = node('option', game.title);
                    option.value = game.id;
                    $('triggerGame').append(option);
                }
            for (const option of $('triggerGame').options)
                if (option.value !== 'random') option.disabled = !state.settings.games[option.value]?.enabled;
            renderRoom();
            renderGames();
            if (state.storageError) notice(state.storageError, true);
        } catch (error) {
            $('liveDot').classList.remove('live');
            $('connection').textContent = 'Sem atualização · tentando reconectar';
            notice(error.message, true);
        } finally {
            polling = false;
        }
    }
    setInterval(refresh, 3000);
    refresh();
})();
