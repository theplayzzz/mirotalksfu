# Replay: the last minutes of a shared screen, as a clip

Anybody in the room can press a button on a shared screen and get a clip of its last 1, 2, 3 or 5 minutes. The
clip lands in a gallery everybody in the room can open, with a player and downloads. Nothing must be noticed by the
people sharing or watching: the recording is **passive** (one more silent viewer of every screen, living in its own
container and on its own CPU core) and nothing in the live path waits for it.

This file is the contract between the parts. Each part can be built and tested on its own against it.

```
sharer's browser ──WebRTC──► SFU (mirotalksfu container)
                              │  ReplayBridge: a "recorder router" on its own mediasoup worker gets a piped copy of
                              │  every screen (video + the screen's audio); one PlainTransport per share sends it as
                              │  plain RTP over the private network
                              ▼
                        Recorder (mirotalk-replay container, own core, low priority)
                              │  depacketizes, keeps the last minutes on disk (ring), builds clips on request,
                              │  converts to MP4 on demand, reports events to the SFU
                              ▼
                        /data/replays  (shared volume; the SFU only reads it)
                              ▲
viewers' browsers ◄── HTTP/SSE/Range ── SFU routes /replay/*  (gallery page, API, media)
```

## 1. Settings

SFU container: `REPLAY_ENABLED` (`true` turns on the bridge and the routes), `REPLAY_UI_ENABLED` (shows the buttons,
announced to browsers by `/config`), `REPLAY_RECORDER_URL` (`http://mirotalk-replay:7000`), `REPLAY_INTERNAL_SECRET`,
`REPLAY_DATA_DIR` (`/data/replays`, read only), `REPLAY_PORT_MIN`/`REPLAY_PORT_MAX` (UDP ports of the plain
transports, `52000`-`52999`), `REPLAY_MAX_SECONDS` (`300`).

Recorder container (same image, `command: node app/src/replay/Recorder.js`): `REPLAY_LISTEN_PORT` (`7000`),
`REPLAY_DATA_DIR` (`/data/replays`, read/write), `REPLAY_SFU_EVENTS_URL` (`http://mirotalksfu-dev:3010/internal/replay/events`),
`REPLAY_INTERNAL_SECRET`, `REPLAY_BUFFER_SECONDS` (`300`), `REPLAY_LEAD_IN_SECONDS` (`90`, extra kept so a clip can start
at a key frame), `REPLAY_KEEP_AFTER_END_S` (`120`), `REPLAY_RETENTION_DAYS` (`7`), `REPLAY_QUOTA_GB` (`20`),
`REPLAY_MIN_FREE_GB` (`10`), `REPLAY_MP4_HEIGHT` (`720`), `REPLAY_FFMPEG_THREADS` (`2`).

Both authenticate to each other with the header `X-Replay-Secret: <REPLAY_INTERNAL_SECRET>` (constant time compare).
The recorder API is only reachable on the private Docker network.

## 2. Vocabulary

- **share**: one screen being shared, identified by `shareId` = the id of the mediasoup video producer of the screen.
- **key frame** (a full picture): a clip can only start at one. The recorder keeps `REPLAY_LEAD_IN_SECONDS` more than
  the buffer so there is always one before the start asked for; the clip file begins at that key frame and the player
  starts at `startOffsetS` inside it.
- **media time** (`tsMs`): milliseconds on one wall clock for every stream of a share, from RTCP Sender Reports (NTP
  to RTP timestamp mapping), falling back to arrival time until the first report. It is what keeps audio and video
  in sync.

## 3. Recorder control API (HTTP, JSON)

All requests carry `X-Replay-Secret`. Errors: `{ "error": "message", "code": "SHORT_CODE" }` with a 4xx/5xx status.

| request | body | answer |
|---|---|---|
| `GET /v1/health` | | `{ ok, version, diskFreeGb, shares, conversions: { running, queued }, cpuPercent }` |
| `POST /v1/shares` | `{ shareId, roomId, peerName, video: Stream, audio?: Stream }` | `{ port }` (UDP port the recorder listens on for this share) |
| `PATCH /v1/shares/:shareId` | `{ audio?: Stream, paused?: boolean }` | `{ ok: true }` (audio can join after the video; `paused` stops writing without losing what exists) |
| `DELETE /v1/shares/:shareId` | | `{ ok: true }` (the buffer stays `REPLAY_KEEP_AFTER_END_S` more seconds so a clip can still be made) |
| `GET /v1/shares` | | `{ shares: [{ shareId, roomId, peerName, startedAt, ended, codec, hasAudio, bufferSeconds, bytes }] }` |
| `POST /v1/clips` | `{ shareId, seconds, requestedByName, requestedByHash, sharerHash, requestId }` | the clip metadata (section 5), after the file exists (target: under 3 s) |
| `GET /v1/clips` | | `{ clips: [meta...] }` newest first |
| `GET /v1/clips/:id` | | meta |
| `DELETE /v1/clips/:id` | | `{ ok: true }` |
| `POST /v1/clips/:id/mp4` | | `{ state, progress, etaSeconds }`: starts the conversion, or reports the running or finished one |

