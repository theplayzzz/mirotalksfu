import './room.css';
import { PeachGame, createSqueak } from './game.js';
import { ChallengeHost, artworkReady } from './challenge-host.js';
import { playerUrls, playerSpritesReady } from './player.js';
import { gameHud } from './hud.js';
import { createSliceSound } from './slice-sound.js';

const $ = (id) => document.getElementById(id);
const squeak = createSqueak(),
    slice = createSliceSound();
const fitCanvas = () => {
    const box = $('arena').getBoundingClientRect(),
        width = Math.min(box.width, (box.height * 16) / 9);
    Object.assign($('game').style, { width: `${width}px`, height: `${(width * 9) / 16}px` });
    game?.render();
};
document.querySelectorAll('[data-emoji]').forEach((img) => (img.src = playerUrls[img.dataset.emoji]));
let assignment,
    attempt,
    nonce,
    game,
    config,
    rating = 0,
    pending = false,
    hiddenPause = false;
const post = (type, data = {}) =>
    parent.postMessage({ type, nonce, assignmentId: assignment?.id, ...data }, location.origin);
function message(text) {
    $('error').textContent = text;
    $('error').hidden = !text;
}
function state(value) {
    $('ready').hidden = value !== 'ready';
    $('paused').hidden = value !== 'paused';
    $('countdown').hidden = value !== 'countdown';
    $('result').hidden = value !== 'finished';
    post('play:phase', { phase: value });
}
function tick(info = {}) {
    if (!game?.sim) return;
    const sim = game.sim,
        left = Math.max(0, sim.remaining ?? config.duration - sim.elapsed),
        fraction = left / config.duration;
    $('time').textContent = `${Math.ceil(left)}s`;
    $('gameHud').classList.toggle('urgent', left <= 10 && sim.clockStarted !== false && game.state === 'playing');
    $('progress').style.transform = `scaleX(${fraction})`;
    $('progress').style.backgroundColor = `hsl(${22 + (1 - fraction) * 120} 75% 68%)`;
    $('hint').textContent = sim.hint || 'Desvie com o mouse até o tempo acabar.';
    const hud = gameHud(config.id, sim);
    $('score').textContent = hud.summary;
    $('resource').hidden = !hud.resource;
    if (hud.resource) {
        $('resource').querySelector('span').textContent = `${hud.resource.label} · ${hud.resource.display}`;
        const meter = $('resource').querySelector('progress');
        meter.max = hud.resource.max;
        meter.value = hud.resource.value;
    }
    $('countdown').textContent = Math.max(1, Math.ceil((info.countdown || game.countdown || 0) / 0.8));
}
function createPlayer() {
    game?.destroy();
    config = assignment.config;
    const manual = assignment.source === 'manual';
    $('title').textContent = config.title;
    $('readyTitle').textContent = config.title;
    $('readyLabel').textContent = manual ? 'PARTIDA LIVRE' : 'CAPTCHA DO BOIOLÔMETRO';
    $('readyCopy').textContent = manual
        ? 'Jogue com o mouse e registre sua melhor marca.'
        : 'Siga as instruções para concluir a análise.';
    const callbacks = {
        onState: state,
        onTick: tick,
        onImpact: () => squeak(),
        onCut: (count) => slice(count),
        onFinish: (result) => {
            const won = result.reason === 'survived';
            $('resultEmoji').src = won ? playerUrls.escape : playerUrls.impact;
            $('resultLabel').textContent = manual ? 'RESULTADO DA PARTIDA' : 'RESULTADO DA ANÁLISE';
            $('resultTitle').textContent = won ? 'Você conseguiu!' : 'Infelizmente, você é boiola.';
            $('resultCopy').textContent = won
                ? 'Partida concluída. Sua marca vale para o ranking da sala.'
                : 'Não precisa se sentir triste. A gente ainda te aceita mesmo assim.';
            $('release').textContent = manual ? 'Voltar à sala' : 'Liberar acesso';
            $('resultScore').textContent = 'Registrando sua marca…';
            $('nextVerification').hidden = true;
            rating = 0;
            paintStars();
            $('ratingStatus').textContent = 'Avaliação opcional.';
            post('captcha:finished', {
                attemptId: attempt.id,
                reason: ['survived', 'impact', 'timeout'].includes(result.reason) ? result.reason : 'impact',
                elapsed: result.elapsed,
                metrics: {
                    score: result.score ?? game.sim?.score ?? 0,
                    progress: game.sim?.courseProgress ?? (game.sim?.score || 0) / (game.sim?.goal || 5),
                },
            });
        },
    };
    game =
        config.id === 'arena'
            ? new PeachGame($('game'), callbacks)
            : new ChallengeHost($('game'), config.id, callbacks);
    $('start').disabled = false;
    $('start').textContent = manual ? 'Jogar' : 'Iniciar verificação';
    tick();
}
function start() {
    if (pending) return;
    pending = true;
    $('start').disabled = $('retry').disabled = true;
    message('');
    post('captcha:start');
}
function paintStars(preview = rating) {
    [...$('stars').children].forEach((button, i) => {
        button.textContent = i < preview ? '★' : '☆';
        button.classList.toggle('filled', i < preview);
        button.setAttribute('aria-checked', String(i + 1 === rating));
    });
}
for (let value = 1; value <= 5; value++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '☆';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', `${value} ${value === 1 ? 'estrela' : 'estrelas'}`);
    button.setAttribute('aria-checked', 'false');
    button.addEventListener('mouseenter', () => paintStars(value));
    button.addEventListener('focus', () => paintStars(value));
    button.addEventListener('blur', () => paintStars());
    button.addEventListener('click', () => {
        rating = value;
        paintStars();
        $('ratingStatus').textContent = 'Registrando avaliação…';
        post('captcha:rating', { attemptId: attempt.id, value });
    });
    $('stars').append(button);
}
$('stars').addEventListener('mouseleave', () => paintStars());
$('start').addEventListener('click', start);
$('retry').addEventListener('click', start);
$('release').addEventListener('click', () => post('captcha:release'));
$('resume').addEventListener('click', () => game?.resume());
$('ranking').addEventListener('click', () => post('play:ranking'));
$('nextVerification').addEventListener('click', () => post('play:activate'));
$('initialsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    post('play:profile', { initials: $('initials').value.toUpperCase() });
});
window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== parent || !event.data || typeof event.data !== 'object')
        return;
    const data = event.data;
    if (data.type === 'captcha:init' && !assignment) {
        if (!data.assignment?.config || typeof data.nonce !== 'string') return;
        assignment = data.assignment;
        nonce = data.nonce;
        $('initials').value = data.profile?.initials || 'JOG';
        Promise.all([artworkReady, playerSpritesReady])
            .then(() => {
                createPlayer();
                post('captcha:ready');
            })
            .catch(() => {
                message('O jogo não carregou. Você pode liberar as telas.');
                post('captcha:load-error');
            });
        return;
    }
    if (data.nonce !== nonce || data.assignmentId !== assignment?.id) return;
    if (data.type === 'captcha:begin') start();
    else if (data.type === 'captcha:attempt') {
        pending = false;
        $('start').disabled = $('retry').disabled = false;
        attempt = data.attempt;
        assignment.config = data.config;
        createPlayer();
        game.start({ duration: config.duration, intensity: config.intensity });
        $('game').focus({ preventScroll: true });
    } else if (data.type === 'captcha:error') {
        pending = false;
        $('start').disabled = $('retry').disabled = false;
        message(data.error || 'Não foi possível iniciar. Tente novamente.');
    } else if (data.type === 'play:recorded') {
        $('resultScore').textContent = data.score ? `Marca registrada · ${data.score.label}` : 'Partida registrada.';
        $('initials').value = data.initials || 'JOG';
        $('nextVerification').hidden = !data.pending;
    } else if (data.type === 'play:profile') {
        $('initials').value = data.initials;
        $('resultScore').textContent = 'Sigla salva no ranking.';
    } else if (data.type === 'play:pending') $('nextVerification').hidden = !data.pending;
    else if (data.type === 'captcha:rated') $('ratingStatus').textContent = 'Avaliação registrada.';
    else if (data.type === 'captcha:minimize') {
        hiddenPause ||= ['playing', 'countdown'].includes(game?.state);
        if (hiddenPause) game.pause();
    } else if (data.type === 'captcha:expand' && hiddenPause) {
        hiddenPause = false;
        game?.resume();
    } else if (data.type === 'captcha:toggle-pause') game?.state === 'paused' ? game.resume() : game?.pause();
});
window.addEventListener('error', () => post('captcha:load-error'));
window.addEventListener('pagehide', () => game?.destroy());
new ResizeObserver(fitCanvas).observe($('arena'));
