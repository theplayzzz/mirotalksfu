'use strict';

require('should');

const fs = require('node:fs');
const path = require('node:path');

const { Mp4Converter, START_FACTOR } = require('../../app/src/replay/Mp4Converter');
const clip = require('../../app/src/replay/ClipBuilder');
const { FrameStore } = require('../../app/src/replay/FrameStore');
const media = require('./lib/media');
const real = require('./lib/real');

const T0 = 1791036902000;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Times (s) at which the picture is bright, from FFmpeg's signalstats: [{ t, y }]. */
async function brightness(file) {
    const result = await media.run('ffmpeg', [
        '-v',
        'error',
        '-i',
        file,
        '-vf',
        'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
        '-an',
        '-f',
        'null',
        '-',
    ]);
    const out = result.stdout.toString();
    const frames = [];
    let t = null;
    for (const line of out.split(/\r?\n/)) {
        const time = /pts_time:([\d.]+)/.exec(line);
        if (time) t = Number(time[1]);
        const y = /YAVG=([\d.]+)/.exec(line);
        if (y && t !== null) frames.push({ t, y: Number(y[1]) });
    }
    return frames;
}

/** Builds a real WebM clip (through the recorder's own builder) from a source made by FFmpeg. */
async function makeWebm(dir, name, { seconds, seconds_asked, width = 640, height = 360, videoSource }) {
    const sample = real.loadFrames(
        await real.encode({ dir, name: `${name}-src`, codec: 'vp8', seconds, width, height, videoSource })
    );
    const store = new FrameStore({ dir: path.join(dir, `${name}-ring`), retainMs: 600000, flushIntervalMs: 20 });
    await store.open();
    real.feedStore(store, sample, T0);
    const snapshot = await store.snapshot();
    const plan = clip.selectRange(snapshot, seconds_asked);
    const clipDir = path.join(dir, name);
    fs.mkdirSync(clipDir);
    const { meta } = await clip.buildClip({
        snapshot,
        plan,
        share: { id: name, roomId: 'link', peerName: 'x', codec: 'vp8', hasAudioStream: true },
        request: { seconds: seconds_asked, requestedByName: 'y', requestedByHash: 'a', sharerHash: 'b' },
        id: name,
        stagingDir: clipDir,
        ffmpegPath: 'ffmpeg',
        retentionDays: 7,
        log,
    });
    snapshot.release();
    await store.close();
    return { dir: clipDir, meta };
}

