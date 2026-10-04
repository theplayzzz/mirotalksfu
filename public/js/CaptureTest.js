'use strict';

/*
 * The capture test (views/CaptureTest.html, served at /capture-test): what THIS computer does when it shares its screen (or a
 * window), measured here, with the person's own screen, and nothing leaves the page.
 *
 * Why it exists. A friend who shares a game sends 16 or 32 frames per second when the room wants 60, and the numbers of the
 * room cannot say whether the browser could not CAPTURE the screen fast enough (Chrome's desktop capture converts and
 * scales every frame on the processor and may use at most half of the time), could not ENCODE it (software encoders next
 * to a game), or whether the line could not carry it. Here the three are separated, one at a time, with the real screen:
 *
 *   capture   frames per second the capture delivers (MediaStreamTrackProcessor counts them, whatever happens after),
 *             and how even they are, at each size the room could ask for (the first request, then track.applyConstraints);
 *   encoder   the same capture sent to itself through two RTCPeerConnections (no network): frames per second out of the
 *             encoder, milliseconds per frame, which encoder Chrome used (software or the graphics card's), what limited it;
 *   the PC    the browser's own word on how busy the processor is (Compute Pressure), the display, the graphics card.
 *
 * A capture only gives frames when what is captured CHANGES, so a screen or window that stands still says nothing about
 * the speed of the capture: such steps are marked as still and left out of the verdict ('Medir agora' makes this page
 * itself move on the whole screen; 'Medir com o jogo' leaves the moving to the game).
 *
 * The decisions about the numbers are pure functions (describe, report), loaded by the unit tests
 * (tests/test-CaptureTest.js). The rest runs in the browser.
 */