`Stream` = `{ codec: "VP8" | "H264" | "opus", payloadType, ssrc, clockRate, channels?, fmtp? }` with the values of the
mediasoup consumer's `rtpParameters`. The recorder demultiplexes the RTP of a share (video and audio arrive on the same
UDP socket) by SSRC. RTCP (Sender Reports in, NACK and PLI out) travels on the same socket (`rtcpMux`).

Events the recorder posts to `REPLAY_SFU_EVENTS_URL` (with the secret header, retried a few times; the SFU relays them
to the browsers):

```
{ "type": "clip.created",  "clip": meta }
{ "type": "clip.deleted",  "id": "..." }
{ "type": "mp4.progress",  "id": "...", "progress": 0.42, "etaSeconds": 17 }
{ "type": "mp4.ready",     "id": "...", "mp4": { "name": "clip.mp4", "bytes": 123 } }
{ "type": "mp4.error",     "id": "...", "message": "..." }
{ "type": "buffers",       "shares": [{ "shareId", "bufferSeconds", "codec", "hasAudio" }], "diskFreeGb": 80 }   // every 5 s
```

## 4. Disk layout (`REPLAY_DATA_DIR`)

```
buffers/<shareId>/         ring of the last minutes: frame log chunks (about 10 s each) + a small index
clips/<clipId>/            clip.webm | clip.mkv (original), clip.mp4 (when converted), thumb.jpg, meta.json
```

A clip id is `^[a-z0-9-]{8,64}$`. Everything the recorder writes for a clip is written to a temporary name and renamed
when complete, so the SFU never serves a half written file. The frame log is the recorder's own format (a record per
frame: kind, key flag, media time, length, bytes); nothing outside the recorder reads it.

## 5. Clip metadata (`meta.json`, and what the recorder API returns)

```json
{
  "id": "20261003-141502-3f9a2c1b-x7k2",
  "shareId": "...", "roomId": "link",
  "createdAt": 1791036902000, "expiresAt": 1791641702000,
  "sharer": "Beltrano", "requestedBy": "Fulano",
  "seconds": 60, "durationS": 63.4, "startOffsetS": 3.4,
  "codec": "vp8", "hasAudio": true,
  "files": { "original": { "name": "clip.webm", "mime": "video/webm", "bytes": 88123456 },
             "mp4": null },
  "thumb": "thumb.jpg",
  "requestedByHash": "…", "sharerHash": "…"
}
```

`durationS` is the length of the file; `startOffsetS` is where playback must start so the clip begins exactly
`seconds` before the click (the lead-in before it is hidden). The two hashes are server side only and are removed
before anything goes to a browser. VP8 shares make a WebM; H.264 shares make an MP4 directly (so `files.mp4` is
already set, no conversion needed).

## 6. SFU side

### Bridge (`app/src/replay/ReplayBridge.js`)

- A dedicated mediasoup worker with its own router (the "recorder router"), outside the round robin of the room workers.
- When a screen video producer is created, and when its audio producer (`appData.source === 'screen'`,
  `appData.shareOf === <screen producer id>`) is created: `router.pipeToRouter` to the recorder router, one
  `PlainTransport` per share (`rtcpMux: true`, `comedia: false`, `listenInfo` on `REPLAY_PORT_MIN..MAX`), connect it
  to the recorder's port, `consume` with the capabilities of `recorderCapabilities()` and register the streams with
  `POST /v1/shares` (video) and `PATCH` (audio). **The consumers must NOT be made with the router's own capabilities:**
  those carry `transport-cc`/`goog-remb` feedback and the transport-wide header extension, mediasoup then gives the plain
  transport a bandwidth estimate that starts at 600 kbps, the recorder never sends the feedback that would raise it, and
  the consumer is throttled to 600 kbps (found 2026-10-03: a screen with motion reached the recorder for ~3 s and then
  only as probing packets, SSRC 1234 payload type 127). `recorderCapabilities()` keeps nack, PLI and FIR and drops the
  rest (tests/replay/test-sfu-mediasoup.js checks it with the real mediasoup).
- The only key frame request it makes is the automatic one when the consumer is created. `RECORDER_KEYFRAME_SAFETY_S`
  (default 0 = off) asks one every N seconds, for senders whose encoder rarely sends key frames (H.264 in hardware).
