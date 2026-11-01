/* Development experiment. Owns UI only, never media or meeting membership. */
(() => {
    'use strict';
    let socket,
        adapter,
        enabled = false,
        current,
        root,
        frame,
        nonce,
        layoutTimer,
        expiryTimer,
        loadTimer;
    let promptsRoot,
        preferredScreen,
        autoStart = false,
        obscured = false;
    const prompts = new Map();
    let minimized = false,
        voteBox,
        voteTimer,
        generation = 0;
    const listeners = [];
    const el = (tag, text, className) => {
        const node = document.createElement(tag);
        if (text) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const listen = (event, fn) => {
        socket.on(event, fn);
        listeners.push([event, fn]);
    };
    const blur = (value) => {
        obscured = !!value;
        document.body.classList.toggle('room-captcha-blur', obscured);
        layoutPrompts();
    };
    function screenBox(video) {
        if (!video?.isConnected) return null;
        const box = video.getBoundingClientRect();
        if (box.width < 40 || box.height < 40 || getComputedStyle(video).visibility === 'hidden') return null;
        if (video.videoWidth && video.videoHeight && getComputedStyle(video).objectFit === 'contain') {
            const ratio = video.videoWidth / video.videoHeight;
            const width = Math.min(box.width, box.height * ratio),
                height = width / ratio;
            return {
                left: box.left + (box.width - width) / 2,
                top: box.top + (box.height - height) / 2,
                width,
                height,
            };
        }
        return box;
    }
    function layoutPrompts() {
        const visible = current && obscured && (!root || minimized);
        if (!visible) {
            if (promptsRoot) promptsRoot.hidden = true;
            return;
        }
        if (!promptsRoot) {
            promptsRoot = el('div', '', 'room-captcha-prompts');
            promptsRoot.id = 'roomCaptchaPrompts';
            document.body.append(promptsRoot);
        }
        promptsRoot.hidden = false;
        const screens = new Set(document.querySelectorAll('video[data-room-captcha-screen="true"]'));
        for (const [video, button] of prompts)
            if (!screens.has(video)) {
                button.remove();
                prompts.delete(video);
            }
        for (const video of screens) {
            const box = screenBox(video);
            let button = prompts.get(video);
            if (!button && box) {
                button = el('button', '', 'room-captcha-prompt');
                button.type = 'button';
                button.dataset.captchaTarget = video.id;
                button.setAttribute('aria-label', 'Abrir CAPTCHA do Boiolômetro');
                const mark = el('span', '', 'room-captcha-prompt-mark');
                mark.setAttribute('aria-hidden', 'true');
                const copy = el('span', '', 'room-captcha-prompt-copy');
                copy.append(el('strong', 'CAPTCHA do Boiolômetro'), el('small', 'Verificação necessária'));
                button.append(mark, copy, el('span', 'CAPTCHA', 'room-captcha-prompt-short'));
                button.onclick = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openChallenge(video);
                };
                prompts.set(video, button);
                promptsRoot.append(button);
            }
            if (!button) continue;
            const visibleBox =
                box &&
                box.top < innerHeight &&
                box.left < innerWidth &&
                box.left + box.width > 0 &&
                box.top + box.height > 0;
            button.hidden = !visibleBox;
            if (!visibleBox) continue;
            const width = Math.min(282, box.width - 16),
                height = width < 230 ? 42 : 68;
            button.classList.toggle('is-compact', width < 230);
            Object.assign(button.style, {
                width: `${width}px`,
                height: `${height}px`,
                left: `${box.left + (box.width - width) / 2}px`,
                top: `${box.top + (box.height - height) / 2}px`,
            });
        }
    }
    function rpc(event, data = {}) {
        return new Promise((resolve, reject) => {
            if (!socket?.connected) return reject(new Error('Conexão indisponível.'));
            socket.timeout(7000).emit(event, data, (error, result) => {
                if (error || result?.error) reject(new Error(result?.error || 'O servidor não respondeu.'));
                else resolve(result);
            });
        });
    }
    function send(type, data = {}) {
        frame?.contentWindow?.postMessage({ type, nonce, assignmentId: current?.id, ...data }, location.origin);
    }
    function layout() {
        layoutPrompts();
        if (!root) return;
        let client;
        try {
            client = adapter?.getClient?.();
        } catch {
            /* Room is still initializing. */
        }
        const pin = client?.videoPinMediaContainer || document.getElementById('videoPinMediaContainer');
        const screen = pin?.querySelector('video[data-room-captcha-screen="true"]');
        const rect = screenBox(screen) || screenBox(preferredScreen);
        const pinned = rect && rect.width > 260 && rect.height > 160;
        const width = minimized
            ? Math.min(340, innerWidth - 24)
            : pinned
              ? Math.min(rect.width, innerWidth - 16)
              : Math.min(900, innerWidth - 24);
        const height = minimized
            ? 38
            : pinned
              ? Math.min(rect.height, innerHeight - 100)
              : Math.min(width * 0.5625 + 86, innerHeight - 126);
        const left = minimized
            ? innerWidth - width - 12
            : pinned
              ? Math.max(8, Math.min(rect.left, innerWidth - width - 8))
              : (innerWidth - width) / 2;
        const top = minimized
            ? 12
            : pinned
              ? Math.max(8, Math.min(rect.top, innerHeight - height - 90))
              : Math.max(12, (innerHeight - height - 74) / 2);
        Object.assign(root.style, { width: `${width}px`, height: `${height}px`, left: `${left}px`, top: `${top}px` });
        root.classList.toggle('is-minimized', minimized);
    }
    function minimize() {
        minimized = !minimized;
        send(minimized ? 'captcha:minimize' : 'captcha:expand');
        root.querySelector('[data-minimize]').textContent = minimized ? 'Continuar' : 'Minimizar';
        layout();
    }
    function clear() {
        blur(false);
        clearInterval(layoutTimer);
        clearTimeout(expiryTimer);
        clearTimeout(loadTimer);
        root?.remove();
        promptsRoot?.remove();
        promptsRoot = null;
        prompts.clear();
        preferredScreen = null;
        autoStart = false;
        root = frame = current = null;
        nonce = null;
        minimized = false;
    }
    function release() {
        const id = current?.id;
        if (id) rpc('captchaRelease', { assignmentId: id }).catch(() => {});
        clear();
    }
    function assign(value) {
        if (!enabled || !value?.id || !value.config || current?.id === value.id) return;
        clear();
        current = value;
        nonce = crypto.randomUUID();
        blur(value.phase !== 'result');
        layout();
        layoutTimer = setInterval(layout, 250);
        expiryTimer = setTimeout(release, Math.max(0, value.expiresAt - Date.now()));
    }
    function openChallenge(video) {
        if (!current) return;
        preferredScreen = video;
        if (root) {
            if (minimized) minimize();
            frame?.focus({ preventScroll: true });
            return;
        }
        autoStart = true;
        root = el('section', '', 'room-captcha-window');
        root.id = 'roomCaptchaWindow';
        root.setAttribute('aria-label', 'Verificação do Boiolômetro');
        const bar = el('div', '', 'room-captcha-windowbar');
        bar.append(el('span', 'CAPTCHA · Boiolômetro'));
        const small = el('button', 'Minimizar');
        small.dataset.minimize = '';
        small.onclick = minimize;
        const exit = el('button', 'Encerrar');
        exit.onclick = release;
        bar.append(small, exit);
        frame = el('iframe');
        frame.title = 'CAPTCHA do Boiolômetro';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.setAttribute('allow', "camera 'none'; microphone 'none'; display-capture 'none'");
        frame.src = '/dev/captcha/play/room.html';
        frame.addEventListener('load', () => send('captcha:init', { assignment: current }));
        root.append(bar, frame);
        document.body.append(root);
        layout();
        loadTimer = setTimeout(release, 12000);
    }
    async function bridge(event) {
        const data = event.data;
        if (
            !current ||
            event.source !== frame?.contentWindow ||
            event.origin !== location.origin ||
            data?.nonce !== nonce ||
            data.assignmentId !== current.id
        )
            return;
        const id = current.id;
        try {
            if (data.type === 'captcha:ready') {
                clearTimeout(loadTimer);
                if (autoStart) {
                    autoStart = false;
                    send('captcha:begin');
                }
            } else if (data.type === 'captcha:start') {
                const result = await rpc('captchaAttemptStart', { assignmentId: id });
                if (current?.id !== id) return;
                current.phase = 'playing';
                blur(true);
                send('captcha:attempt', result);
            } else if (data.type === 'captcha:finished') {
                // Visual release does not wait for analytics or disk availability.
                current.phase = 'result';
                blur(false);
                await rpc('captchaAttemptFinish', {
                    assignmentId: id,
                    attemptId: data.attemptId,
                    reason: data.reason,
                    elapsed: data.elapsed,
                });
            } else if (data.type === 'captcha:rating') {
                await rpc('captchaRate', { assignmentId: id, attemptId: data.attemptId, value: data.value });
                if (current?.id === id) send('captcha:rated');
            } else if (['captcha:release', 'captcha:load-error'].includes(data.type)) release();
        } catch (error) {
            blur(false);
            if (current?.id === id) send('captcha:error', { error: error.message });
        }
    }
    function vote(value) {
        voteBox?.remove();
        clearInterval(voteTimer);
        if (!value || value.status !== 'open') return;
        voteBox = el('aside', '', 'room-captcha-vote');
        voteBox.id = 'roomCaptchaVote';
        voteBox.setAttribute('aria-label', 'Votação do Boiolômetro');
        const title = el('strong', `${value.name} deve passar pelo Boiolômetro?`);
        const detail = el('span');
        const buttons = el('div');
        const stored = value.choice || sessionStorage.getItem(`captcha-vote:${value.id}`);
        for (const [choice, label] of [
            ['yes', 'Sim'],
            ['no', 'Não'],
        ]) {
            const button = el('button', stored === choice ? 'Voto registrado' : label);
            button.disabled = !!stored || value.eligible === false;
            button.onclick = async () => {
                [...buttons.children].forEach((b) => (b.disabled = true));
                try {
                    await rpc('captchaVoteCast', { voteId: value.id, choice });
                    sessionStorage.setItem(`captcha-vote:${value.id}`, choice);
                    button.textContent = 'Voto registrado';
                } catch (error) {
                    detail.textContent = error.message;
                }
            };
            buttons.append(button);
        }
        const refresh = () => {
            const seconds = Math.max(0, Math.ceil((value.expiresAt - Date.now()) / 1000));
            detail.textContent = `${value.yes}/${value.threshold} votos a favor · ${seconds}s`;
            if (!seconds) {
                voteBox?.remove();
                clearInterval(voteTimer);
            }
        };
        refresh();
        voteTimer = setInterval(refresh, 1000);
        voteBox.append(title, detail, buttons);
        document.body.append(voteBox);
    }
    function disconnect() {
        generation++;
        enabled = false;
        for (const [event, fn] of listeners.splice(0)) socket?.off(event, fn);
        clear();
        voteBox?.remove();
        voteBox = null;
        clearInterval(voteTimer);
        socket = null;
    }
    async function connect(value, options) {
        disconnect();
        socket = value;
        adapter = options;
        const version = generation;
        listen('disconnect', disconnect);
        listen('captchaAssigned', assign);
        listen('captchaReleased', (data) => {
            if (data.assignmentId !== current?.id) return;
            blur(false);
            if (!data.keepResult) clear();
        });
        listen('captchaVote', vote);
        try {
            const info = await rpc('captchaHello');
            if (version !== generation) return;
            enabled = !!info.enabled;
            if (enabled && info.assignment) assign(info.assignment);
        } catch {
            clear();
        }
    }
    window.addEventListener('message', bridge);
    window.addEventListener('pagehide', disconnect);
    window.RoomCaptcha = { connect, disconnect };
})();
