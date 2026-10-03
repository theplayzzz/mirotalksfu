'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { FrameHeap, readRecords, KIND_AUDIO, KIND_VIDEO } = require('./FrameStore');
const { MatroskaMuxer, streamSink } = require('./Matroska');
const { avccNals, buildAvcC, parseSps, NAL_SPS, NAL_PPS } = require('./h264');
const { OPUS_SILENCE_FRAME, opusPacketDurationMs } = require('./opus');
const { spawnLowPriority, waitForExit, lastLine } = require('./Ffmpeg');

/**
 * Clip builder: from the frame ring of a share to the files of a clip.
 *
 *   selectRange   the part of the ring a clip covers: it ends at the newest frame, starts `seconds` before and the
 *                 file begins at the last video key frame at or before that start (the lead-in)
 *   orderedRecords the records of the chosen chunks in media time order, one chunk read at a time
 *   buildClip     our Matroska muxer streams the records into FFmpeg, which copies them into the final file
 *                 (WebM with an index at the front for VP8, MP4 with the moov atom first for H.264) and a thumbnail
 *
 * Nothing here is allowed to load a whole buffer in memory: records are read, muxed into clusters of two seconds and
 * written to the pipe of FFmpeg, with the backpressure of the pipe.
 */

const MATCH_WINDOW_MS = 4000; // records of the ring are almost in order; this much disorder is repaired
const FINALIZE_TIMEOUT_MS = 180000;
const AUDIO_FRAME_MS = 20;
const AUDIO_GAP_FILL_MS = 30; // an audio hole at least this long is filled with silence frames
const AUDIO_FILL_LIMIT_MS = 10 * 60 * 1000;

/**
 * @param {object} snapshot result of FrameStore.snapshot()
 * @param {number} seconds length of the clip asked for
 * @returns {object|null} null when the ring has no video key frame
 */
function selectRange(snapshot, seconds) {
    const keys = [];
    snapshot.chunks.forEach((chunk, chunkIndex) => {
        for (const key of chunk.keys) keys.push({ ts: key.ts, off: key.off, end: key.end, chunkIndex });
    });
    if (keys.length === 0) return null;
    keys.sort((a, b) => a.ts - b.ts);

    const endTs = snapshot.newestTs;
    const startTs = endTs - seconds * 1000;
    // the last key frame at or before the start; a share shorter than the clip starts at its first key frame
    let first = keys[0];
    for (const key of keys) {
        if (key.ts <= startTs) first = key;
        else break;
    }
    // the key frame shown as the thumbnail: the one closest to one second into the visible clip
    let thumb = first;
    const wanted = Math.max(startTs, first.ts) + 1000;
    for (const key of keys) {
        if (key.ts < first.ts) continue;
        if (Math.abs(key.ts - wanted) < Math.abs(thumb.ts - wanted)) thumb = key;
    }
    const fileStartTs = first.ts;
    return {
        key: first,
        thumbKey: thumb,
        endTs,
        startTs,
        fileStartTs,
        startOffsetMs: Math.max(0, startTs - fileStartTs),
        durationMs: endTs - fileStartTs + AUDIO_FRAME_MS,
    };
}

/** Whether any audio of the ring falls in [from, to]. */
function audioInRange(audioRanges, from, to) {
    return audioRanges.some((r) => r.to >= from && r.from <= to);
}

/**
 * The records of the chunks from a byte offset of the first chunk on, sorted by media time. A window of recent
 * records is kept sorted in a heap, which repairs the small disorder between audio and video.
 */
async function* orderedRecords(chunks, startIndex, startOffset, windowMs = MATCH_WINDOW_MS) {
    const heap = new FrameHeap();
    let maxTs = -Infinity;
    for (let i = startIndex; i < chunks.length; i++) {
        const chunk = chunks[i];
        for await (const record of readRecords(chunk.path, i === startIndex ? startOffset : 0, chunk.bytes)) {
            heap.push(record);
            if (record.ts > maxTs) maxTs = record.ts;
            while (heap.size > 0 && heap.peek().ts <= maxTs - windowMs) yield heap.pop();
        }
    }
    while (heap.size > 0) yield heap.pop();
}

/** Picture size and codec private data of the track, from the first key frame of the clip. */
function videoParams(codec, data) {
    if (codec === 'vp8') {
        if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
            throw new Error('the first frame of the clip is not a VP8 key frame');
        }
        return { codec, width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
    }
    const nals = avccNals(data);
    const sps = nals.find((n) => (n[0] & 0x1f) === NAL_SPS);
    const pps = nals.find((n) => (n[0] & 0x1f) === NAL_PPS);
    if (!sps || !pps) throw new Error('the first frame of the clip has no H.264 parameter sets');
    const info = parseSps(sps);
    if (!info) throw new Error('cannot read the H.264 sequence parameter set');
    return { codec, width: info.width, height: info.height, codecPrivate: buildAvcC(sps, pps, info) };
}