- The recorder may restart (a crash, an out-of-memory kill): it keeps its ring on disk but forgets its registrations.
  Every sample the bridge compares what it sends with `GET /v1/shares`; a share that was registered more than 8 s ago and
  is not listed gets a new plain transport, new consumers and a new registration (`restartShare`), and the room's
  screen is recorded again without the sharer or the viewers doing anything (`tests/e2e/replay-recorder-restart.mjs`).
- Safety: it samples `worker.getResourceUsage()` of the room workers every 5 s; above 85% for 10 s, or less than
  `REPLAY_MIN_FREE_GB` free disk, it pauses the recorder consumers and tells the browsers `{ available: false }` until
  load is under 70% for 20 s. The live path always wins.

### Socket events (room)

| direction | event | payload |
|---|---|---|
| server → client | `replayTicket` | `{ ticket, expiresAt }` as soon as the person is in the room, to open the gallery session (below). The single room answers every join but the first with "locked" and sends the room later, so this is sent from the join **and** from the first `getRouterRtpCapabilities`, once per socket (`ReplayHub.attachSocket`) |
| server → room, every 5 s and on changes | `replayBuffers` | `{ available, reason?, maxSeconds, shares: [{ producerId, peerName, bufferSeconds, codec, hasAudio }] }` |
| client → server | `replayRequest` (ack) | `{ producerId, seconds }` → ack `{ ok: true, requestId }` or `{ error, code }`; limits: one request per 3 s per person, `seconds` in `[10, maxSeconds]` |
| server → requester | `replayStatus` | `{ requestId, state: "preparing" \| "done" \| "error", clip?, message? }` |
| server → room | `replayCreated` | `{ clip (public meta), requestedBy, sharerPeerId }` |

### HTTP (`/replay/*`, registered before the catch-all `/:roomId`)

Access cookie `replay_access` (JWT, scope `replay-view`, HS256, key derived from the server secret, `HttpOnly; Secure;
SameSite=Lax; Path=/replay/; Max-Age=30 days`). Created by:

- `POST /replay/api/session` `{ ticket }`: one-time ticket from `replayTicket` (people who are in the room);
- `POST /replay/api/login` `{ password }`: the room password (people who are not in the room), rate limited.

| request | answer |
|---|---|
| `GET /replay/` | the gallery page (`public/views/Replay.html`; it shows a password form when the API says 401). Query: `clip=<id>` opens that clip, `from=room` makes "back to the room" close the tab. |
| `GET /replay/api/me` | `{ ok: true }` or 401 |
| `GET /replay/api/clips` | `{ clips: [publicMeta + mine: bool], now, retentionDays }` newest first |
| `GET /replay/api/clips/:id` | public meta |
| `GET /replay/media/:id/:file` | `clip.webm`, `clip.mp4`, `thumb.jpg` with Range support, `Cache-Control: private`; download with `?download=1` (adds `Content-Disposition`) |
| `POST /replay/api/clips/:id/mp4` | `{ state: "ready" \| "queued" \| "running", progress, etaSeconds }` |
| `DELETE /replay/api/clips/:id` | `{ ok: true }`; allowed for who asked for the clip and for the sharer |
| `GET /replay/api/stream` | Server-Sent Events: `clip.created` `{clip}`, `clip.deleted` `{id}`, `mp4.progress`, `mp4.ready`, `mp4.error` (same payloads as in section 3), heartbeat comment every 25 s |

"Who asked / who shared" is checked with the header `X-Replay-Peer: <peer_uuid>` (the browser's persistent
`peer_uuid` from localStorage, the same value the room uses): the server compares `HMAC(secret, uuid)` with the hashes
in the clip and never returns them. Public meta never contains `requestedByHash`/`sharerHash`.

`/internal/replay/events` (POST, secret header) receives the recorder events and fans them out to the SSE clients
and, for `clip.created`, to the room as `replayCreated`.

## 7. Browser side

### In the room (`public/js/Replay.js`, `public/css/Replay.css`)

Off unless `/config` says `replay.enabled` (`{ enabled, maxSeconds, options: [60,120,180,300] }`).

- **Button** `⟲` on the hover bar of every screen tile, next to the pin button; only when `replayBuffers` lists that
  screen. A small `● Replay` badge in a corner of the tile while it is being kept. Hover shows a tooltip.
- **Popover** anchored to the button (not a modal, never SweetAlert2): "Salvar replay da tela de {nome}", "Disponível:
  últimos m:ss", four buttons `1 min` `2 min` `3 min` `5 min`; one click saves; options longer than the buffer are
  disabled with the hint "a tela começou há m:ss"; closes with Esc or a click outside.