(function (root) {
    const TARGET_FPS = 60;
    const GOOD_FPS = 54; // 90% of the target: what counts as holding it

    const round = (value, decimals = 0) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        const factor = 10 ** decimals;
        return Math.round(value * factor) / factor;
    };

    const percentile = (values, p) => {
        if (!values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    };

    // How Chrome ranks an H.264 entry for its hardware encoders: Main, High, Baseline, then Constrained Baseline (software on
    // Windows). Same rule as ScreenQuality.pickH264, for a codec capability (sdpFmtpLine) instead of a room's codec.
    function h264Rank(fmtp) {
        const found = /profile-level-id=([0-9a-fA-F]{6})/.exec(String(fmtp || ''));
        if (!found) return 4;
        const profile = parseInt(found[1].slice(0, 2), 16);
        const constraints = parseInt(found[1].slice(2, 4), 16);
        if (profile === 0x4d) return 0;
        if (profile === 0x64) return 1;
        if (profile === 0x42) return constraints & 0x40 ? 3 : 2;
        return 4;
    }

    const isHardware = (step) => step && (step.hw === true || (step.hw === undefined && /external|d3d11|mediafoundation|nvenc|amf|qsv|videotoolbox|vaapi/i.test(step.enc || '') && !/fallback/i.test(step.enc || '')));

    // A capture gives frames when the picture changes: a screen or a window that stands still gives a frame or two a second and
    // almost nothing to encode. That says nothing about how fast the capture is.
    // (under 3 a second it is a keep-alive whatever the encoder made of it: a hardware encoder spends its whole bitrate on the few frames it
    // gets; under 12 a second with almost no data, or with the gaps of a once-a-second refresh, it is the same)
    const isStill = (step) =>
        Boolean(step) &&
        typeof step.capFps === 'number' &&
        (step.capFps < 3 || (step.capFps < 12 && ((step.kbps !== undefined && step.kbps < 800) || (step.gapP95 >= 900 && step.gapP95 <= 1100))));

    // ---- what the numbers say --------------------------------------------------------------------------------------

    // steps: [{ id: 'room' | 'small' | 'native' | 'h264', asked: [w, h], codec, capFps, gapP95, capW, capH, encFps, encMs,
    //           sentW, sentH, kbps, enc, hw, limit, limCpuS, limBwS, press, skipped, error }]
    // env: { surface, cores, gpu, hz, power, ... }. Returns [{ tone: 'good' | 'warn' | 'bad' | 'info', text }]
    function describe(steps, env = {}) {
        const out = [];
        const say = (tone, text) => out.push({ tone, text });
        const all = steps || [];
        const measured = (s) => Boolean(s) && !s.error && !s.skipped && typeof s.capFps === 'number';
        const usable = (id) => {
            const s = all.find((x) => x.id === id);
            return measured(s) && !isStill(s) ? s : undefined;
        };
        const room = usable('room');
        const small = usable('small');
        const native = usable('native');
        const hardware = usable('h264');
        const stills = all.filter((s) => measured(s) && isStill(s));

        if (env.surface === 'window') {
            say('info', 'Você compartilhou uma janela (o resultado vale para ela). Se o seu jogo roda em tela cheia exclusiva, meça também a tela inteira.');
        } else if (env.surface === 'browser') {
            say('warn', 'Você compartilhou uma aba do Chrome, não a tela nem a janela do jogo: o resultado vale para a aba.');
        }
        if (stills.length) {
            say('warn', `Em ${stills.length === all.filter(measured).length ? 'todos os passos' : stills.length === 1 ? 'um passo' : stills.length + ' passos'} a imagem compartilhada praticamente não mudou (poucos quadros e quase nenhum dado): essa medição não vale, porque a captura só entrega quadros quando a imagem muda. Deixe o que está sendo compartilhado em movimento (o jogo rodando, ou esta aba na frente com "Medir agora") e refaça.`);
        }
        // a hardware encoder is constant-bitrate: given a picture that stands still it spends all it is given (and a software one almost nothing)
        const spender = stills.find((s) => isHardware(s) && s.kbps >= 3000);
        if (spender) {
            const soft = stills.find((s) => !isHardware(s) && typeof s.kbps === 'number');
            say('warn', `Com a imagem parada o codificador da placa de vídeo mandou ${round(spender.kbps)} kbps${soft ? ` (o VP8 mandou ${round(soft.kbps)})` : ''}: ele gasta a banda toda mesmo sem nada mudar. Por isso a sala só usa o H.264 da placa onde ele compensa.`);
        }
        if (!room) {
            if (!stills.some((s) => s.id === 'room')) say('bad', 'O teste não conseguiu medir a captura no tamanho que a sala pede.');
            return out;
        }

        // the capture
        const origin = native ? `${native.capW}x${native.capH}` : env.nativeW && env.nativeH ? `${env.nativeW}x${env.nativeH}` : null;
        const bigOrigin = (native ? native.capW * native.capH : (env.nativeW || 0) * (env.nativeH || 0)) > 2100000;
        const perFrame = round(500 / Math.max(room.capFps, 0.1), 1);
        const sized = [room, small, native].filter(Boolean);
        const rates = sized.map((s) => s.capFps);
        // about the same number of frames whatever size is asked for
        const flat = sized.length >= 2 && Math.max(...rates) <= Math.min(...rates) * 1.2;
        if (room.capFps >= GOOD_FPS) {
            say('good', `A captura de tela entrega ${round(room.capFps)} fps no tamanho que a sala pede (1080p): aqui a captura não é o limite.`);
        } else {
            say('bad', `A captura de tela entregou só ${round(room.capFps)} fps no tamanho que a sala pede (1080p). É o limite: nada que vem depois (codificador, internet, servidor) devolve quadros que a captura não deu. O Chrome gasta uns ${perFrame} ms por quadro e só pode usar metade do tempo; para 60 fps o quadro teria de levar menos de 8 ms.`);
            const better = [small, native].filter((s) => s && s.capFps >= GOOD_FPS).sort((a, b) => b.capW * b.capH - a.capW * a.capH)[0];
            if (better) {
                say('good', `Pedindo a captura em ${better.capW}x${better.capH} ela chega a ${round(better.capFps)} fps: esse é o tamanho que segura 60 fps neste computador.`);
            } else if (flat) {
                say('info', `A captura entrega quase o mesmo número de quadros (${round(Math.min(...rates))} a ${round(Math.max(...rates))} fps) em todos os tamanhos pedidos${origin ? `: o limite não está no tamanho que a sala pede, e sim na leitura da imagem de origem (${origin}) pelo navegador, e mais ainda quando a placa de vídeo está ocupada com o jogo` : ''}. Pedir uma captura menor não ajuda; ajuda diminuir a imagem de ORIGEM (o jogo ou a janela em resolução menor) ou trocar o caminho da captura.`);
            } else if (small && small.capFps > room.capFps * 1.15) {
                say('warn', `Em ${small.capW}x${small.capH} a captura sobe para ${round(small.capFps)} fps (de ${round(room.capFps)}), mas ainda não chega a 60.`);
            } else if (small) {
                say('warn', `Pedir um tamanho menor (${small.capW}x${small.capH}) quase não muda a captura (${round(small.capFps)} fps): o custo está em ler a imagem inteira, não no tamanho pedido.`);
            }
            if (bigOrigin) {
                say('info', `A imagem de origem é ${origin || 'maior que 1080p'}: o navegador lê todos esses pontos a cada quadro, e o custo cresce com o tamanho dela (num PC de teste, com a placa livre: cerca de 53 fps numa janela de 720p, 37 em 1080p e 25 em 1440p). Reduzir a imagem de origem ajuda, mas não garante 60 fps. Limitar os fps do jogo a ~60 também deixa a placa de vídeo livre para a captura.`);
            }
            say('info', 'Próximos testes: (1) compare "Tela inteira" com "janela do jogo" (a janela costuma ser mais leve); (2) repita com o jogo/janela em resolução menor; (3) repita com o jogo fechado e "Medir agora", para separar o peso do jogo do peso da captura.');
        }
        if (native && native !== room && !flat && native.capFps < room.capFps * 0.8) {
            say('info', `No tamanho original (${native.capW}x${native.capH}) a captura entrega ${round(native.capFps)} fps.`);
        }
        const gappy = [room, small, native].filter((s) => s && s.capFps >= 30 && s.gapP95 > 3000 / Math.max(s.capFps, 1)).length;
        if (gappy) say('warn', 'Os quadros da captura chegam irregulares (alguns intervalos bem maiores que a média): dá tranco mesmo com fps médio alto.');

        // the encoder
        const slowEncoder = [room, small].filter((s) => s && s.capFps >= GOOD_FPS && typeof s.encFps === 'number' && s.encFps < s.capFps * 0.9);
        if (slowEncoder.length) {
            const s = slowEncoder[0];
            say('bad', `O codificador não acompanha: a captura deu ${round(s.capFps)} fps e saíram só ${round(s.encFps)} (${s.enc || 'codificador por software'}, ${round(s.encMs, 1)} ms por quadro).`);
        } else if (room.encFps >= Math.min(GOOD_FPS, room.capFps * 0.9)) {
            // VP8, VP9 and AV1 are software in Chrome on a PC; for H.264 it is only said when the browser says
            const kind = room.codec !== 'H264' || room.hw === false ? 'software' : isHardware(room) ? 'hardware' : null;
            say('good', `O codificador acompanha a captura: ${round(room.encFps)} fps em ${room.sentW}x${room.sentH} (${room.codec}${kind ? ', ' + kind : ''}${room.enc ? ', ' + room.enc : ''}, ${round(room.encMs, 1)} ms por quadro).`);
        }
        if (room.limCpuS >= 2) say('warn', `O navegador disse que o processador limitou a imagem por ${round(room.limCpuS, 1)} s.`);

        // the graphics card's encoder: the browser says which encoder it used only to some pages, so where it does not, the
        // answer of mediaCapabilities for the Main profile stands in for it
        if (hardware) {
            const named = hardware.hw !== undefined || Boolean(hardware.enc);
            const hw = named ? isHardware(hardware) : /^hw/.test((env.caps && env.caps.h264e) || '') ? true : undefined;
            if (hw === true) {
                const same = Math.abs(hardware.capFps - room.capFps) <= room.capFps * 0.25;
                const vs = room.encFps ? ` (o VP8 por software mandou ${round(room.encFps)} fps)` : '';
                const why = same ? '' : ` A captura desse passo também foi diferente (${round(hardware.capFps)} fps), então a comparação com o VP8 não é justa.`;
                say('good', `O codificador H.264 da placa de vídeo está disponível (${named ? hardware.enc || 'hardware' : 'segundo o navegador'}) e mandou ${round(hardware.encFps)} fps em ${hardware.sentW}x${hardware.sentH}${vs}. Ele não gasta o processador que o jogo usa.${why}`);
            } else if (hw === false) {
                say('warn', 'O navegador não usou o codificador da placa de vídeo para H.264 (ficou por software): aqui o VP8 é a melhor escolha.');
            } else {
                say('info', `O H.264 mandou ${round(hardware.encFps)} fps em ${hardware.sentW}x${hardware.sentH}; o navegador não diz se foi pela placa de vídeo.`);
            }
        } else if (all.some((s) => s.id === 'h264' && s.skipped)) {
            say('warn', 'Este navegador não oferece H.264 em um perfil que a placa de vídeo codifique.');
        }

        // the PC
        const order = ['nominal', 'fair', 'serious', 'critical'];
        const worst = all.map((s) => s.press).filter(Boolean).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
        if (worst === 'serious' || worst === 'critical') say('warn', `O processador do computador ficou sob pressão ("${worst}") durante o teste: algum programa (o jogo?) usa boa parte dele.`);
        if (env.power === 'bateria') say('warn', 'O computador está na bateria: o Windows e o Chrome economizam energia e a captura costuma cair. Ligue na tomada e refaça.');
        return out;
    }

    // The text that is copied: short, readable, with the whole data in one JSON line at the end
    function report(steps, env, lines) {
        const rows = (steps || []).map((s) => {
            if (s.skipped) return `- ${s.label}: não testado (${s.skipped})`;
            if (s.error) return `- ${s.label}: erro (${s.error})`;
            return `- ${s.label}: captura ${round(s.capFps, 1)} fps em ${s.capW}x${s.capH} (p95 entre quadros ${round(s.gapP95)} ms)${isStill(s) ? ' [IMAGEM PARADA: não vale]' : ''} | codificador ${round(s.encFps, 1)} fps em ${s.sentW}x${s.sentH}, ${round(s.encMs, 1)} ms/quadro, ${round(s.kbps)} kbps, ${s.codec} ${s.enc || '?'}${s.hw === true ? ' (hardware)' : s.hw === false ? ' (software)' : ''}, limite: ${s.limit || '?'}${s.press ? ', pressão do processador: ' + s.press : ''}`;
        });
        const e = env || {};
        const head = [
            `Teste de captura (${e.when || ''}) modo: ${e.mode || '?'}`,
            `Navegador: ${e.browser || e.agent || '?'} | ${e.os || '?'} ${e.osVersion || ''} | ${e.cores || '?'} processadores lógicos, ${e.mem || '?'} GB`,
            `Placa de vídeo: ${e.gpu || '?'} | tela ${e.screen || '?'} (original ${e.nativeW || '?'}x${e.nativeH || '?'}) a ${e.hz || '?'} Hz | ${e.power || '?'} | compartilhado: ${e.surface || '?'}`,
            `Codificar: ${Object.entries(e.caps || {}).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        ];
        const verdict = (lines || []).map((l) => `* ${l.text}`);
        return [...head, '', ...rows, '', ...verdict, '', 'JSON: ' + JSON.stringify({ v: 2, env: e, steps })].join('\n');
    }

    const api = { describe, report, percentile, round, h264Rank, isHardware, isStill, GOOD_FPS, TARGET_FPS };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
        return;
    }
    root.CaptureTest = api;
    if (typeof document === 'undefined') return;

    // ---- in the browser --------------------------------------------------------------------------------------------

    const WARMUP_S = 4;
    const MEASURE_S = 10;
    const GAME_WAIT_S = 15;
    const PRESSURE_STATES = ['nominal', 'fair', 'serious', 'critical'];
    // ?allow=browser: a tab of the browser is accepted as the thing to capture (for the tests of this page only)
    const ALLOW_TAB = /(^|[?&])allow=browser(&|$)/.test(location.search);
    const el = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // A wait that gives up: the page must never wait for ever on something the browser does not answer
    function withTimeout(promise, ms, what) {
        let timer;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${what} não respondeu em ${Math.round(ms / 1000)} s`)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    // processor pressure of the whole PC, the worst state since it was last taken
    const pressure = { current: -1, worst: -1 };
    function watchPressure() {
        try {
            if (typeof PressureObserver === 'undefined' || !(PressureObserver.knownSources || []).includes('cpu')) return;
            const observer = new PressureObserver((records) => {
                for (const record of records) {
                    const rank = PRESSURE_STATES.indexOf(record.state);
                    if (rank < 0) continue;
                    pressure.current = rank;
                    if (rank > pressure.worst) pressure.worst = rank;
                }
            });
            observer.observe('cpu', { sampleInterval: 1000 }).catch(() => {});
        } catch (error) {
            // not available here
        }
    }
    function takePressure() {
        const worst = pressure.worst;
        pressure.worst = pressure.current;
        return worst >= 0 ? PRESSURE_STATES[worst] : undefined;
    }

    async function capability(method, contentType) {
        try {
            const info = await withTimeout(navigator.mediaCapabilities[method]({ type: 'webrtc', video: { contentType, width: 1920, height: 1080, bitrate: 12000000, framerate: 60 } }), 4000, 'o navegador');
            return info.supported ? `${info.powerEfficient ? 'hw' : 'sw'}${info.smooth ? '' : '!smooth'}` : 'no';
        } catch (error) {
            return undefined;
        }
    }

    function graphicsCard() {
        try {
            const gl = document.createElement('canvas').getContext('webgl');
            const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
            let name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : '';
            // "ANGLE (AMD, AMD Radeon RX 9060 XT (0x00007590) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> the card
            if (name.startsWith('ANGLE (')) {
                name = name.slice(7, -1);
                const comma = name.indexOf(', ');
                if (comma >= 0) name = name.slice(comma + 2);
            }
            name = name.replace(/ \(0x[0-9a-fA-F]+\)/, '').replace(/ (Direct3D|OpenGL|Vulkan|Metal).*$/, '');
            return name.slice(0, 70) || undefined;
        } catch (error) {
            return undefined;
        }
    }

    // how many times a second the screen refreshes, from a second of animation frames (the page has to be visible)
    function displayHz() {
        return new Promise((resolve) => {
            if (document.visibilityState !== 'visible') return resolve(undefined);
            let frames = 0;
            const start = performance.now();
            const tick = (now) => {
                frames++;
                if (now - start >= 1000) return resolve(Math.round((frames * 1000) / (now - start)));
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            setTimeout(() => resolve(undefined), 3000);
        });
    }

    async function environment() {
        const brands = (navigator.userAgentData && navigator.userAgentData.brands ? navigator.userAgentData.brands : []).filter((b) => !/not.?a.?brand/i.test(b.brand));
        let high = {};
        try {
            high = (await withTimeout(navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture']), 3000, 'o navegador')) || {};
        } catch (error) {
            // not offered
        }
        let power;
        try {
            const battery = await withTimeout(navigator.getBattery(), 3000, 'a bateria');
            power = battery.charging ? 'na tomada' : 'bateria';
        } catch (error) {
            power = undefined;
        }
        const ratio = window.devicePixelRatio || 1;
        const main = 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d0032';
        const constrained = 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
        return {
            when: new Date().toISOString(),
            agent: navigator.userAgent.slice(0, 160),
            browser: brands.map((b) => `${b.brand} ${b.version}`).join(', ').slice(0, 80),
            os: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform,
            osVersion: high.platformVersion,
            cores: navigator.hardwareConcurrency,
            mem: navigator.deviceMemory,
            gpu: graphicsCard(),
            screen: `${screen.width}x${screen.height}@${round(ratio, 2)}`,
            nativeW: Math.round(screen.width * ratio),
            nativeH: Math.round(screen.height * ratio),
            hz: await displayHz(),
            power,
            caps: {
                vp8e: await capability('encodingInfo', 'video/VP8'),
                h264e: await capability('encodingInfo', main),
                h264cbe: await capability('encodingInfo', constrained),
                vp9e: await capability('encodingInfo', 'video/VP9'),
                av1e: await capability('encodingInfo', 'video/AV1'),
                vp8d: await capability('decodingInfo', 'video/VP8'),
                h264d: await capability('decodingInfo', main),
            },
        };
    }

    // Counts the frames the capture delivers (and the gaps between them) without doing anything with them
    function countFrames(track) {
        const counter = { frames: 0, last: 0, gaps: [], width: 0, height: 0, supported: typeof MediaStreamTrackProcessor !== 'undefined', stop: () => {} };
        if (!counter.supported) return counter;
        const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
        let stopped = false;
        counter.stop = () => {
            stopped = true;
            reader.cancel().catch(() => {});
        };
        (async () => {
            try {
                while (!stopped) {
                    const { value: frame, done } = await reader.read();
                    if (done) break;
                    const now = performance.now();
                    if (counter.last) {
                        counter.gaps.push(now - counter.last);
                        if (counter.gaps.length > 4000) counter.gaps.shift();
                    }
                    counter.last = now;
                    counter.frames++;
                    counter.width = frame.displayWidth;
                    counter.height = frame.displayHeight;
                    frame.close();
                }
            } catch (error) {
                // the track ended
            }
        })();
        return counter;
    }

    // The capture sent to itself through two connections, in the codec asked for. Returns { sample(), close() }.
    async function loopback(track, codec) {
        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {});
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {});
        // the receiving end decodes into a hidden video: what a viewer does
        const sink = document.createElement('video');
        sink.muted = true;
        sink.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
        document.body.appendChild(sink);
        pc2.ontrack = (e) => {
            sink.srcObject = e.streams[0] || new MediaStream([e.track]);
            sink.play().catch(() => {});
        };
        const close = () => {
            pc1.close();
            pc2.close();
            sink.remove();
        };
        try {
            const tx = pc1.addTransceiver(track, { direction: 'sendonly', sendEncodings: [{ maxBitrate: 12000000 }] });
            const all = RTCRtpSender.getCapabilities('video').codecs;
            const wanted = all.filter((c) => c.mimeType === 'video/' + codec.name);
            const chosen = codec.name === 'H264' ? wanted.filter((c) => h264Rank(c.sdpFmtpLine) <= 2).sort((a, b) => h264Rank(a.sdpFmtpLine) - h264Rank(b.sdpFmtpLine)) : wanted;
            if (!chosen.length) {
                close();
                return null;
            }
            tx.setCodecPreferences([...chosen, ...all.filter((c) => !chosen.includes(c))]);
            await pc1.setLocalDescription(await pc1.createOffer());
            await pc2.setRemoteDescription(pc1.localDescription);
            const answer = await pc2.createAnswer();
            // like the room: start high, or Chrome starts a call at a few hundred kbps and picks a small picture for many seconds
            let sdp = answer.sdp;
            const match = new RegExp('a=rtpmap:(\\d+) ' + codec.name + '/90000').exec(sdp);
            if (match) {
                const pt = match[1];
                const extra = 'x-google-start-bitrate=12000;x-google-min-bitrate=6000';
                const line = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
                sdp = line.test(sdp) ? sdp.replace(line, 'a=fmtp:' + pt + ' $1;' + extra) : sdp.replace('a=rtpmap:' + pt + ' ' + codec.name + '/90000\r\n', 'a=rtpmap:' + pt + ' ' + codec.name + '/90000\r\na=fmtp:' + pt + ' ' + extra + '\r\n');
            }
            await pc2.setLocalDescription({ type: 'answer', sdp });
            await pc1.setRemoteDescription(pc2.localDescription);
        } catch (error) {
            close();
            throw error;
        }
        return {
            async sample() {
                const out = {};
                for (const s of (await pc1.getStats()).values()) {
                    if (s.type === 'outbound-rtp' && s.kind === 'video') {
                        Object.assign(out, { frames: s.framesEncoded, time: s.totalEncodeTime, ts: s.timestamp, enc: s.encoderImplementation, hw: s.powerEfficientEncoder, limit: s.qualityLimitationReason, limCpu: (s.qualityLimitationDurations || {}).cpu || 0, limBw: (s.qualityLimitationDurations || {}).bandwidth || 0, w: s.frameWidth, h: s.frameHeight, bytes: s.bytesSent });
                    }
                }
                return out;
            },
            close,
        };
    }

    async function applySize(track, size) {
        const [w, h] = size;
        await withTimeout(track.applyConstraints({ width: { ideal: w, max: w }, height: { ideal: h, max: h }, frameRate: { ideal: 60, max: 60 } }), 6000, 'o navegador');
    }

    // One step: the size asked of the capture, the codec, WARMUP_S to settle and MEASURE_S of measuring
    async function runStep(track, counter, step, onTick) {
        const result = { id: step.id, label: step.label, asked: step.size, codec: step.codec.name };
        try {
            await applySize(track, step.size);
        } catch (error) {
            return { ...result, error: `o navegador não aceitou pedir ${step.size[0]}x${step.size[1]} (${error.name === 'Error' ? error.message : error.name})` };
        }
        await sleep(800);
        let link;
        try {
            link = await withTimeout(loopback(track, step.codec), 12000, 'a conexão de teste');
        } catch (error) {
            return { ...result, error: `não foi possível codificar (${error.message || error.name})` };
        }
        if (!link) return { ...result, skipped: `o navegador não oferece ${step.codec.name} assim` };
        try {
            for (let i = 0; i < WARMUP_S; i++) {
                onTick(i + 1);
                await sleep(1000);
            }
            takePressure();
            counter.gaps.length = 0;
            const f0 = counter.frames;
            const a = await withTimeout(link.sample(), 5000, 'a leitura do codificador');
            const t0 = performance.now();
            for (let i = 0; i < MEASURE_S; i++) {
                onTick(WARMUP_S + i + 1);
                await sleep(1000);
            }
            const b = await withTimeout(link.sample(), 5000, 'a leitura do codificador');
            const seconds = (performance.now() - t0) / 1000;
            const encSeconds = (b.ts - a.ts) / 1000;
            const settings = track.getSettings();
            const row = {
                ...result,
                capFps: round((counter.frames - f0) / seconds, 1),
                gapP95: round(percentile(counter.gaps, 0.95), 1),
                capW: counter.width,
                capH: counter.height,
                setW: settings.width,
                setH: settings.height,
                encFps: round((b.frames - a.frames) / encSeconds, 1),
                encMs: b.frames > a.frames ? round(((b.time - a.time) / (b.frames - a.frames)) * 1000, 1) : null,
                sentW: b.w,
                sentH: b.h,
                kbps: round(((b.bytes - a.bytes) * 8) / 1000 / encSeconds),
                enc: typeof b.enc === 'string' ? b.enc.slice(0, 40) : undefined,
                hw: typeof b.hw === 'boolean' ? b.hw : undefined,
                limit: b.limit,
                limCpuS: round(b.limCpu - a.limCpu, 1),
                limBwS: round(b.limBw - a.limBw, 1),
                press: takePressure(),
            };
            if (isStill(row)) row.still = true;
            return row;
        } finally {
            link.close();
        }
    }

    // ---- what the person sees ---------------------------------------------------------------------------------------

    function note(text, tone) {
        const box = el('note');
        box.textContent = text || '';
        box.className = tone || '';
    }

    function show(steps, env, lines) {
        el('out').hidden = false;
        const verdict = el('verdict');
        verdict.textContent = '';
        for (const line of lines) {
            const item = document.createElement('li');
            item.className = line.tone;
            item.textContent = line.text;
            verdict.appendChild(item);
        }
        const table = el('table');
        table.textContent = '';
        const head = table.insertRow();
        for (const name of ['Teste', 'Captura (fps)', 'Quadros (p95)', 'Tamanho capturado', 'Codificador (fps)', 'Enviado', 'ms/quadro', 'Codec', 'Limite']) {
            const cell = document.createElement('th');
            cell.textContent = name;
            head.appendChild(cell);
        }
        for (const s of steps) {
            const row = table.insertRow();
            const cells =
                s.skipped || s.error
                    ? [s.label, s.skipped ? `não testado: ${s.skipped}` : `erro: ${s.error}`, '', '', '', '', '', '', '']
                    : [s.label, s.capFps, `${s.gapP95} ms`, `${s.capW}x${s.capH}`, s.encFps, `${s.sentW}x${s.sentH}`, s.encMs, `${s.codec} ${s.enc || ''}${s.hw === true ? ' (hardware)' : s.hw === false ? ' (software)' : ''}`, s.still ? 'imagem parada' : s.limit];
            cells.forEach((value, index) => {
                const cell = row.insertCell();
                cell.textContent = value === undefined || value === null ? '' : String(value);
                if ((index === 1 || index === 4) && typeof value === 'number') cell.className = s.still ? 'warn' : value >= GOOD_FPS ? 'good' : value >= 30 ? 'warn' : 'bad';
            });
        }
        const text = report(steps, env, lines);
        el('report').value = text;
        el('download').href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    }

    // The full-page animation of "Medir agora": a screen that changes everywhere all the time, like a game, even when nothing else
    // is on it. Returns the function that stops it.
    function startMotion() {
        const canvas = el('motion');
        canvas.hidden = false;
        const ctx = canvas.getContext('2d');
        const resize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        resize();
        window.addEventListener('resize', resize);
        let alive = true;
        let tick = 0;
        let last = 0;
        (function draw(now) {
            if (!alive) return;
            requestAnimationFrame(draw);
            if (now - last < 15) return; // 60 a second at most: a faster screen only costs the test its own speed
            last = now;
            tick++;
            const W = canvas.width;
            const H = canvas.height;
            ctx.fillStyle = '#10141c';
            ctx.fillRect(0, 0, W, H);
            for (let i = 0; i < 24; i++) {
                ctx.fillStyle = `hsl(${(tick * 3 + i * 15) % 360} 70% ${25 + (i % 3) * 10}%)`;
                ctx.fillRect(((i * (W / 12) + tick * 9) % (W + 200)) - 200, 0, W / 14, H);
            }
        })(0);
        return () => {
            alive = false;
            canvas.hidden = true;
            window.removeEventListener('resize', resize);
        };
    }

    let running = false;
    function setBusy(busy) {
        running = busy;
        el('startNow').disabled = busy;
        el('startGame').disabled = busy;
    }

    async function start(mode) {
        if (running) return;
        setBusy(true);
        note('');
        el('out').hidden = true;
        el('steps').textContent = '';
        el('fill').style.width = '0';
        el('live').textContent = '';
        const title = document.title;
        let stream;
        let counter;
        let stopMotion = null;
        let timer = null;
        try {
            try {
                // the picker comes first: it needs the click that started this (the page measures its own environment afterwards)
                stream = await navigator.mediaDevices.getDisplayMedia({
                    video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 60, max: 60 }, displaySurface: 'monitor' },
                    audio: false,
                    selfBrowserSurface: 'exclude',
                    monitorTypeSurfaces: 'include',
                });
            } catch (error) {
                note(error && error.name === 'NotAllowedError' ? 'Você cancelou o compartilhamento. Clique de novo e escolha o que compartilhar.' : `Não foi possível capturar a tela (${error && error.name}).`, 'bad');
                return;
            }
            const track = stream.getVideoTracks()[0];
            const surface = (track.getSettings() || {}).displaySurface;
            if (surface === 'browser' && !ALLOW_TAB) {
                note('Você escolheu uma aba do Chrome. Clique de novo e escolha "Tela inteira" ou a janela do jogo.', 'bad');
                return;
            }
            if (typeof MediaStreamTrackProcessor === 'undefined') {
                note('Este navegador não deixa contar os quadros da captura (use o Chrome, o Brave ou o Opera GX).', 'bad');
                return;
            }
            track.contentHint = 'motion';
            el('stage').hidden = false;

            // what is going to be measured, as a list that fills in as the test goes
            const steps = [
                { id: 'room', label: 'Como a sala pede hoje (1080p, VP8)', size: [1920, 1080], codec: { name: 'VP8' } },
                { id: 'small', label: '720p (VP8)', size: [1280, 720], codec: { name: 'VP8' } },
            ];
            const phase = (text) => {
                el('phase').textContent = text;
            };
            const items = new Map();
            const addItem = (step) => {
                const item = document.createElement('li');
                item.textContent = `• ${step.label}`;
                el('steps').appendChild(item);
                items.set(step.id, item);
            };
            const mark = (id, cls, prefix) => {
                const item = items.get(id);
                if (!item) return;
                item.className = cls;
                item.textContent = `${prefix} ${steps.find((s) => s.id === id).label}`;
            };

            phase('Lendo as informações deste computador…');
            document.title = '⏳ Medindo… ' + title;
            let env;
            try {
                env = await withTimeout(environment(), 15000, 'a leitura do ambiente');
            } catch (error) {
                env = { when: new Date().toISOString(), partial: error.message };
            }
            env.surface = surface;
            env.mode = mode;
            watchPressure();
            counter = countFrames(track);

            if (env.nativeW && env.nativeH && env.nativeW * env.nativeH > 2100000) steps.push({ id: 'native', label: `Tamanho original (${env.nativeW}x${env.nativeH}, VP8)`, size: [env.nativeW, env.nativeH], codec: { name: 'VP8' } });
            steps.push({ id: 'h264', label: '1080p em H.264 (placa de vídeo)', size: [1920, 1080], codec: { name: 'H264' } });
            steps.forEach(addItem);
            const perStep = WARMUP_S + MEASURE_S + 2;
            const total = steps.length * perStep + (mode === 'game' ? GAME_WAIT_S : 0);
            let elapsed = 0;
            const advance = () => {
                elapsed++;
                el('fill').style.width = `${Math.min(100, (elapsed / total) * 100)}%`;
            };

            // the number of frames the capture gives, every second, while the test runs: the person sees something is happening
            let lastFrames = counter.frames;
            let lastAt = performance.now();
            timer = setInterval(() => {
                const now = performance.now();
                const fps = ((counter.frames - lastFrames) / (now - lastAt)) * 1000;
                lastFrames = counter.frames;
                lastAt = now;
                el('live').textContent = `Agora a captura entrega ${Math.round(fps)} quadros por segundo (${counter.width}x${counter.height})`;
            }, 1000);

            if (mode === 'game') {
                for (let s = GAME_WAIT_S; s > 0; s--) {
                    phase(`Abra o jogo agora: o teste começa em ${s} s…`);
                    document.title = `⏳ ${s} s para abrir o jogo`;
                    advance();
                    await sleep(1000);
                }
            } else {
                stopMotion = startMotion();
                note('');
            }

            const done = [];
            for (const step of steps) {
                mark(step.id, 'now', '⏳');
                const result = await runStep(track, counter, step, (second) => {
                    phase(`Medindo: ${step.label} (${Math.min(second, WARMUP_S + MEASURE_S)}/${WARMUP_S + MEASURE_S} s)`);
                    document.title = `⏳ ${Math.round((elapsed / total) * 100)}% ${title}`;
                    advance();
                });
                advance();
                advance();
                done.push(result);
                if (result.error || result.skipped) mark(step.id, 'fail', '✗');
                else mark(step.id, 'done', `✓ ${result.capFps} fps`);
            }
            if (stopMotion) stopMotion();
            stopMotion = null;
            phase('Pronto.');
            el('fill').style.width = '100%';
            el('live').textContent = '';
            show(done, env, describe(done, env));
            document.title = '✅ Teste de captura pronto';
            el('out').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (error) {
            note(`O teste parou: ${error && error.message ? error.message : error}`, 'bad');
            document.title = '⚠ ' + title;
        } finally {
            if (timer) clearInterval(timer);
            if (stopMotion) stopMotion();
            if (counter) counter.stop();
            if (stream) stream.getTracks().forEach((t) => t.stop());
            setBusy(false);
            if (/^⏳/.test(document.title)) document.title = title;
        }
    }

    // anything that goes wrong shows on the page: a test that stops without a word is the worst answer
    window.addEventListener('unhandledrejection', (event) => note(`Erro no teste: ${event.reason && event.reason.message ? event.reason.message : event.reason}`, 'bad'));
    window.addEventListener('error', (event) => note(`Erro no teste: ${event.message}`, 'bad'));

    document.addEventListener('DOMContentLoaded', () => {
        el('startNow').addEventListener('click', () => start('now'));
        el('startGame').addEventListener('click', () => start('game'));
        el('copy').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(el('report').value);
                el('copied').textContent = 'Copiado.';
            } catch (error) {
                el('report').select();
                el('copied').textContent = 'Selecione o texto e copie (Ctrl+C).';
            }
        });
    });
})(typeof window !== 'undefined' ? window : globalThis);