/** `YYYYMMDD-HHMMSS-<8 hex>-<4 base36>`: sorts by time, matches ^[a-z0-9-]{8,64}$ */
function generateClipId(now = Date.now()) {
    const d = new Date(now);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    const hex = crypto.randomBytes(4).toString('hex');
    const tail = crypto
        .randomBytes(3)
        .toString('hex')
        .slice(0, 4)
        .replace(/[^a-z0-9]/g, 'x');
    return `${stamp}-${hex}-${tail}`;
}

/** FFmpeg options (valid for 5.1 and newer) that turn the piped Matroska into the final file. */
function finalizeArgs({ codec, hasAudio, output }) {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'matroska', '-i', 'pipe:0', '-map', '0:v:0'];
    if (hasAudio) args.push('-map', '0:a:0');
    if (codec === 'vp8') {
        // Stream copy. The index goes to the front of the file: space for it is reserved while writing, so FFmpeg
        // does not have to rewrite the whole file to move it.
        args.push('-c', 'copy', '-cues_to_front', '1', '-reserve_index_space', '131072', '-f', 'webm');
    } else {
        // The picture is copied; Opus is not welcome in MP4 players, so the audio becomes AAC.
        args.push('-c:v', 'copy');
        if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
        args.push('-movflags', '+faststart', '-f', 'mp4');
    }
    args.push('-y', output);
    return args;
}

async function makeThumbnail({ ffmpegPath, input, atSeconds, output, log }) {
    const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:-2',
        '-q:v',
        '4',
        '-update',
        '1',
        '-f',
        'image2',
        '-y',
        output,
    ];
    try {
        const child = spawnLowPriority(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        const exit = await waitForExit(child);
        if (exit.code !== 0) {
            log.warn(`replay: thumbnail failed: ${lastLine(exit.stderr)}`);
            return false;
        }
        return true;
    } catch (error) {
        log.warn(`replay: thumbnail failed: ${error.message}`);
        return false;
    }
}

/**
 * Builds the files of a clip in stagingDir (which must exist) and returns its metadata.
 *
 * @param {object} o
 * @param {object} o.snapshot FrameStore.snapshot() of the share (the caller releases it)
 * @param {object} o.plan selectRange() of that snapshot
 * @param {object} o.share { id, roomId, peerName, codec, audioChannels }
 * @param {object} o.request { seconds, requestedByName, requestedByHash, sharerHash }
 * @param {string} o.id clip id
 * @param {string} o.stagingDir
 * @param {string} o.ffmpegPath
 * @param {number} o.retentionDays
 * @param {object} o.log
 * @param {function} [o.now]
 * @param {boolean} [o.withAudio] false to leave the audio out (used for the retry)
 */
