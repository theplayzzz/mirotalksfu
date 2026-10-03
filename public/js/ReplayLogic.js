'use strict';

/*
 * Replay: the plain logic shared by the room button (Replay.js) and the gallery (ReplayGallery.js).
 * Nothing in here touches the page, so it also loads in Node for the unit tests (tests/test-ReplayUi.js).
 * Text is Portuguese (Brazil), like LivePix.js. See docs/REPLAY.md, section 7.
 */
const ReplayLogic = (() => {
    const CLIP_ID_RE = /^[a-z0-9-]{8,64}$/;
    // The files the media route serves (docs/REPLAY.md section 6), by name only: never build a URL from anything else.
    const MEDIA_FILES = new Set(['clip.webm', 'clip.mkv', 'clip.mp4', 'thumb.jpg']);
    // Used to forgive float noise when comparing the buffer with an option.
    const OPTION_EPSILON_S = 0.5;
    // Conversion speed before this browser has seen one: seconds of work per second of clip.
    const DEFAULT_MP4_RATIO = 0.4;

    const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const pad2 = (value) => String(value).padStart(2, '0');
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

    // ---- time -----------------------------------------------------------------------------------------------

    // 0 -> 0:00, 61.9 -> 1:01, 3600 -> 1:00:00. Never negative, never NaN.
    function formatClock(seconds) {
        const total = isNumber(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
    }

    // 60 -> "1 min", 90 -> "1 min 30 s", 45 -> "45 s".
    function optionLabel(seconds) {
        const total = isNumber(seconds) && seconds > 0 ? Math.round(seconds) : 0;
        const m = Math.floor(total / 60);
        const s = total % 60;
        if (!m) return `${s} s`;
        return s ? `${m} min ${s} s` : `${m} min`;
    }

    // How long ago, from elapsed milliseconds.
    function formatAgo(ms) {
        const s = isNumber(ms) && ms > 0 ? ms / 1000 : 0;
        if (s < 45) return 'agora mesmo';
        if (s < 90) return 'há 1 min';
        const minutes = Math.round(s / 60);
        if (minutes < 60) return `há ${minutes} min`;
        const hours = Math.floor(s / 3600);
        if (hours < 24) return `há ${hours} h`;
        return `há ${Math.floor(hours / 24)} d`;
    }

    // Time left before the clip is deleted, from milliseconds. Rounds down: never promises more than there is.
    function formatLeft(ms) {
        if (!isNumber(ms) || ms <= 0) return 'expirado';
        const s = ms / 1000;
        if (s < 60) return 'expira em instantes';
        const minutes = Math.floor(s / 60);
        if (minutes < 60) return `expira em ${minutes} min`;
        const hours = Math.floor(minutes / 60);
        if (hours < 48) return `expira em ${hours} h`;
        return `expira em ${Math.floor(hours / 24)} d`;
    }

    // Numbers for texts that change while you read them: rounded so they do not flicker every second.
    function roughSeconds(seconds) {
        const s = Math.ceil(seconds);
        if (s < 10) return s;
        if (s < 60) return Math.min(60, Math.round(s / 5) * 5);
        if (s < 600) return Math.round(s / 10) * 10;
        return Math.round(s / 60) * 60;
    }

    // 25 -> "25 s", 90 -> "1 min 30 s", 120 -> "2 min", 4500 -> "1 h 15 min".
    function shortDuration(seconds) {
        const s = roughSeconds(seconds);
        if (s < 60) return `${s} s`;
        const minutes = Math.floor(s / 60);
        const rest = s % 60;
        if (minutes >= 60) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
        return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
    }

    // "cerca de 25 s"
    function etaText(seconds) {
        if (!isNumber(seconds) || seconds < 0) return '';
        if (Math.ceil(seconds) < 5) return 'menos de 5 s';
        return `cerca de ${shortDuration(seconds)}`;
    }

    function formatBytes(bytes) {
        if (!isNumber(bytes) || bytes < 0) return '';
        const dec = (value) => value.toFixed(1).replace('.', ',').replace(/,0$/, '');
        if (bytes < 1024) return `${Math.round(bytes)} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        if (bytes < 10 * 1024 * 1024) return `${dec(bytes / (1024 * 1024))} MB`;
        if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
        return `${dec(bytes / (1024 * 1024 * 1024))} GB`;
    }

    // ---- the room: which options can be used ---------------------------------------------------------

    // Options longer than what is being kept are off, with the hint "a tela começou há m:ss".
    // `bufferSeconds` is what the recorder holds for that screen (`replayBuffers`), `maxSeconds` the server limit.
    function optionsAvailability({ options, maxSeconds, bufferSeconds }) {
        const max = isNumber(maxSeconds) && maxSeconds > 0 ? maxSeconds : 300;
        const kept = clamp(isNumber(bufferSeconds) ? bufferSeconds : 0, 0, max);
        const list = (Array.isArray(options) ? options : [])
            .filter((seconds) => isNumber(seconds) && seconds >= 1 && seconds <= max)
            .sort((a, b) => a - b);
        return list.map((seconds) => {
            const enabled = kept + OPTION_EPSILON_S >= seconds;
            return {
                seconds,
                label: optionLabel(seconds),
                enabled,
                hint: enabled ? '' : `a tela começou há ${formatClock(kept)}`,
            };
        });
    }

    // What the popover says is available, never above the server limit.
    function availableSeconds(bufferSeconds, maxSeconds) {
        const max = isNumber(maxSeconds) && maxSeconds > 0 ? maxSeconds : 300;
        return clamp(isNumber(bufferSeconds) ? bufferSeconds : 0, 0, max);
    }

    // ---- the gallery: MP4 conversion --------------------------------------------------------------------

    function queueText(ahead) {
        if (!isNumber(ahead)) return 'Na fila — aguardando a vez';
        if (ahead < 1) return 'Na fila — começa em instantes';
        return `Na fila — ${plural(ahead, 'conversão', 'conversões')} na frente`;
    }

    // What the "Baixar MP4" button says for the answer of the server (state, progress 0..1, etaSeconds, ahead).
    // `text` is the whole sentence ("Convertendo para MP4… 58% · cerca de 25 s"); `title` and `detail` are its two
    // lines, so the button keeps its width while the numbers change.
    function mp4Status(info) {
        const { state, progress, etaSeconds, ahead } = info || {};
        const out = (phase, percent, title, detail = '') => ({
            phase,
            percent,
            title,
            detail,
            text: detail ? `${title} ${detail}` : title,
        });
        if (state === 'ready') return out('ready', 100, 'MP4 pronto');
        if (state === 'error') return out('error', 0, 'Não deu para converter', 'toque para tentar de novo');
        if (state === 'queued') return out('queued', 0, queueText(ahead));
        if (state === 'running') {
            const percent = isNumber(progress) ? clamp(Math.floor(progress * 100 + 1e-6), 0, 99) : 0;
            const eta = isNumber(etaSeconds) ? etaText(etaSeconds) : '';
            const detail = percent > 0 ? `${percent}%${eta ? ` · ${eta}` : ''}` : '';
            return out('running', percent, 'Convertendo para MP4…', detail);
        }
        return out('idle', 0, 'Baixar MP4');
    }

    // How long a conversion takes, before it starts: a guess from the length of the clip and the speed this
    // browser saw last time. The real numbers come from the server as soon as the conversion runs.
    function estimateMp4Seconds(durationS, ratio) {
        const per = isNumber(ratio) && ratio > 0 ? ratio : DEFAULT_MP4_RATIO;
        const length = isNumber(durationS) && durationS > 0 ? durationS : 0;
        return Math.max(3, Math.round(length * per));
    }

    // "leva ~25 s"
    function estimateText(seconds) {
        return isNumber(seconds) && seconds >= 0 ? `leva ~${shortDuration(Math.max(seconds, 1))}` : '';
    }

    // Remember the conversion speed: a slow average so one odd run does not rule the estimate.
    function learnRatio(previous, workSeconds, durationS) {
        if (!isNumber(workSeconds) || workSeconds <= 0 || !isNumber(durationS) || durationS <= 0) return previous;
        const observed = clamp(workSeconds / durationS, 0.02, 4);
        return isNumber(previous) && previous > 0
            ? Math.round((previous * 0.6 + observed * 0.4) * 1000) / 1000
            : observed;
    }

    // ---- the gallery: the list ------------------------------------------------------------------------------

    const isClipId = (id) => typeof id === 'string' && CLIP_ID_RE.test(id);

    function mediaUrl(id, file, download) {
        if (!isClipId(id) || !MEDIA_FILES.has(file)) return '';
        return `/replay/media/${id}/${file}${download ? '?download=1' : ''}`;
    }

    // The link that opens a clip in the gallery (the toast "Ver", the discreet toast, a card).
    function galleryUrl({ clip, fromRoom } = {}) {
        const query = [];
        if (isClipId(clip)) query.push(`clip=${clip}`);
        if (fromRoom) query.push('from=room');
        return `/replay/${query.length ? `?${query.join('&')}` : ''}`;
    }

    function sortNewestFirst(clips) {
        return [...clips].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    // Adds a clip, or replaces the one with the same id; the list stays newest first.
    function upsertClip(clips, clip) {
        const rest = clips.filter((c) => c.id !== clip.id);
        return sortNewestFirst([...rest, clip]);
    }

    const removeClip = (clips, id) => clips.filter((c) => c.id !== id);

    // Everybody named in the clips (whose screen or who saved it), sorted the Brazilian way.
    function people(clips) {
        const names = new Set();
        for (const clip of clips) {
            if (clip.sharer) names.add(clip.sharer);
            if (clip.requestedBy) names.add(clip.requestedBy);
        }
        return [...names].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
    }

    // scope: 'all' | 'mine'; person: '' for everybody, else a name that shared the screen or saved the clip.
    function filterClips(clips, { scope, person } = {}) {
        return clips.filter((clip) => {
            if (scope === 'mine' && clip.mine !== true) return false;
            if (person && clip.sharer !== person && clip.requestedBy !== person) return false;
            return true;
        });
    }

    // ---- the gallery: the player ---------------------------------------------------------------------------

    // The timeline of a clip: the file starts at a key frame, up to ~1 min before what was asked; playback starts at
    // `startOffsetS`, so the part before it is hidden. `mediaDuration` is what the file says (it may be Infinity).
    function playerRange(clip, mediaDuration) {
        const total =
            isNumber(mediaDuration) && mediaDuration > 0 ? mediaDuration : Number(clip && clip.durationS) || 0;
        const wanted = Number(clip && clip.startOffsetS) || 0;
        const start = clamp(wanted, 0, Math.max(total - 0.1, 0));
        return { start, end: total, length: Math.max(total - start, 0) };
    }

    // Position on the visible timeline (0 at the start of the clip) for a media time, and back.
    const toTimeline = (mediaTime, range) => clamp(mediaTime - range.start, 0, range.length);
    const toMedia = (timelineTime, range) => range.start + clamp(timelineTime, 0, range.length);

    // ---- the browser's persistent id ------------------------------------------------------------------------

    // The room keeps it in localStorage.peer_uuid, as a plain string (or, if a helper ever JSON-encodes it, a JSON
    // string). The server compares its HMAC with the hashes in the clip (header X-Replay-Peer).
    function readPeerUuid(storage) {
        let raw = '';
        try {
            raw = (storage && storage.getItem('peer_uuid')) || '';
        } catch {
            return '';
        }
        raw = String(raw).trim();
        if (raw.startsWith('"')) {
            try {
                const parsed = JSON.parse(raw);
                if (typeof parsed === 'string') raw = parsed;
            } catch {
                // keep the raw text
            }
        }
        // It goes into an HTTP header: visible ASCII only.
        return raw.replace(/[^\x21-\x7e]/g, '').slice(0, 100);
    }

    return {
        DEFAULT_MP4_RATIO,
        isClipId,
        formatClock,
        optionLabel,
        formatAgo,
        formatLeft,
        shortDuration,
        etaText,
        formatBytes,
        optionsAvailability,
        availableSeconds,
        queueText,
        mp4Status,
        estimateMp4Seconds,
        estimateText,
        learnRatio,
        mediaUrl,
        galleryUrl,
        sortNewestFirst,
        upsertClip,
        removeClip,
        people,
        filterClips,
        playerRange,
        toTimeline,
        toMedia,
        readPeerUuid,
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ReplayLogic;
else window.ReplayLogic = ReplayLogic;
