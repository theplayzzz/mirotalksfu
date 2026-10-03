'use strict';

require('should');

const L = require('../public/js/ReplayLogic');

describe('test-ReplayUi', () => {
    describe('time and text', () => {
        it('formats a clock as m:ss, and h:mm:ss from an hour on', () => {
            L.formatClock(0).should.equal('0:00');
            L.formatClock(5.9).should.equal('0:05');
            L.formatClock(61).should.equal('1:01');
            L.formatClock(599.99).should.equal('9:59');
            L.formatClock(3600).should.equal('1:00:00');
            L.formatClock(3725).should.equal('1:02:05');
        });

        it('never shows a negative or broken clock', () => {
            for (const bad of [-5, NaN, Infinity, undefined, null, '12', {}]) L.formatClock(bad).should.equal('0:00');
        });

        it('names the options', () => {
            L.optionLabel(60).should.equal('1 min');
            L.optionLabel(120).should.equal('2 min');
            L.optionLabel(300).should.equal('5 min');
            L.optionLabel(90).should.equal('1 min 30 s');
            L.optionLabel(45).should.equal('45 s');
        });

        it('says how long ago a clip was made', () => {
            L.formatAgo(0).should.equal('agora mesmo');
            L.formatAgo(30 * 1000).should.equal('agora mesmo');
            L.formatAgo(60 * 1000).should.equal('há 1 min');
            L.formatAgo(5 * 60 * 1000).should.equal('há 5 min');
            L.formatAgo(59 * 60 * 1000).should.equal('há 59 min');
            L.formatAgo(2.5 * 3600 * 1000).should.equal('há 2 h');
            L.formatAgo(26 * 3600 * 1000).should.equal('há 1 d');
            L.formatAgo(3 * 24 * 3600 * 1000).should.equal('há 3 d');
            L.formatAgo(-1000).should.equal('agora mesmo');
        });

        it('says how long is left before a clip expires, rounding down', () => {
            L.formatLeft(0).should.equal('expirado');
            L.formatLeft(-5).should.equal('expirado');
            L.formatLeft(NaN).should.equal('expirado');
            L.formatLeft(20 * 1000).should.equal('expira em instantes');
            L.formatLeft(20 * 60 * 1000 + 59000).should.equal('expira em 20 min');
            L.formatLeft(5.9 * 3600 * 1000).should.equal('expira em 5 h');
            L.formatLeft(47 * 3600 * 1000).should.equal('expira em 47 h');
            L.formatLeft((6 * 24 + 23) * 3600 * 1000).should.equal('expira em 6 d');
        });

        it('rounds the time left so it does not flicker', () => {
            L.etaText(2).should.equal('menos de 5 s');
            L.etaText(7).should.equal('cerca de 7 s');
            L.etaText(24).should.equal('cerca de 25 s');
            L.etaText(23.2).should.equal('cerca de 25 s');
            L.etaText(57).should.equal('cerca de 55 s');
            L.etaText(58).should.equal('cerca de 1 min');
            L.etaText(95).should.equal('cerca de 1 min 40 s');
            L.etaText(130).should.equal('cerca de 2 min 10 s');
            L.etaText(240).should.equal('cerca de 4 min');
            L.etaText(900).should.equal('cerca de 15 min');
            L.etaText(4500).should.equal('cerca de 1 h 15 min');
            L.etaText(-1).should.equal('');
            L.etaText(NaN).should.equal('');
            L.etaText(undefined).should.equal('');
        });

        it('formats sizes the Brazilian way', () => {
            L.formatBytes(0).should.equal('0 B');
            L.formatBytes(512).should.equal('512 B');
            L.formatBytes(1536).should.equal('2 KB');
            L.formatBytes(3.25 * 1024 * 1024).should.equal('3,3 MB');
            L.formatBytes(4 * 1024 * 1024).should.equal('4 MB');
            L.formatBytes(88123456).should.equal('84 MB');
            L.formatBytes(1.5 * 1024 * 1024 * 1024).should.equal('1,5 GB');
            L.formatBytes(-1).should.equal('');
            L.formatBytes(NaN).should.equal('');
        });
    });

    describe('which options the room offers', () => {
        const base = { options: [60, 120, 180, 300], maxSeconds: 300 };

        it('turns off the options longer than what the buffer holds, with the hint', () => {
            const list = L.optionsAvailability({ ...base, bufferSeconds: 150 });
            list.map((o) => [o.seconds, o.label, o.enabled]).should.deepEqual([
                [60, '1 min', true],
                [120, '2 min', true],
                [180, '3 min', false],
                [300, '5 min', false],
            ]);
            list[0].hint.should.equal('');
            list[2].hint.should.equal('a tela começou há 2:30');
            list[3].hint.should.equal('a tela começou há 2:30');
        });

        it('turns everything off while the buffer is shorter than the shortest option', () => {
            const list = L.optionsAvailability({ ...base, bufferSeconds: 42 });
            list.every((o) => o.enabled === false).should.be.true();
            list[0].hint.should.equal('a tela começou há 0:42');
        });

        it('turns an option on exactly when the buffer reaches it', () => {
            L.optionsAvailability({ ...base, bufferSeconds: 119.2 })[1].enabled.should.be.false();
            L.optionsAvailability({ ...base, bufferSeconds: 119.6 })[1].enabled.should.be.true();
            L.optionsAvailability({ ...base, bufferSeconds: 120 })[1].enabled.should.be.true();
        });

        it('turns everything on once the buffer is full, even if it keeps more than the limit', () => {
            L.optionsAvailability({ ...base, bufferSeconds: 300 })
                .every((o) => o.enabled)
                .should.be.true();
            L.optionsAvailability({ ...base, bufferSeconds: 390 })
                .every((o) => o.enabled)
                .should.be.true();
            L.availableSeconds(390, 300).should.equal(300);
        });

        it('drops the options above the server limit and sorts the rest', () => {
            const list = L.optionsAvailability({ options: [300, 60, 600, 120], maxSeconds: 180, bufferSeconds: 500 });
            list.map((o) => o.seconds).should.deepEqual([60, 120]);
        });

        it('copes with a missing buffer or options', () => {
            L.optionsAvailability({ options: [60], maxSeconds: 300 })[0].enabled.should.be.false();
            L.optionsAvailability({ options: [60], maxSeconds: 300, bufferSeconds: NaN })[0].enabled.should.be.false();
            L.optionsAvailability({ maxSeconds: 300, bufferSeconds: 100 }).should.deepEqual([]);
            L.optionsAvailability({ options: 'x', bufferSeconds: 100 }).should.deepEqual([]);
            L.availableSeconds(-4, 300).should.equal(0);
            L.availableSeconds(undefined, 300).should.equal(0);
        });
    });

    describe('the MP4 button', () => {
        it('shows the real percentage and the time left while it converts', () => {
            L.mp4Status({ state: 'running', progress: 0.58, etaSeconds: 24 }).should.deepEqual({
                phase: 'running',
                percent: 58,
                title: 'Convertendo para MP4…',
                detail: '58% · cerca de 25 s',
                text: 'Convertendo para MP4… 58% · cerca de 25 s',
            });
        });

        it('does not claim a percentage before there is one', () => {
            L.mp4Status({ state: 'running', progress: 0, etaSeconds: 30 }).text.should.equal('Convertendo para MP4…');
            L.mp4Status({ state: 'running' }).text.should.equal('Convertendo para MP4…');
        });

        it('skips the time when the server has no estimate yet', () => {
            L.mp4Status({ state: 'running', progress: 0.1 }).text.should.equal('Convertendo para MP4… 10%');
        });

        it('splits the sentence in two lines for the button', () => {
            const status = L.mp4Status({ state: 'running', progress: 0.3, etaSeconds: 40 });
            status.title.should.equal('Convertendo para MP4…');
            status.detail.should.equal('30% · cerca de 40 s');
            L.mp4Status({ state: 'queued', ahead: 1 }).title.should.equal('Na fila — 1 conversão na frente');
            L.mp4Status({ state: 'queued', ahead: 1 }).detail.should.equal('');
        });

        it('never shows 100% before it is ready, nor a percentage out of range', () => {
            L.mp4Status({ state: 'running', progress: 1, etaSeconds: 0 }).percent.should.equal(99);
            L.mp4Status({ state: 'running', progress: -3 }).percent.should.equal(0);
            L.mp4Status({ state: 'running', progress: 7 }).percent.should.equal(99);
        });

        it('says how many conversions are ahead in the queue', () => {
            L.mp4Status({ state: 'queued', ahead: 1 }).text.should.equal('Na fila — 1 conversão na frente');
            L.mp4Status({ state: 'queued', ahead: 3 }).text.should.equal('Na fila — 3 conversões na frente');
            L.mp4Status({ state: 'queued', ahead: 0 }).text.should.equal('Na fila — começa em instantes');
            L.mp4Status({ state: 'queued' }).text.should.equal('Na fila — aguardando a vez');
            L.mp4Status({ state: 'queued', ahead: 1 }).phase.should.equal('queued');
        });

        it('knows ready, error and idle', () => {
            L.mp4Status({ state: 'ready' }).should.deepEqual({
                phase: 'ready',
                percent: 100,
                title: 'MP4 pronto',
                detail: '',
                text: 'MP4 pronto',
            });
            L.mp4Status({ state: 'error' }).phase.should.equal('error');
            L.mp4Status(null).phase.should.equal('idle');
            L.mp4Status({}).text.should.equal('Baixar MP4');
        });

        it('estimates the conversion before it starts, from the clip and from the last speed seen', () => {
            L.estimateMp4Seconds(60).should.equal(24);
            L.estimateMp4Seconds(60, 0.25).should.equal(15);
            L.estimateMp4Seconds(1).should.equal(3);
            L.estimateMp4Seconds(0).should.equal(3);
            L.estimateMp4Seconds(NaN, NaN).should.equal(3);
            L.estimateText(25).should.equal('leva ~25 s');
            L.estimateText(24).should.equal('leva ~25 s');
            L.estimateText(95).should.equal('leva ~1 min 40 s');
            L.estimateText(3).should.equal('leva ~3 s');
            L.estimateText(NaN).should.equal('');
        });

        it('learns the speed slowly and ignores nonsense', () => {
            L.learnRatio(undefined, 30, 60).should.equal(0.5);
            L.learnRatio(0.4, 30, 60).should.equal(0.44);
            L.learnRatio(0.4, 0, 60).should.equal(0.4);
            L.learnRatio(0.4, 30, 0).should.equal(0.4);
            L.learnRatio(0.4, 9999, 60).should.be.below(2);
        });
    });

    describe('the clip list', () => {
        const clips = [
            { id: 'aaaaaaaa-1', createdAt: 1000, sharer: 'Beltrano', requestedBy: 'Fulano', mine: true },
            { id: 'aaaaaaaa-2', createdAt: 3000, sharer: 'Ciclano', requestedBy: 'Beltrano', mine: false },
            { id: 'aaaaaaaa-3', createdAt: 2000, sharer: 'Ciclano', requestedBy: 'Fulano' },
        ];

        it('validates clip ids like the server does', () => {
            L.isClipId('20261003-141502-3f9a2c1b-x7k2').should.be.true();
            L.isClipId('abcdefgh').should.be.true();
            for (const bad of [
                'short',
                'UPPERCASE-ID',
                'has space in it',
                '../../etc/passwd',
                'a'.repeat(65),
                '',
                null,
                12345678,
            ]) {
                L.isClipId(bad).should.be.false();
            }
        });

        it('builds media and gallery links only from valid parts', () => {
            L.mediaUrl('abcdefgh-1', 'clip.webm').should.equal('/replay/media/abcdefgh-1/clip.webm');
            L.mediaUrl('abcdefgh-1', 'clip.mp4', true).should.equal('/replay/media/abcdefgh-1/clip.mp4?download=1');
            L.mediaUrl('abcdefgh-1', '../meta.json').should.equal('');
            L.mediaUrl('bad id', 'clip.webm').should.equal('');
            L.galleryUrl({ clip: 'abcdefgh-1', fromRoom: true }).should.equal('/replay/?clip=abcdefgh-1&from=room');
            L.galleryUrl({ fromRoom: true }).should.equal('/replay/?from=room');
            L.galleryUrl({ clip: 'abcdefgh-1' }).should.equal('/replay/?clip=abcdefgh-1');
            L.galleryUrl({ clip: '"><script>', fromRoom: true }).should.equal('/replay/?from=room');
            L.galleryUrl().should.equal('/replay/');
        });

        it('keeps the newest first when clips arrive', () => {
            L.sortNewestFirst(clips)
                .map((c) => c.id)
                .should.deepEqual(['aaaaaaaa-2', 'aaaaaaaa-3', 'aaaaaaaa-1']);
            const added = L.upsertClip(clips, { id: 'aaaaaaaa-4', createdAt: 9000 });
            added.map((c) => c.id).should.deepEqual(['aaaaaaaa-4', 'aaaaaaaa-2', 'aaaaaaaa-3', 'aaaaaaaa-1']);
            clips.should.have.length(3);
        });

        it('replaces a clip that is already there instead of duplicating it', () => {
            const again = L.upsertClip(clips, { id: 'aaaaaaaa-1', createdAt: 1000, mine: true, files: { mp4: {} } });
            again.should.have.length(3);
            again.find((c) => c.id === 'aaaaaaaa-1').files.should.have.property('mp4');
        });

        it('removes a clip', () => {
            L.removeClip(clips, 'aaaaaaaa-2')
                .map((c) => c.id)
                .should.deepEqual(['aaaaaaaa-1', 'aaaaaaaa-3']);
            L.removeClip(clips, 'nope').should.have.length(3);
        });

        it('lists everybody once, sorted', () => {
            L.people(clips).should.deepEqual(['Beltrano', 'Ciclano', 'Fulano']);
            L.people([]).should.deepEqual([]);
            L.people([{ sharer: 'água' }, { sharer: 'Zé' }, { requestedBy: 'Ana' }]).should.deepEqual([
                'água',
                'Ana',
                'Zé',
            ]);
        });

        it('filters mine, and by person on either side', () => {
            L.filterClips(clips, {}).should.have.length(3);
            L.filterClips(clips, { scope: 'all', person: '' }).should.have.length(3);
            L.filterClips(clips, { scope: 'mine' })
                .map((c) => c.id)
                .should.deepEqual(['aaaaaaaa-1']);
            L.filterClips(clips, { person: 'Beltrano' })
                .map((c) => c.id)
                .should.deepEqual(['aaaaaaaa-1', 'aaaaaaaa-2']);
            L.filterClips(clips, { person: 'Fulano' })
                .map((c) => c.id)
                .should.deepEqual(['aaaaaaaa-1', 'aaaaaaaa-3']);
            L.filterClips(clips, { scope: 'mine', person: 'Ciclano' }).should.deepEqual([]);
        });
    });

    describe('the player timeline', () => {
        it('starts at startOffsetS and hides the lead-in', () => {
            const range = L.playerRange({ durationS: 63.4, startOffsetS: 3.4 }, 63.4);
            range.start.should.equal(3.4);
            range.end.should.equal(63.4);
            range.length.should.be.approximately(60, 1e-9);
        });

        it('falls back to the length in the metadata when the file does not say', () => {
            L.playerRange({ durationS: 20, startOffsetS: 3 }, Infinity).length.should.equal(17);
            L.playerRange({ durationS: 20, startOffsetS: 3 }, NaN).end.should.equal(20);
            L.playerRange({ durationS: 20, startOffsetS: 3 }, 0).end.should.equal(20);
        });

        it('trusts the file when it has a real length', () => {
            L.playerRange({ durationS: 20, startOffsetS: 3 }, 20.04).end.should.equal(20.04);
        });

        it('never starts past the end or before zero', () => {
            L.playerRange({ durationS: 10, startOffsetS: 50 }, 10).start.should.be.below(10);
            L.playerRange({ durationS: 10, startOffsetS: -4 }, 10).start.should.equal(0);
            L.playerRange({ durationS: 10 }, 10).start.should.equal(0);
            L.playerRange({}, NaN).should.deepEqual({ start: 0, end: 0, length: 0 });
            L.playerRange(null, 5).should.deepEqual({ start: 0, end: 5, length: 5 });
        });

        it('converts between file time and timeline time', () => {
            const range = L.playerRange({ durationS: 20, startOffsetS: 3 }, 20);
            L.toTimeline(3, range).should.equal(0);
            L.toTimeline(13, range).should.equal(10);
            L.toTimeline(1, range).should.equal(0);
            L.toTimeline(99, range).should.equal(17);
            L.toMedia(0, range).should.equal(3);
            L.toMedia(10, range).should.equal(13);
            L.toMedia(-5, range).should.equal(3);
            L.toMedia(99, range).should.equal(20);
        });
    });

    describe('the persistent peer id', () => {
        const storage = (value) => ({ getItem: (key) => (key === 'peer_uuid' ? value : null) });

        it('reads a plain string', () => {
            L.readPeerUuid(storage('3f2a9c1e-7b44-4d0e-9a51-0c8e5d2b6f10')).should.equal(
                '3f2a9c1e-7b44-4d0e-9a51-0c8e5d2b6f10'
            );
        });

        it('reads a JSON string', () => {
            L.readPeerUuid(storage('"3f2a9c1e-7b44-4d0e-9a51-0c8e5d2b6f10"')).should.equal(
                '3f2a9c1e-7b44-4d0e-9a51-0c8e5d2b6f10'
            );
        });

        it('keeps a string that only looks like JSON, and cleans what cannot go in a header', () => {
            L.readPeerUuid(storage('"abc')).should.equal('"abc');
            L.readPeerUuid(storage('abc def\r\nX-Evil: 1')).should.equal('abcdefX-Evil:1');
            L.readPeerUuid(storage('x'.repeat(300))).should.have.length(100);
        });

        it('is empty when there is none or storage is blocked', () => {
            L.readPeerUuid(storage(null)).should.equal('');
            L.readPeerUuid(storage('')).should.equal('');
            L.readPeerUuid(null).should.equal('');
            L.readPeerUuid({
                getItem: () => {
                    throw new Error('blocked');
                },
            }).should.equal('');
        });
    });
});