async function buildClip(o) {
    const { snapshot, plan, share, request, id, stagingDir, ffmpegPath, log } = o;
    const now = o.now || Date.now;
    const startedAt = now();
    const codec = share.codec;
    const hasAudio =
        o.withAudio !== false &&
        audioInRange(snapshot.audioRanges, plan.fileStartTs, plan.endTs) &&
        !!share.hasAudioStream;
    const outputName = codec === 'vp8' ? 'clip.webm' : 'clip.mp4';
    const outputPath = path.join(stagingDir, outputName);

    const signal = o.signal || null;
    const records = orderedRecords(snapshot.chunks, plan.key.chunkIndex, plan.key.off);
    let child = null;
    let exited = null;
    let timer = null;
    try {
        // The first record is the key frame the file starts with: it tells the size and the codec parameters.
        const firstStep = await records.next();
        const first = firstStep.value;
        if (!first || first.kind !== KIND_VIDEO || !first.key)
            throw new Error('the ring does not start at a key frame');
        const params = videoParams(codec, first.data);

        child = spawnLowPriority(ffmpegPath, finalizeArgs({ codec, hasAudio, output: outputPath }), {
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        exited = waitForExit(child);
        exited.catch(() => {}); // a failure is reported where the exit is awaited, never as an unhandled rejection
        timer = setTimeout(() => child.kill('SIGKILL'), FINALIZE_TIMEOUT_MS);
        if (signal) {
            if (signal.aborted) child.kill('SIGKILL');
            else signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
        }
        const sink = streamSink(child.stdin);
        const muxer = new MatroskaMuxer({
            docType: 'matroska',
            video: params,
            audio: hasAudio ? { channels: share.audioChannels || 2 } : null,
            sink,
        });
        await muxer.start();

        const base = plan.fileStartTs;
        const audio = { active: false, next: 0 };
        const fillSilence = async (until) => {
            const gap = until - audio.next;
            if (gap < AUDIO_GAP_FILL_MS) return;
            const count = Math.min(Math.floor(gap / AUDIO_FRAME_MS), AUDIO_FILL_LIMIT_MS / AUDIO_FRAME_MS);
            for (let i = 0; i < count; i++) {
                await muxer.writeFrame({ track: 'audio', tsMs: audio.next, key: true, data: OPUS_SILENCE_FRAME });
                audio.next += AUDIO_FRAME_MS;
            }
        };

        let record = first;
        let step = firstStep;
        while (!step.done) {
            if (signal && signal.aborted) throw new Error('the recorder is stopping');
            record = step.value;
            const t = record.ts - base;
            if (t >= 0) {
                if (record.kind === KIND_VIDEO) {
                    if (audio.active) await fillSilence(t);
                    await muxer.writeFrame({ track: 'video', tsMs: t, key: record.key, data: record.data });
                } else if (record.kind === KIND_AUDIO && hasAudio) {
                    if (audio.active) await fillSilence(t);
                    await muxer.writeFrame({ track: 'audio', tsMs: t, key: true, data: record.data });
                    audio.next = Math.max(audio.next, t) + opusPacketDurationMs(record.data);
                    audio.active = true;
                }
            }
            step = await records.next();
        }
        await muxer.finish();
        await sink.end();
        const exit = await exited;
        clearTimeout(timer);
        timer = null;
        if (exit.code !== 0) throw new Error(`ffmpeg failed: ${lastLine(exit.stderr)}`);
        if (hasAudio && muxer.stats.audioFrames === 0) {
            // The ring said there was audio, but none of it landed in the clip: leave the track out.
            const error = new Error('no audio frames in the clip');
            error.retryWithoutAudio = true;
            throw error;
        }
        const finalizedAt = now();

        // Thumbnail from the key frame closest to one second into the visible clip: a seek to a key frame decodes
        // one picture only.
        let thumb = null;
        const thumbAt = Math.max(0, (plan.thumbKey.ts - base) / 1000);
        if (
            await makeThumbnail({
                ffmpegPath,
                input: outputPath,
                atSeconds: thumbAt,
                output: path.join(stagingDir, 'thumb.jpg'),
                log,
            })
        ) {
            thumb = 'thumb.jpg';
        }

        const stat = await fsp.stat(outputPath);
        const createdAt = now();
        const mime = codec === 'vp8' ? 'video/webm' : 'video/mp4';
        const file = { name: outputName, mime, bytes: stat.size };
        const meta = {
            id,
            shareId: share.id,
            roomId: share.roomId,
            createdAt,
            expiresAt: createdAt + o.retentionDays * 24 * 3600 * 1000,
            sharer: share.peerName,
            requestedBy: request.requestedByName,
            seconds: request.seconds,
            durationS: Math.round(plan.durationMs) / 1000,
            startOffsetS: Math.round(plan.startOffsetMs) / 1000,
            codec,
            hasAudio: muxer.stats.audioFrames > 0,
            files: { original: file, mp4: codec === 'h264' ? { ...file } : null },
            thumb,
            requestedByHash: request.requestedByHash,
            sharerHash: request.sharerHash,
        };
        await fsp.writeFile(path.join(stagingDir, 'meta.json'), JSON.stringify(meta, null, 2));
        log.info(
            `replay: clip ${id} of ${share.id}: ${(plan.durationMs / 1000).toFixed(1)} s, ${(stat.size / 1048576).toFixed(1)} MB, ` +
                `${muxer.stats.videoFrames} video + ${muxer.stats.audioFrames} audio frames, ` +
                `muxed in ${finalizedAt - startedAt} ms, ${createdAt - finalizedAt} ms thumbnail`
        );
        return { meta, timings: { totalMs: createdAt - startedAt, finalizeMs: finalizedAt - startedAt } };
    } catch (error) {
        if (child) {
            if (child.exitCode === null) child.kill('SIGKILL');
            // the reason that FFmpeg gave is more useful than the broken pipe that came out of it
            const exit = await exited.catch((e) => ({ stderr: e.message }));
            if (exit && exit.stderr && !error.retryWithoutAudio) error.message += ` (ffmpeg: ${lastLine(exit.stderr)})`;
        }
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
        await records.return().catch(() => {});
    }
}

module.exports = {
    selectRange,
    audioInRange,
    orderedRecords,
    videoParams,
    generateClipId,
    finalizeArgs,
    buildClip,
};