describe('replay: MP4 conversion', function () {
    this.timeout(180000);
    let dir;
    let calibrationPath;
    let converter;
    let events;

    before(async function () {
        media.requireFfmpeg(this);
        dir = media.tmpDir('replay-mp4-');
    });

    after(async () => {
        if (converter) await converter.stop();
        if (dir) media.rmDir(dir);
    });

    beforeEach(() => {
        calibrationPath = path.join(dir, `calibration-${Math.random().toString(36).slice(2)}.json`);
        events = { progress: [], ready: [], failed: [] };
        converter = new Mp4Converter({ ffmpegPath: 'ffmpeg', height: 360, threads: 2, calibrationPath, log });
        for (const type of Object.keys(events)) converter.on(type, (e) => events[type].push({ ...e, at: Date.now() }));
    });

    afterEach(async () => {
        await converter.stop();
    });

    function waitFor(predicate, ms = 120000) {
        const start = Date.now();
        return new Promise((resolve, reject) => {
            const tick = () => {
                if (predicate()) return resolve();
                if (Date.now() - start > ms) return reject(new Error('timeout waiting for the converter'));
                setTimeout(tick, 25);
            };
            tick();
        });
    }

    it('converts a WebM clip into an MP4 with real progress, an ETA, scaling and the exact cut', async () => {
        // black for 5 s, then white; 12 s long; the clip file starts at a key frame before the visible start
        const source =
            "color=c=black:s=1280x720:r=30,drawbox=x=0:y=0:w=1280:h=720:color=white:t=fill:enable='gte(t,5)'";
        const made = await makeWebm(dir, 'cut', {
            seconds: 12,
            seconds_asked: 9.5,
            width: 1280,
            height: 720,
            videoSource: source,
        });
        // keys every second: the file starts at a key frame, the visible part starts startOffsetS later
        made.meta.startOffsetS.should.be.within(0, 1.001);
        const job = {
            id: 'cut',
            dir: made.dir,
            inputName: 'clip.webm',
            durationS: made.meta.durationS,
            startOffsetS: made.meta.startOffsetS,
        };
        // use a start that is not at a key frame to prove the cut is exact
        job.startOffsetS = 2.5;

        const first = converter.enqueue(job);
        first.state.should.equal('queued');
        first.progress.should.equal(0);
        first.etaSeconds.should.be.approximately(Math.round((job.durationS - 2.5) * START_FACTOR), 1); // the start calibration
        first.ahead.should.equal(0);
        converter.enqueue(job).state.should.equal('queued'); // asking again changes nothing
        converter.counts().should.deepEqual({ running: 0, queued: 1 });

        await waitFor(() => events.ready.length + events.failed.length > 0);
        events.failed.should.have.length(0, JSON.stringify(events.failed));
        events.ready.should.have.length(1);
        events.ready[0].id.should.equal('cut');
        events.ready[0].mp4.name.should.equal('clip.mp4');

        // the progress events: first "preparing" at 0, then increasing, never more than two per second
        const progress = events.progress;
        progress.length.should.be.above(0);
        progress[0].progress.should.equal(0);
        progress[0].phase.should.equal('preparing');
        for (let i = 1; i < progress.length; i++) {
            progress[i].progress.should.not.be.below(progress[i - 1].progress);
            progress[i].progress.should.be.within(0, 1);
            progress[i].etaSeconds.should.be.within(1, 600);
            (progress[i].at - progress[i - 1].at).should.be.above(400);
        }

        const file = path.join(made.dir, 'clip.mp4');
        events.ready[0].mp4.bytes.should.equal(fs.statSync(file).size);
        fs.existsSync(path.join(made.dir, 'clip.mp4.part')).should.be.false();
        const info = await media.probe(file);
        const video = info.streams.find((s) => s.codec_type === 'video');
        video.codec_name.should.equal('h264');
        video.height.should.equal(360); // scaled down to the limit
        video.width.should.equal(640);
        info.streams.some((s) => s.codec_name === 'aac').should.be.true();
        Number(info.format.duration).should.be.approximately(job.durationS - 2.5, 0.2);
        (await media.decodeErrors(file)).should.equal('');

        // the picture turns white at some time of the WebM; in the MP4 (cut at 2.5 s) that is 2.5 s earlier
        const whiteInWebm = (await brightness(path.join(made.dir, 'clip.webm'))).find((f) => f.y > 128).t;
        whiteInWebm.should.be.above(2.9); // so the MP4 has black before it
        const frames = await brightness(file);
        const firstWhite = frames.find((f) => f.y > 128);
        firstWhite.t.should.be.approximately(whiteInWebm - 2.5, 0.07);
        frames[0].t.should.be.below(0.05);
        frames[0].y.should.be.below(40);

        // asking again for a finished conversion finds no job (the caller answers "ready" from the file)
        (converter.state('cut') === null).should.be.true();
    });

    it('refines the calibration factor after a conversion and keeps it in a file', async () => {
        const made = await makeWebm(dir, 'calib', { seconds: 6, seconds_asked: 6 });
        converter.factor.should.equal(START_FACTOR);
        converter.enqueue({
            id: 'calib',
            dir: made.dir,
            inputName: 'clip.webm',
            durationS: made.meta.durationS,
            startOffsetS: 0,
        });
        await waitFor(() => events.ready.length > 0);
        converter.factor.should.not.equal(START_FACTOR);
        converter.factor.should.be.below(START_FACTOR); // a short 360p clip is far quicker than the 2.0 guess
        await waitFor(() => fs.existsSync(calibrationPath));
        const saved = JSON.parse(fs.readFileSync(calibrationPath, 'utf8'));
        saved.factor.should.equal(converter.factor);
        saved.samples.should.equal(1);
        const again = new Mp4Converter({ ffmpegPath: 'ffmpeg', calibrationPath, log });
        again.factor.should.equal(saved.factor);
    });

    it('runs one conversion at a time and tells the others how many are in front', async () => {
        const a = await makeWebm(dir, 'qa', { seconds: 10, seconds_asked: 10 });
        const b = await makeWebm(dir, 'qb', { seconds: 4, seconds_asked: 4 });
        const c = await makeWebm(dir, 'qc', { seconds: 4, seconds_asked: 4 });
        const job = (id, made) => ({
            id,
            dir: made.dir,
            inputName: 'clip.webm',
            durationS: made.meta.durationS,
            startOffsetS: 0,
        });
        const sa = converter.enqueue(job('qa', a));
        const sb = converter.enqueue(job('qb', b));
        const sc = converter.enqueue(job('qc', c));
        sa.ahead.should.equal(0);
        sb.ahead.should.equal(1);
        sc.ahead.should.equal(2);
        sc.etaSeconds.should.be.above(sb.etaSeconds); // it also waits for the one in front
        sb.etaSeconds.should.be.above(sa.etaSeconds);
        await waitFor(() => converter.counts().running === 1);
        converter.counts().should.deepEqual({ running: 1, queued: 2 });
        converter.state('qa').state.should.equal('running');
        converter.state('qb').state.should.equal('queued');
        converter.state('qb').ahead.should.equal(1);
        await waitFor(() => events.ready.length === 3);
        events.ready.map((e) => e.id).should.deepEqual(['qa', 'qb', 'qc']); // in order
        converter.counts().should.deepEqual({ running: 0, queued: 0 });
    });

    it('cancels a conversion that is running: the process dies, nothing is left, no event is sent', async () => {
        const made = await makeWebm(dir, 'cancel', { seconds: 40, seconds_asked: 40, width: 960, height: 540 });
        converter.enqueue({
            id: 'cancel',
            dir: made.dir,
            inputName: 'clip.webm',
            durationS: made.meta.durationS,
            startOffsetS: 0,
        });
        await waitFor(() => converter.counts().running === 1);
        await sleep(400); // let ffmpeg start for real
        (await converter.cancel('cancel')).should.be.true();
        converter.counts().should.deepEqual({ running: 0, queued: 0 });
        fs.existsSync(path.join(made.dir, 'clip.mp4.part')).should.be.false();
        fs.existsSync(path.join(made.dir, 'clip.mp4')).should.be.false();
        await sleep(200);
        events.ready.should.have.length(0);
        events.failed.should.have.length(0);
        (converter.state('cancel') === null).should.be.true();
        (await converter.cancel('cancel')).should.be.false(); // nothing to cancel any more
    });

    it('cancels a queued conversion without touching the running one', async () => {
        const a = await makeWebm(dir, 'ca', { seconds: 8, seconds_asked: 8 });
        const b = await makeWebm(dir, 'cb', { seconds: 4, seconds_asked: 4 });
        converter.enqueue({
            id: 'ca',
            dir: a.dir,
            inputName: 'clip.webm',
            durationS: a.meta.durationS,
            startOffsetS: 0,
        });
        converter.enqueue({
            id: 'cb',
            dir: b.dir,
            inputName: 'clip.webm',
            durationS: b.meta.durationS,
            startOffsetS: 0,
        });
        (await converter.cancel('cb')).should.be.true();
        await waitFor(() => events.ready.length > 0);
        events.ready.map((e) => e.id).should.deepEqual(['ca']);
        await sleep(200);
        events.ready.should.have.length(1);
    });

    it('reports a failure with the reason and leaves the calibration alone', async () => {
        const bad = path.join(dir, 'bad');
        fs.mkdirSync(bad);
        fs.writeFileSync(path.join(bad, 'clip.webm'), 'this is not a video');
        converter.enqueue({ id: 'bad', dir: bad, inputName: 'clip.webm', durationS: 10, startOffsetS: 0 });
        await waitFor(() => events.failed.length > 0);
        events.failed[0].id.should.equal('bad');
        events.failed[0].message.length.should.be.above(5);
        converter.factor.should.equal(START_FACTOR);
        fs.existsSync(path.join(bad, 'clip.mp4.part')).should.be.false();
        converter.counts().should.deepEqual({ running: 0, queued: 0 });
        // the queue goes on after a failure
        const ok = await makeWebm(dir, 'after-bad', { seconds: 4, seconds_asked: 4 });
        converter.enqueue({
            id: 'ok',
            dir: ok.dir,
            inputName: 'clip.webm',
            durationS: ok.meta.durationS,
            startOffsetS: 0,
        });
        await waitFor(() => events.ready.length > 0);
    });
});
