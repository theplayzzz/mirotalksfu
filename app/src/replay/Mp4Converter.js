'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { spawnLowPriority, lastLine, vfrArgs } = require('./Ffmpeg');

/**
 * MP4 conversion of the clips that came out as WebM (VP8): one job at a time, in a queue, at low priority.
 *
 *   ffmpeg -ss <startOffsetS> -i clip.webm -vf scale ... -c:v libx264 -preset veryfast -crf 23 -c:a aac
 *          -movflags +faststart clip.mp4.part      (renamed to clip.mp4 when it is complete)
 *
 * - The cut is exact: the picture of the lead-in is decoded and dropped, the MP4 starts at startOffsetS.
 * - Progress is real. FFmpeg reports `out_time_us` and `speed` on stdout (-progress pipe:1); until the first picture
 *   comes out (the lead-in is being decoded) the job is "preparing" at 0. The estimated time left comes from the
 *   measured speed; before that, from a calibration factor (seconds of work per second of clip, 2.0 at first) that
 *   is refined with every conversion and kept in a file.
 * - Events: 'progress' { id, progress, etaSeconds, phase } (at most two per second), 'ready' { id, mp4 }, 'failed'
 *   { id, message }.
 */

const START_FACTOR = 2.0;
const PROGRESS_EVENT_MS = 500;
const STALL_TIMEOUT_MS = 120000;

