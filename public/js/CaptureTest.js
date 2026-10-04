'use strict';

/*
 * The capture test (views/CaptureTest.html, served at /capture-test): what THIS computer does when it shares its screen,
 * measured here, with the person's own screen, and nothing leaves the page.
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

    // ---- what the numbers say --------------------------------------------------------------------------------------

    // steps: [{ id: 'room' | 'small' | 'native' | 'h264', asked: [w, h], codec, capFps, gapP95, capW, capH, encFps, encMs,
    //           sentW, sentH, kbps, enc, hw, limit, limCpuS, limBwS, press, skipped, error }]
    // env: { surface, cores, gpu, hz, power, ... }. Returns [{ tone: 'good' | 'warn' | 'bad' | 'info', text }]
    function describe(steps, env = {}) {
        const out = [];
        const say = (tone, text) => out.push({ tone, text });
        const usable = (id) => (steps || []).find((s) => s.id === id && !s.error && !s.skipped && typeof s.capFps === 'number');
        const room = usable('room');
        const small = usable('small');
        const native = usable('native');
        const hardware = usable('h264');

        if (env.surface && env.surface !== 'monitor') {
            say('warn', `Você compartilhou ${env.surface === 'window' ? 'uma janela' : 'uma aba'}, não a tela inteira: o resultado vale para ela, não para o jogo em tela cheia. Refaça escolhendo "Tela inteira".`);
        }
        if (!room) {
            say('bad', 'O teste não conseguiu medir a captura no tamanho que a sala pede.');
            return out;
        }

        // the capture
        const perFrame = round(500 / Math.max(room.capFps, 0.1), 1);
        if (room.capFps >= GOOD_FPS) {
            say('good', `A captura de tela entrega ${round(room.capFps)} fps no tamanho que a sala pede (1080p): aqui a captura não é o limite.`);
        } else {
            say('bad', `A captura de tela entregou só ${round(room.capFps)} fps no tamanho que a sala pede (1080p). É o limite: nada que vem depois (codificador, internet, servidor) devolve quadros que a captura não deu. O Chrome gasta uns ${perFrame} ms por quadro e só pode usar metade do tempo; para 60 fps o quadro teria de levar menos de 8 ms.`);
            const better = [small, native].filter((s) => s && s.capFps >= GOOD_FPS).sort((a, b) => b.capW * b.capH - a.capW * a.capH)[0];
            if (better) {
                say('good', `Pedindo a captura em ${better.capW}x${better.capH} ela chega a ${round(better.capFps)} fps: esse é o tamanho que segura 60 fps neste computador.`);
            } else if (small && small.capFps > room.capFps * 1.15) {
                say('warn', `Em ${small.capW}x${small.capH} a captura sobe para ${round(small.capFps)} fps (de ${round(room.capFps)}), mas ainda não chega a 60.`);
            } else if (small) {
                say('warn', `Pedir um tamanho menor (${small.capW}x${small.capH}) quase não muda a captura (${round(small.capFps)} fps): o custo está em ler a tela inteira, não no tamanho pedido.`);
            }
            if (env.nativeW && env.nativeH && env.nativeW * env.nativeH > 2100000) {
                say('info', `Sua tela é ${env.nativeW}x${env.nativeH}: o navegador lê todos esses pontos a cada quadro. Jogar (ou compartilhar) em 1920x1080 costuma dar 60 fps de captura. Limitar os fps do jogo a ~60 também deixa a placa de vídeo livre para a captura.`);
            }
        }
        if (native && native !== room && native.capFps < room.capFps * 0.8) {
            say('info', `No tamanho original da tela (${native.capW}x${native.capH}) a captura entrega ${round(native.capFps)} fps.`);
        }
        const gappy = [room, small, native].filter((s) => s && s.capFps >= 30 && s.gapP95 > 3000 / Math.max(s.capFps, 1)).length;
        if (gappy) say('warn', 'Os quadros da captura chegam irregulares (alguns intervalos bem maiores que a média): dá tranco mesmo com fps médio alto.');

        // the encoder
        const slowEncoder = [room, small].filter((s) => s && s.capFps >= GOOD_FPS && typeof s.encFps === 'number' && s.encFps < s.capFps * 0.9);
        if (slowEncoder.length) {
            const s = slowEncoder[0];
            say('bad', `O codificador não acompanha: a captura deu ${round(s.capFps)} fps e saíram só ${round(s.encFps)} (${s.enc || 'codificador por software'}, ${round(s.encMs, 1)} ms por quadro).`);
        } else if (room.encFps >= GOOD_FPS) {
            // VP8, VP9 and AV1 are software in Chrome on a PC; for H.264 it is only said when the browser says
            const kind = room.codec !== 'H264' || room.hw === false ? 'software' : isHardware(room) ? 'hardware' : null;
            say('good', `O codificador acompanha: ${round(room.encFps)} fps em ${room.sentW}x${room.sentH} (${room.codec}${kind ? ', ' + kind : ''}${room.enc ? ', ' + room.enc : ''}).`);
        }
        if (room.limCpuS >= 2) say('warn', `O navegador disse que o processador limitou a imagem por ${round(room.limCpuS, 1)} s.`);

        // the graphics card's encoder: the browser says which encoder it used only to some pages, so where it does not, the
        // answer of mediaCapabilities for the Main profile stands in for it
        if (hardware) {
            const named = hardware.hw !== undefined || Boolean(hardware.enc);
            const hw = named ? isHardware(hardware) : /^hw/.test((env.caps && env.caps.h264e) || '') ? true : undefined;
            if (hw === true) {
                const vs = room.encFps ? ` (o VP8 por software mandou ${round(room.encFps)} fps)` : '';
                say('good', `O codificador H.264 da placa de vídeo está disponível (${named ? hardware.enc || 'hardware' : 'segundo o navegador'}) e mandou ${round(hardware.encFps)} fps em ${hardware.sentW}x${hardware.sentH}${vs}. Ele não gasta o processador que o jogo usa.`);
            } else if (hw === false) {
                say('warn', 'O navegador não usou o codificador da placa de vídeo para H.264 (ficou por software): aqui o VP8 é a melhor escolha.');
            } else {
                say('info', `O H.264 mandou ${round(hardware.encFps)} fps em ${hardware.sentW}x${hardware.sentH}; o navegador não diz se foi pela placa de vídeo.`);
            }
        } else if ((steps || []).some((s) => s.id === 'h264' && s.skipped)) {
            say('warn', 'Este navegador não oferece H.264 em um perfil que a placa de vídeo codifique.');
        }

        // the PC
        const worst = (steps || []).map((s) => s.press).filter(Boolean).sort((a, b) => ['nominal', 'fair', 'serious', 'critical'].indexOf(b) - ['nominal', 'fair', 'serious', 'critical'].indexOf(a))[0];
        if (worst === 'serious' || worst === 'critical') say('warn', `O processador do computador ficou sob pressão ("${worst}") durante o teste: algum programa (o jogo?) usa boa parte dele.`);
        if (env.power === 'bateria') say('warn', 'O computador está na bateria: o Windows e o Chrome economizam energia e a captura costuma cair. Ligue na tomada e refaça.');
        return out;
    }

    // The text that is copied: short, readable, with the whole data in one JSON line at the end
    function report(steps, env, lines) {
        const rows = (steps || []).map((s) => {
            if (s.skipped) return `- ${s.label}: não testado (${s.skipped})`;
            if (s.error) return `- ${s.label}: erro (${s.error})`;
            return `- ${s.label}: captura ${round(s.capFps, 1)} fps em ${s.capW}x${s.capH} (p95 entre quadros ${round(s.gapP95)} ms) | codificador ${round(s.encFps, 1)} fps em ${s.sentW}x${s.sentH}, ${round(s.encMs, 1)} ms/quadro, ${s.codec} ${s.enc || '?'}${s.hw === true ? ' (hardware)' : s.hw === false ? ' (software)' : ''}, limite: ${s.limit || '?'}${s.press ? ', pressão do processador: ' + s.press : ''}`;
        });
        const e = env || {};
        const head = [
            `Teste de captura (${e.when || ''})`,
            `Navegador: ${e.browser || e.agent || '?'} | ${e.os || '?'} ${e.osVersion || ''} | ${e.cores || '?'} processadores lógicos, ${e.mem || '?'} GB`,
            `Placa de vídeo: ${e.gpu || '?'} | tela ${e.screen || '?'} (original ${e.nativeW || '?'}x${e.nativeH || '?'}) a ${e.hz || '?'} Hz | ${e.power || '?'} | compartilhado: ${e.surface || '?'}`,
            `Codificar: ${Object.entries(e.caps || {}).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        ];
        const verdict = (lines || []).map((l) => `* ${l.text}`);
        return [...head, '', ...rows, '', ...verdict, '', 'JSON: ' + JSON.stringify({ v: 1, env: e, steps })].join('\n');
    }

    const api = { describe, report, percentile, round, h264Rank, isHardware, GOOD_FPS, TARGET_FPS };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
        return;
    }
    root.CaptureTest = api;
    if (typeof document === 'undefined') return;

    // ---- in the browser --------------------------------------------------------------------------------------------

    const WARMUP_S = 4;
    const MEASURE_S = 10;
    const PRESSURE_STATES = ['nominal', 'fair', 'serious', 'critical'];
    const el = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
            const info = await navigator.mediaCapabilities[method]({ type: 'webrtc', video: { contentType, width: 1920, height: 1080, bitrate: 12000000, framerate: 60 } });
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
            high = (await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture'])) || {};
        } catch (error) {
            // not offered
        }
        let power;
        try {
            const battery = await navigator.getBattery();
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
        const tx = pc1.addTransceiver(track, { direction: 'sendonly', sendEncodings: [{ maxBitrate: 12000000 }] });
        const all = RTCRtpSender.getCapabilities('video').codecs;
        const wanted = all.filter((c) => c.mimeType === 'video/' + codec.name);
        const chosen = codec.name === 'H264' ? wanted.filter((c) => h264Rank(c.sdpFmtpLine) <= 2).sort((a, b) => h264Rank(a.sdpFmtpLine) - h264Rank(b.sdpFmtpLine)) : wanted;
        if (!chosen.length) {
            pc1.close();
            pc2.close();
            sink.remove();
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
            close() {
                pc1.close();
                pc2.close();
                sink.remove();
            },
        };
    }

    async function applySize(track, size) {
        const [w, h] = size;
        await track.applyConstraints({ width: { ideal: w, max: w }, height: { ideal: h, max: h }, frameRate: { ideal: 60, max: 60 } });
    }

    // One step: the size asked of the capture, the codec, WARMUP_S to settle and MEASURE_S of measuring
    async function runStep(track, counter, step, onTick) {
        const result = { id: step.id, label: step.label, asked: step.size, codec: step.codec.name };
        try {
            await applySize(track, step.size);
        } catch (error) {
            return { ...result, error: `o navegador não aceitou pedir ${step.size[0]}x${step.size[1]} (${error.name})` };
        }
        await sleep(800);
        const link = await loopback(track, step.codec);
        if (!link) return { ...result, skipped: `o navegador não oferece ${step.codec.name} assim` };
        try {
            for (let i = 0; i < WARMUP_S; i++) {
                onTick(i + 1);
                await sleep(1000);
            }
            takePressure();
            counter.gaps.length = 0;
            const f0 = counter.frames;
            const a = await link.sample();
            const t0 = performance.now();
            for (let i = 0; i < MEASURE_S; i++) {
                onTick(WARMUP_S + i + 1);
                await sleep(1000);
            }
            const b = await link.sample();
            const seconds = (performance.now() - t0) / 1000;
            const encSeconds = (b.ts - a.ts) / 1000;
            const settings = track.getSettings();
            return {
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
        } finally {
            link.close();
        }
    }

    function show(steps, env, lines) {
        el('out').style.display = '';
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
            const cells = s.skipped || s.error
                ? [s.label, s.skipped ? `não testado: ${s.skipped}` : `erro: ${s.error}`, '', '', '', '', '', '', '']
                : [s.label, s.capFps, `${s.gapP95} ms`, `${s.capW}x${s.capH}`, s.encFps, `${s.sentW}x${s.sentH}`, s.encMs, `${s.codec} ${s.enc || ''}${s.hw === true ? ' (hardware)' : s.hw === false ? ' (software)' : ''}`, s.limit];
            cells.forEach((value, index) => {
                const cell = row.insertCell();
                cell.textContent = value === undefined || value === null ? '' : String(value);
                if (index === 1 && typeof value === 'number') cell.className = value >= GOOD_FPS ? 'good' : value >= 30 ? 'warn' : 'bad';
                if (index === 4 && typeof value === 'number') cell.className = value >= GOOD_FPS ? 'good' : value >= 30 ? 'warn' : 'bad';
            });
        }
        el('report').value = report(steps, env, lines);
    }

    let running = false;
    async function start() {
        if (running) return;
        running = true;
        el('start').disabled = true;
        el('note').textContent = '';
        el('out').style.display = 'none';
        let stream;
        let counter;
        try {
            const gameMode = el('game').checked;
            try {
                // the picker comes first: it needs the click that started this (the page measures its own environment afterwards)
                stream = await navigator.mediaDevices.getDisplayMedia({
                    video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 60, max: 60 } },
                    audio: false,
                });
            } catch (error) {
                el('note').textContent = error && error.name === 'NotAllowedError' ? 'Você cancelou o compartilhamento.' : `Não foi possível capturar a tela (${error && error.name}).`;
                return;
            }
            const track = stream.getVideoTracks()[0];
            track.contentHint = 'motion';
            const env = await environment();
            env.surface = (track.getSettings() || {}).displaySurface;
            if (typeof MediaStreamTrackProcessor === 'undefined') {
                el('note').textContent = 'Este navegador não deixa contar os quadros da captura (use o Chrome, o Brave ou o Opera GX).';
                return;
            }
            el('stage').style.display = '';
            watchPressure();
            counter = countFrames(track);

            const steps = [{ id: 'room', label: 'Como a sala pede hoje (1080p, VP8)', size: [1920, 1080], codec: { name: 'VP8' } }, { id: 'small', label: '720p (VP8)', size: [1280, 720], codec: { name: 'VP8' } }];
            if (env.nativeW * env.nativeH > 2100000) steps.push({ id: 'native', label: `Tamanho original da tela (${env.nativeW}x${env.nativeH}, VP8)`, size: [env.nativeW, env.nativeH], codec: { name: 'VP8' } });
            steps.push({ id: 'h264', label: '1080p em H.264 (placa de vídeo)', size: [1920, 1080], codec: { name: 'H264' } });
            const total = steps.length * (WARMUP_S + MEASURE_S + 1) + (gameMode ? 15 : 0);

            // the dot that keeps the screen changing while the page is the thing on the screen
            let dance = true;
            (function move(now) {
                if (!dance) return;
                el('dot').style.left = `${(Math.sin(now / 500) * 0.5 + 0.5) * (el('dance').clientWidth - 40)}px`;
                requestAnimationFrame(move);
            })(0);

            let elapsed = 0;
            const progress = (text) => {
                el('phase').innerHTML = '';
                const b = document.createElement('b');
                b.textContent = text;
                el('phase').appendChild(b);
                el('fill').style.width = `${Math.min(100, (elapsed / total) * 100)}%`;
            };
            if (gameMode) {
                for (let s = 15; s > 0; s--) {
                    progress(`Abra o jogo agora: o teste começa em ${s} s…`);
                    elapsed++;
                    await sleep(1000);
                }
            }
            const done = [];
            for (const step of steps) {
                const result = await runStep(track, counter, step, () => {
                    elapsed++;
                    progress(`Medindo: ${step.label}`);
                });
                done.push(result);
                elapsed++;
            }
            dance = false;
            progress('Pronto.');
            el('fill').style.width = '100%';
            show(done, env, describe(done, env));
        } catch (error) {
            el('note').textContent = `O teste parou: ${error && error.message}`;
        } finally {
            if (counter) counter.stop();
            if (stream) stream.getTracks().forEach((t) => t.stop());
            running = false;
            el('start').disabled = false;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        el('start').addEventListener('click', start);
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
