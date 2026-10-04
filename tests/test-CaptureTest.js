'use strict';

require('should');

const { describe: describeSteps, report, percentile, h264Rank, isHardware, isStill } = require('../public/js/CaptureTest');

// What the capture test tells a person about their own computer, from the numbers it measured.
describe('test-CaptureTest (the page that measures the capture of the screen)', () => {
    const step = (id, extra) => ({ id, label: id, codec: 'VP8', capW: 1920, capH: 1080, gapP95: 20, encFps: 59, sentW: 1920, sentH: 1080, encMs: 7, enc: 'libvpx', hw: false, limit: 'none', limCpuS: 0, ...extra });
    const tones = (lines) => lines.map((l) => l.tone);
    const texts = (lines) => lines.map((l) => l.text).join('\n');

    describe('the capture', () => {
        it('a healthy computer: the capture holds 60 fps and the encoder follows', () => {
            const lines = describeSteps([step('room', { capFps: 59.5 })], { surface: 'monitor' });
            texts(lines).should.match(/captura de tela entrega 60 fps|captura de tela entrega 59 fps|entrega 6\d fps|entrega 5\d fps/);
            tones(lines).should.not.containEql('bad');
            texts(lines).should.match(/codificador acompanha/);
        });

        it('a slow capture is named as the limit, with what it costs per frame (half of the time rule)', () => {
            const lines = describeSteps([step('room', { capFps: 15.8, encFps: 15.8, encMs: 32 })], { surface: 'monitor', nativeW: 2560, nativeH: 1440 });
            tones(lines).should.containEql('bad');
            texts(lines).should.match(/só 16 fps/);
            texts(lines).should.match(/31\.6 ms por quadro/);
            texts(lines).should.match(/menos de 8 ms/);
            // the 2K screen gets the tip about the size of the screen and the game's own frame rate
            texts(lines).should.match(/2560x1440/);
            texts(lines).should.match(/53 fps numa janela de 720p, 37 em 1080p e 25 em 1440p/);
        });

        it('says which size holds 60 fps when a smaller capture does', () => {
            const lines = describeSteps([step('room', { capFps: 31.8 }), step('small', { capFps: 58, capW: 1280, capH: 720 })], { surface: 'monitor' });
            texts(lines).should.match(/1280x720 ela chega a 58 fps/);
        });

        it('says the limit is the reading of the original picture when every size gives about the same frame rate', () => {
            const lines = describeSteps([step('room', { capFps: 30 }), step('small', { capFps: 31, capW: 1280, capH: 720 })], { surface: 'monitor', nativeW: 2560, nativeH: 1440 });
            texts(lines).should.match(/quase o mesmo número de quadros \(30 a 31 fps\)/);
            texts(lines).should.match(/imagem de ORIGEM/);
            texts(lines).should.match(/Próximos testes/);
        });

        it('warns about uneven frames even when the average is high', () => {
            const lines = describeSteps([step('room', { capFps: 58, gapP95: 90 })], { surface: 'monitor' });
            texts(lines).should.match(/irregulares/);
        });

        it('says a window or a tab is not the screen', () => {
            texts(describeSteps([step('room', { capFps: 58 })], { surface: 'window' })).should.match(/uma janela/);
            texts(describeSteps([step('room', { capFps: 58 })], { surface: 'browser' })).should.match(/uma aba/);
        });

        it('says it could not measure when the first step failed', () => {
            tones(describeSteps([{ id: 'room', error: 'x' }], {})).should.deepEqual(['bad']);
            tones(describeSteps([], {})).should.deepEqual(['bad']);
        });
    });

    describe('what a person really got (the two reports of 04/10/2026, a 2560x1440 screen)', () => {
        const env = { surface: 'window', nativeW: 2560, nativeH: 1440, caps: { h264e: 'hw' }, power: 'na tomada' };
        // the page itself was shared and then hidden behind the game: after the first step the window stood still
        const parked = [
            step('room', { capFps: 30.8, gapP95: 80, capW: 1920, capH: 1050, kbps: 608 }),
            step('small', { capFps: 8.3, gapP95: 1000.7, capW: 1280, capH: 700, kbps: 58 }),
            step('native', { capFps: 1, gapP95: 1001.8, capW: 2560, capH: 1400, kbps: 151 }),
            step('h264', { codec: 'H264', capFps: 0.9, gapP95: 1601.9, capW: 1920, capH: 1050, kbps: 6674, enc: 'MediaFoundationVideoEncodeAccelerator (A', hw: true }),
        ];
        // the window of the game, with the game running
        const game = [
            step('room', { capFps: 35.6, gapP95: 34.9, capW: 1920, capH: 1080, encFps: 35.4, encMs: 7.8, kbps: 8165 }),
            step('small', { capFps: 33.5, gapP95: 37.6, capW: 1280, capH: 720, encFps: 33.4, encMs: 7.5, kbps: 7668, press: 'fair' }),
            step('native', { capFps: 33.2, gapP95: 41.2, capW: 2560, capH: 1440, encFps: 32.9, encMs: 10.8, sentW: 1920, kbps: 8310, limit: 'bandwidth', press: 'fair' }),
            step('h264', { codec: 'H264', capFps: 26.1, gapP95: 54.3, capW: 1920, capH: 1080, encFps: 26, encMs: 14.4, kbps: 10930, enc: 'MediaFoundationVideoEncodeAccelerator (A', hw: true, press: 'serious' }),
        ];

        it('knows a window that stood still: a keep-alive of a frame or two a second, even when a hardware encoder spent 6.7 Mbps on it', () => {
            isStill(parked[1]).should.be.true(); // 8.3 fps, 58 kbps, gaps of 1 s
            isStill(parked[2]).should.be.true();
            isStill(parked[3]).should.be.true(); // 0.9 fps whatever the bitrate
            isStill(parked[0]).should.be.false(); // 30.8 fps
            isStill(game[3]).should.be.false();
            isStill({ capFps: 5, kbps: 5000, gapP95: 300 }).should.be.false(); // a slow capture of a moving picture is not a still one
            isStill(null).should.be.false();
        });

        it('does not draw conclusions from the steps of a window that stood still', () => {
            const lines = describeSteps(parked, env);
            texts(lines).should.match(/praticamente não mudou/);
            // not "a smaller size changes nothing", not "the card encoder sent 1 fps", not "the processor"
            texts(lines).should.not.match(/quase o mesmo número|quase não muda/);
            texts(lines).should.not.match(/H\.264 da placa de vídeo está disponível/);
            // but what the card's encoder did with the still picture is worth saying: 6.7 Mbps for a frame a second, against 151 kbps of the VP8
            texts(lines).should.match(/Com a imagem parada o codificador da placa de vídeo mandou 6674 kbps \(o VP8 mandou 58\)/);
        });

        it('says what the game window shows: the same frame rate at every size, so the limit is the reading of the original picture', () => {
            const lines = describeSteps(game, env);
            texts(lines).should.match(/só 36 fps/);
            texts(lines).should.match(/quase o mesmo número de quadros \(33 a 36 fps\)/);
            texts(lines).should.match(/imagem de origem \(2560x1440\)/);
            texts(lines).should.match(/Pedir uma captura menor não ajuda/);
            texts(lines).should.match(/uma janela/);
            // the encoder follows what the capture gives
            texts(lines).should.match(/O codificador acompanha a captura: 35 fps em 1920x1080/);
            // the card's encoder step had a slower capture of its own: the comparison with VP8 is not fair
            texts(lines).should.match(/captura desse passo também foi diferente \(26 fps\)/);
            texts(lines).should.match(/sob pressão \("serious"\)/);
        });
    });

    describe('the encoder and the PC', () => {
        it('names an encoder that does not follow a capture that does', () => {
            const lines = describeSteps([step('room', { capFps: 59, encFps: 33, encMs: 28 })], { surface: 'monitor' });
            texts(lines).should.match(/O codificador não acompanha: a captura deu 59 fps e saíram só 33/);
            tones(lines).should.containEql('bad');
        });

        it('reports the graphics card encoder when Chrome used it, with what the software one did', () => {
            const lines = describeSteps([step('room', { capFps: 59, encFps: 55 }), step('h264', { codec: 'H264', capFps: 59, encFps: 59.8, enc: 'ExternalEncoder', hw: true })], { surface: 'monitor' });
            texts(lines).should.match(/H\.264 da placa de vídeo está disponível \(ExternalEncoder\) e mandou 60 fps/);
            texts(lines).should.match(/VP8 por software mandou 55 fps/);
        });

        it('falls back to what the browser says it can do when it does not say which encoder it used', () => {
            const unnamed = step('h264', { codec: 'H264', capFps: 59, encFps: 59.5, enc: undefined, hw: undefined });
            texts(describeSteps([step('room', { capFps: 59 }), unnamed], { surface: 'monitor', caps: { h264e: 'hw' } })).should.match(/segundo o navegador\) e mandou 60 fps/);
            texts(describeSteps([step('room', { capFps: 59 }), unnamed], { surface: 'monitor', caps: { h264e: 'sw' } })).should.match(/não diz se foi pela placa/);
            texts(describeSteps([step('room', { capFps: 59 }), unnamed], { surface: 'monitor' })).should.match(/não diz se foi pela placa/);
        });

        it('says so when Chrome kept H.264 in software, and when it does not offer a good profile at all', () => {
            texts(describeSteps([step('room', { capFps: 59 }), step('h264', { codec: 'H264', capFps: 59, enc: 'OpenH264', hw: false })], { surface: 'monitor' })).should.match(/ficou por software/);
            texts(describeSteps([step('room', { capFps: 59 }), { id: 'h264', label: 'h264', skipped: 'sem perfil' }], { surface: 'monitor' })).should.match(/não oferece H\.264/);
        });

        it('reports a busy processor and a computer on battery', () => {
            const lines = describeSteps([step('room', { capFps: 59, press: 'serious' })], { surface: 'monitor', power: 'bateria' });
            texts(lines).should.match(/sob pressão \("serious"\)/);
            texts(lines).should.match(/na bateria/);
        });

        it('reports what the browser says limited the picture', () => {
            texts(describeSteps([step('room', { capFps: 59, limCpuS: 4.2 })], { surface: 'monitor' })).should.match(/processador limitou a imagem por 4\.2 s/);
        });
    });

    describe('the report that is copied', () => {
        it('has the numbers of each step, the verdict and the whole data in one JSON line', () => {
            const steps = [step('room', { label: 'Sala', capFps: 31.8, encFps: 31.7, press: 'fair' }), { id: 'h264', label: 'H.264', skipped: 'sem perfil' }];
            const env = { when: '2026-10-03T22:00:00Z', browser: 'Chromium 154', os: 'Windows', cores: 12, mem: 32, gpu: 'AMD Radeon RX 9060 XT', screen: '2560x1440@1', nativeW: 2560, nativeH: 1440, hz: 180, power: 'na tomada', surface: 'monitor', caps: { vp8e: 'sw', h264e: 'hw' } };
            const text = report(steps, env, describeSteps(steps, env));
            text.should.match(/Placa de vídeo: AMD Radeon RX 9060 XT \| tela 2560x1440@1 \(original 2560x1440\) a 180 Hz/);
            text.should.match(/- Sala: captura 31\.8 fps em 1920x1080/);
            text.should.match(/- H\.264: não testado \(sem perfil\)/);
            text.should.match(/Codificar: vp8e=sw h264e=hw/);
            const json = JSON.parse(text.split('\n').find((l) => l.startsWith('JSON: ')).slice(6));
            json.v.should.equal(2);
            json.steps[0].capFps.should.equal(31.8);
            json.env.gpu.should.equal('AMD Radeon RX 9060 XT');
        });
    });

    describe('helpers', () => {
        it('percentile of a list of gaps', () => {
            (percentile([], 0.95) === null).should.be.true();
            percentile([5, 1, 9, 3], 0.5).should.equal(5);
            percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95).should.equal(96);
            percentile([7], 0.95).should.equal(7);
        });
        it('ranks H.264 entries the way the room does: Main, High, Baseline, Constrained Baseline', () => {
            h264Rank('level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f').should.equal(0);
            h264Rank('profile-level-id=640032').should.equal(1);
            h264Rank('profile-level-id=42001f').should.equal(2);
            h264Rank('profile-level-id=42e01f').should.equal(3);
            h264Rank('').should.equal(4);
        });
        it('knows a hardware encoder by the browser word or by its name', () => {
            isHardware({ hw: true }).should.be.true();
            isHardware({ hw: false, enc: 'ExternalEncoder' }).should.be.false();
            isHardware({ enc: 'ExternalEncoder' }).should.be.true();
            isHardware({ enc: 'libvpx, fallback from D3D11VideoEncoder' }).should.be.false();
        });
    });
});