class Mp4Converter extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.ffmpegPath
     * @param {number} [options.height] output height limit (720)
     * @param {number} [options.threads] threads of ffmpeg (2)
     * @param {string} [options.calibrationPath] file where the calibration factor is kept
     * @param {object} options.log
     * @param {function} [options.now]
     */
    constructor(options) {
        super();
        this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
        this.height = options.height || 720;
        this.threads = options.threads || 2;
        this.calibrationPath = options.calibrationPath || null;
        this.log = options.log;
        this.now = options.now || Date.now;
        this.jobs = new Map(); // id -> job (queued and running)
        this.queue = [];
        this.current = null;
        this.stopped = false;
        this.calibration = { factor: START_FACTOR, samples: 0 };
        this._loadCalibration();
    }

    _loadCalibration() {
        if (!this.calibrationPath) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.calibrationPath, 'utf8'));
            if (Number.isFinite(data.factor) && data.factor > 0.01 && data.factor < 100) {
                this.calibration = { factor: data.factor, samples: Number(data.samples) || 0 };
            }
        } catch {
            // first run, or a damaged file: start from the default
        }
    }

    _saveCalibration() {
        if (!this.calibrationPath) return;
        const tmp = `${this.calibrationPath}.tmp`;
        fsp.writeFile(tmp, JSON.stringify({ ...this.calibration, updatedAt: this.now() }))
            .then(() => fsp.rename(tmp, this.calibrationPath))
            .catch((error) => this.log.warn(`replay: cannot save the MP4 calibration: ${error.message}`));
    }

    get factor() {
        return this.calibration.factor;
    }

    counts() {
        return { running: this.current ? 1 : 0, queued: this.queue.length };
    }

    /** Seconds of output the job will produce. */
    _total(job) {
        return Math.max(0.1, job.durationS - job.startOffsetS);
    }

    /** Estimated seconds for a job that did not start: the calibration factor times its length. */
    _estimate(job) {
        return this._total(job) * this.calibration.factor;
    }

    /** Estimated seconds until `job` is done, counting the jobs in front of it. */
    _eta(job) {
        if (job === this.current) return this._runningEta(job);
        let wait = this.current ? this._runningEta(this.current) : 0;
        for (const queued of this.queue) {
            if (queued === job) break;
            wait += this._estimate(queued);
        }
        return wait + this._estimate(job);
    }

    _runningEta(job) {
        const total = this._total(job);
        if (job.outTime === null) {
            // still decoding the lead-in: nothing has been measured yet
            return Math.max(1, this._estimate(job) - (this.now() - job.startedAt) / 1000);
        }
        const remaining = Math.max(0, total - job.outTime);
        const rate = job.speed > 0.01 ? job.speed : 1 / this.calibration.factor;
        return remaining / rate;
    }

    /** The state of the conversion of a clip, or null when none is queued or running. */
    state(id) {
        const job = this.jobs.get(id);
        if (!job) return null;
        const ahead = job === this.current ? 0 : (this.current ? 1 : 0) + this.queue.indexOf(job);
        return {
            state: job === this.current ? 'running' : 'queued',
            progress: job === this.current ? job.progress : 0,
            etaSeconds: Math.max(1, Math.round(this._eta(job))),
            phase: job === this.current ? job.phase : 'queued',
            ahead,
        };
    }

    /**
     * Queues the conversion of a clip (or returns the state of the one already queued).
     * @param {object} job { id, dir, inputName, durationS, startOffsetS }
     */
    enqueue(job) {
        const existing = this.state(job.id);
        if (existing) return existing;
        if (this.stopped) throw new Error('the converter is stopping');
        const entry = {
            id: job.id,
            dir: job.dir,
            inputName: job.inputName,
            durationS: job.durationS,
            startOffsetS: job.startOffsetS || 0,
            progress: 0,
            phase: 'queued',
            outTime: null,
            speed: 0,
            startedAt: 0,
            lastEvent: 0,
            child: null,
            cancelled: false,
        };
        this.jobs.set(entry.id, entry);
        this.queue.push(entry);
        setImmediate(() => this._next());
        return this.state(entry.id);
    }

    /**
     * Cancels the conversion of a clip (queued or running). Resolves when the process is gone and its partial file
     * is deleted.
     * @returns {Promise<boolean>} true when there was a job
     */
    async cancel(id) {
        const job = this.jobs.get(id);
        if (!job) return false;
        job.cancelled = true;
        const queued = this.queue.indexOf(job);
        if (queued >= 0) {
            this.queue.splice(queued, 1);
            this.jobs.delete(id);
            return true;
        }
        if (job.child) job.child.kill('SIGKILL');
        if (job.done) await job.done;
        return true;
    }

    /** Stops everything: running job killed, queue emptied. */
    async stop() {
        this.stopped = true;
        const running = this.current;
        for (const job of this.queue) this.jobs.delete(job.id);
        this.queue = [];
        if (running) {
            running.cancelled = true;
            if (running.child) running.child.kill('SIGKILL');
            if (running.done) await running.done;
        }
    }

    _next() {
        if (this.current || this.stopped) return;
        const job = this.queue.shift();
        if (!job) return;
        this.current = job;
        job.done = this._run(job).finally(() => {
            this.current = null;
            this.jobs.delete(job.id);
            this._next();
        });
    }

    _args(job, partPath) {
        const input = path.join(job.dir, job.inputName);
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats'];
        args.push('-filter_threads', String(this.threads), '-threads', String(this.threads));
        if (job.startOffsetS > 0) args.push('-ss', job.startOffsetS.toFixed(3));
        args.push('-i', input, '-map', '0:v:0', '-map', '0:a:0?');
        args.push('-vf', `scale=-2:'min(${this.height},trunc(ih/2)*2)'`);
        args.push(
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-pix_fmt',
            'yuv420p',
            '-threads',
            String(this.threads)
        );
        args.push('-c:a', 'aac', '-b:a', '128k');
        args.push(...vfrArgs(this.ffmpegPath));
        args.push('-movflags', '+faststart', '-f', 'mp4', '-y', partPath);
        return args;
    }

    async _run(job) {
        const partPath = path.join(job.dir, 'clip.mp4.part');
        const finalPath = path.join(job.dir, 'clip.mp4');
        job.startedAt = this.now();
        job.phase = 'preparing';
        this._emitProgress(job, true);

        let outcome;
        try {
            outcome = await this._spawn(job, partPath);
        } catch (error) {
            outcome = { code: -1, stderr: error.message };
        }

        if (job.cancelled) {
            await fsp.rm(partPath, { force: true }).catch(() => {});
            return;
        }
        if (outcome.code !== 0) {
            await fsp.rm(partPath, { force: true }).catch(() => {});
            const message = lastLine(outcome.stderr) || 'the conversion failed';
            this.log.error(`replay: MP4 conversion of ${job.id} failed: ${message}`);
            this._emit('failed', { id: job.id, message });
            return;
        }
        try {
            await fsp.rename(partPath, finalPath);
            const stat = await fsp.stat(finalPath);
            const elapsed = (this.now() - job.startedAt) / 1000;
            this._learn(elapsed / this._total(job));
            this.log.info(
                `replay: MP4 of ${job.id} ready: ${(stat.size / 1048576).toFixed(1)} MB in ${elapsed.toFixed(1)} s ` +
                    `(${(elapsed / this._total(job)).toFixed(2)} s of work per second of clip)`
            );
            this._emit('ready', { id: job.id, mp4: { name: 'clip.mp4', bytes: stat.size } });
        } catch (error) {
            await fsp.rm(partPath, { force: true }).catch(() => {});
            this._emit('failed', { id: job.id, message: error.message });
        }
    }

    /** emit() that never throws: a listener's mistake must not break the queue. */
    _emit(event, payload) {
        try {
            this.emit(event, payload);
        } catch (error) {
            this.log.error(`replay: listener of the MP4 converter failed: ${error.message}`);
        }
    }

    /** Refines the calibration with a measured factor: the first measurement counts more than the start guess. */
    _learn(measured) {
        if (!Number.isFinite(measured) || measured <= 0) return;
        const weight = this.calibration.samples === 0 ? 0.6 : 0.3;
        this.calibration = {
            factor: (1 - weight) * this.calibration.factor + weight * measured,
            samples: this.calibration.samples + 1,
        };
        this._saveCalibration();
    }

    _spawn(job, partPath) {
        return new Promise((resolve, reject) => {
            const child = spawnLowPriority(this.ffmpegPath, this._args(job, partPath), {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            job.child = child;
            let stderr = '';
            let buffered = '';
            let block = {};
            let stallTimer = null;
            const arm = () => {
                if (stallTimer) clearTimeout(stallTimer);
                stallTimer = setTimeout(() => child.kill('SIGKILL'), STALL_TIMEOUT_MS);
            };
            arm();

            child.stdout.on('data', (chunk) => {
                arm();
                buffered += chunk.toString();
                let newline;
                while ((newline = buffered.indexOf('\n')) >= 0) {
                    const line = buffered.slice(0, newline).trim();
                    buffered = buffered.slice(newline + 1);
                    const eq = line.indexOf('=');
                    if (eq < 0) continue;
                    const key = line.slice(0, eq);
                    block[key] = line.slice(eq + 1);
                    if (key === 'progress') {
                        this._onProgressBlock(job, block);
                        block = {};
                    }
                }
            });
            child.stderr.on('data', (chunk) => {
                stderr = (stderr + chunk.toString()).slice(-8192);
            });
            child.once('error', (error) => {
                if (stallTimer) clearTimeout(stallTimer);
                reject(error);
            });
            child.once('close', (code, signal) => {
                if (stallTimer) clearTimeout(stallTimer);
                job.child = null;
                resolve({ code: code === null ? -1 : code, signal, stderr });
            });
        });
    }

    _onProgressBlock(job, block) {
        let outUs = Number(block.out_time_us);
        if (!Number.isFinite(outUs) && block.out_time_ms !== undefined && block.out_time_ms !== 'N/A')
            outUs = Number(block.out_time_ms);
        const total = this._total(job);
        if (Number.isFinite(outUs) && outUs >= 0 && block.out_time_us !== 'N/A') {
            job.outTime = outUs / 1e6;
            job.phase = 'encoding';
            job.progress = Math.min(0.99, job.outTime / total);
        }
        const speed = parseFloat(block.speed);
        if (Number.isFinite(speed) && speed > 0) job.speed = job.speed > 0 ? 0.6 * job.speed + 0.4 * speed : speed;
        this._emitProgress(job, false);
    }

    _emitProgress(job, force) {
        const now = this.now();
        if (!force && now - job.lastEvent < PROGRESS_EVENT_MS) return;
        job.lastEvent = now;
        this._emit('progress', {
            id: job.id,
            progress: Math.round(job.progress * 1000) / 1000,
            etaSeconds: Math.max(1, Math.round(this._runningEta(job))),
            phase: job.phase,
        });
    }
}

module.exports = { Mp4Converter, START_FACTOR };