- **Toasts** in the bottom left corner, stacked, outside the screens: *generating* (spinner, indeterminate bar),
  *saved* ("Replay salvo na galeria" with a **Ver ▸** link opening `/replay/?clip=<id>&from=room` in a new tab and an ✕;
  disappears after 8 s), *error* ("Não deu para gerar o replay — tente de novo"). Other people in the room get a
  discreet one: "{Fulano} salvou um replay da tela de {Beltrano} · Ver".
- **Gallery button** `🎞 Galeria` in the bottom bar with a counter of clips created since it was last opened;
  opens `/replay/?from=room` in a new tab.
- On `replayTicket` it posts the ticket to `/replay/api/session` once.
- Text in Portuguese (hard coded, like LivePix). Colours from the theme variables of `Room.css` (wine theme).

### Gallery (`public/views/Replay.html`, `public/js/ReplayGallery.js`, `public/css/ReplayGallery.css`)

- Header "LinkDoNotle · Replays", **Voltar para a sala** (`window.close()` when `from=room`, otherwise a link to `/join/link`).
- Filters `Todos` `Meus` and a person selector; newest first; cards with thumbnail, duration, whose screen, who saved,
  how long ago, time left before expiry and a `MP4 pronto` badge; new clips appear live (SSE); delete for the owner.
- A password form when the API answers 401 (people who did not come from the room).
- **Player**: own controls in the room's theme: play/pause, timeline you can drag, time, volume, speed `1x` `1,5x`
  `2x`, full screen, picture in picture; keys Space, ←/→ (5 s), F, M. The timeline starts at `startOffsetS` (the lead-in
  is hidden). Below it: whose screen, who saved, date, duration, **Baixar original** (immediate, with the note "pode
  começar até ~1 min antes") and **Baixar MP4**: when the MP4 exists it downloads at once, otherwise the button turns
  into a progress bar with the real percentage and the time left ("Convertendo para MP4… 58% · cerca de 25 s");
  "Na fila — 1 conversão na frente" when waiting; downloads by itself when ready; closing the tab does not cancel it.
  Before it starts it shows the estimate ("leva ~X s").
- Works on a phone width (single column).

## 8. Who builds what

| part | files |
|---|---|
| Recorder core (depacketizers, RTCP, Matroska writer, frame store, clip builder, MP4 converter, service) | `app/src/replay/*`, `tests/replay/*` |
| Room UI and gallery | `public/js/Replay.js`, `public/css/Replay.css`, `public/views/Replay.html`, `public/js/ReplayGallery.js`, `public/css/ReplayGallery.css`, a few hook lines in `RoomClient.js` / `Room.html` |
| SFU bridge, socket events, `/replay/*` routes, internal events, compose files, integration tests | `app/src/replay/ReplayBridge.js`, `app/src/Server.js`, `ops/*`, `tests/e2e/*` |

## 9. What replay must never do

- **Make a sound.** Not when the time kept reaches a minute, not when an option becomes available, not when a clip is
  saved (requested 2026-10-03). The room has its own sounds (`joined.wav` when a producer starts, `left.wav` when one
  ends, played by `RoomClient`); replay adds none. `tests/test-ReplayUi.js` forbids `new Audio`, `sound(`, Web Audio,
  speech and vibration in the replay files, and the end-to-end tests watch every sound a page tries to play.
- Make the live stream wait for it, or cost it anything: the viewers of a screen got 57 fps and no freezes while the
  recorder was being fed (their consumers are separate from the recorder's).
- Use SweetAlert2 (a leftover layer once froze the whole room).

Known limits: the "time kept" and the clip end at the newest frame, in media time. A capture that sends no frames at
all while nothing changes (a still desktop on some systems) shows the counter standing still between changes, and a clip
of the "last minute" ends at the last change. Chrome sends a refresh frame about once a second for window and tab
captures, which is why this does not show with them. The recorder's UDP receive buffer is whatever the host allows
(`net.core.rmem_max`, 208 KB by default: the recorder logs a warning); raising it is a host setting that needs the
owner's OK.

## 10. Tests

- Recorder: synthetic RTP made by FFmpeg (a test pattern with a beep, VP8+Opus and H.264+Opus) fed to the real UDP
  socket; the clips are checked with `ffprobe` (duration, first frame is a key frame, audio present) and decoded to
  nothing without errors; a flash and a beep at the same instant give the audio/video offset (must stay under 80 ms);
  lost and reordered packets; a restart of the recorder; the ring never grows past the limit.
- UI: a mock of the gallery API and a headless Chrome (CDP): list, player controls and speeds, downloads, MP4 progress,
  401 form, phone width, screenshots.
- Integration (dev instance): sharer and viewer in the test room, the viewer clicks the button, the clip shows up in
  the gallery and plays.
