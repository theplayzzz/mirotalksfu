# Measurements

Numbers behind the decisions, with how they were taken, so they can be repeated. Newest first.

## What the room's worker costs, and what selective reception saves, 2026-10-03

`tests/e2e/worker-load.mjs` on the development instance (one vCPU of the VPS, a real sharer sending ~10 Mbps of VP8 in
one size with three frame rates). The server makes 10 virtual viewers (`app/src/DevLoad.js`: plain transports with SRTP,
one per viewer) that each consume the same screen four times, a layer chosen for each, and measures the CPU time of
the room's mediasoup worker over 25 s. Every viewer receives 12.5 Mbps per screen, 48.9 Mbps for four, which is what a
person sees today in the room.

| what each viewer asks for | worker CPU | sent by the server | per viewer | against today |
|---|---|---|---|---|
| nothing (1 viewer, 1 screen, to know the floor) | 4.4% | 12.5 Mbps | 12.5 | |
| **today: four screens in full** | **52.8%** | 489 Mbps | 48.9 | 100% |
| one screen in full, three thumbnails (T0, 15 fps) | 32.4% | 264 Mbps | 26.4 | 61% of the CPU, 54% of the traffic |
| four medium tiles (T1, 30 fps) | 34.8% | 287 Mbps | 28.7 | 66% |
| one screen in full, the other three hidden (paused) | 16.6% | 121 Mbps | 12.1 | 31% |
| every tab in the background (all paused) | 4.8% | 0 | 0 | 9% |

- One worker is one core, and 10 people watching four screens already use half of it; the 70-97% seen on busy nights
  of the real room is about 15-20 viewers of that kind. Selective reception takes a pinned layout to ~60% of today's
  load and anything hidden to a third or less, so a night at 97% would be at ~60%.
- **Spreading the room over several workers (step 1.3 of the plan) is not needed yet.** It is only worth building if,
  with selective reception on in production, the health meter still shows the worker above ~60% on busy nights.
- The first run of this tool printed zeros everywhere: its consumers had been made with the router's own capabilities,
  and mediasoup then throttles a plain-transport consumer to 600 kbps that nothing can raise (nobody sends feedback), so
  a screen of 10 Mbps is not forwarded at all. The same cause as the recorder's stuck counter (below).

## Replay on the development instance, 2026-10-03

Two Chrome pages against `mirotalk-dev` (a PC in Brazil, round trip ~200 ms): `tests/e2e/replay-flow.mjs` (the whole
trip of a clip), `replay-buffer-growth.mjs` (the "time kept" counter for three kinds of screen) and
`replay-live-impact.mjs` (what the recorder costs the people watching). The sharer is a 1080p60 animation with sound
and a clap board (a white flash and a beep every 2 s).

**A clip of 30 s, asked 41 s after the screen started:** ready **833 ms** after the click (target: under 3 s). A 35.7 s
WebM of 44 MB (30 s asked + 5.7 s from the previous key frame, hidden by the player), VP8 960x540 at 55 fps and Opus; the
first packet is a key frame and it decodes from start to end without an error. The MP4 took 50 s (1.7x the clip, with
one core and two ffmpeg threads for the recorder), 26 MB, H.264 + AAC, index at the front, 87 progress events from 0 to 1.

**Picture and sound** (sound minus picture, from the clap board, in the clip): -286 ms in the first seconds, then
-239, -195, -164, -162, -153, -174, -163, -160, -133, -88, -40, **-11, 7, 11, 10, -4, 4** from the 25th second on. The
recorder places a frame at the time mediasoup forwarded it; while the sender's bandwidth estimate is still growing (the
first ~25 s) its video waits in its own queue, so the picture comes up to 0.3 s after its sound (a live viewer gets the
same, the room's server forwards the same packets). Once the sender has settled the two are within ~15 ms. A clip of a
share that has been running for a while is all in the second state.

**The "time kept" counter** (what the room says is kept, every 5 s):

| the screen | before the fix | after |
|---|---|---|
| a game (constant motion, 5-12 Mbps) | **stuck at 2 s** for the whole share | 9, 14, 18 ... 73 s after 78 s |
| a desktop with a clock (a frame a second, bursts of movement) | grows 1:1 | grows 1:1 |
| a still desktop (nothing between bursts, no frames) | 15 s steps | 15 s steps: the counter and the clip follow the newest *frame* |

The cause of the stuck counter was the recorder's feed being throttled by mediasoup (bandwidth estimate of 600 kbps that
nothing could raise; see `docs/REPLAY.md`, section 6): tcpdump at the recorder showed only probing packets (SSRC 1234,
payload type 127) after the first ~3 s. With the real mediasoup: `availableOutgoingBitrate` is 600000 for a plain
consumer made with the router's capabilities and absent with `recorderCapabilities()`.

**What the recorder costs the people watching** (viewer of the same screen, 3 runs of 60 s each, replay on and off on
the same instance; the spread between runs is as big as the difference, so the honest reading is "no difference"):

| | replay off | replay on |
|---|---|---|
| frames per second the viewer decodes | 52 (46, 54, 56) | 55 (51, 58, 56) |
| freezes per run | 0.7 | 0 |
| frames dropped by the viewer | 63 | 39 |
| lost packets | 52 | 6 |
| received | 10.6 Mbps | 11.3 Mbps |
| key frames the sender made per run | 1.3 | 2 |
| key frame requests (PLI) the sender got | 0 | 0 |
| CPU of the SFU container (a single core, shared with the recorder's mediasoup worker) while busy | 8.5% | 11.5-13% |
| CPU of the recorder container (its own core) | - | ~13% |

**A person who joins a screen that is already being shared** waits for the next full picture (seconds from the
consumer being created to the first picture, 8 viewers one after another, warm sender):

| | median | the others |
|---|---|---|
| replay off, key frame limit 1000 ms | 1.4 s | 0.8 0.9 0.9 1.0 1.8 1.9 3.9 **10.1** |
| replay on, key frame limit 1000 ms | 1.5 s | 1.5 1.5 1.5 3.5 3.5 4.7 **9.0** (and 0.9 1.9 2.1 **9.2** in an earlier run) |
| replay on, no key frame limit | 6.4 s | 1.4 2.1 4.2 6.2 6.6 7.5 9.8 and one that never came in 30 s |

So replay does not change it, and the long waits are there without replay: a sender under load (this PC runs several
1080p software encoders) answers a request for a full picture slowly, now and then. The 1000 ms limit of
`KEYFRAME_REQUEST_DELAY_MS` was not worse than none in this test.

## Soak: one screen for 18.5 minutes, a clip of the whole buffer, two MP4 conversions, 2026-10-03

`tests/e2e/replay-soak.mjs` on the development instance (a sampler on the server wrote the container CPU/memory and the
size of the data folder every 30 s). One sharer (1080p60 animation, sound, clap board), one viewer.

| what | result |
|---|---|
| seconds the room says it keeps, every 30 s | 27, 57, 87 ... 297, **300 at 5.5 min and flat for the next 2.5 min**; never went back |
| size of the ring on disk | grew 107 MB per 1.6 min to **~575 MB at 6.5 min**, then 500-565 MB (5 min + the 90 s of slack, ~1.45 MB/s); 0 MB two minutes after the screen stopped |
| a clip of 5 min, asked after 8 min | ready in **2.8 s**; 326 s (300 s + 25.9 s up to the previous key frame), 472.7 MB; downloads whole (473 MB in 80 s on a ~50 Mbps line); VP8 + Opus, decodes from start to end without one error |
| picture and sound over the 5 minutes | 163 flashes and 163 beeps: median **-13 ms**, worst 34 ms |
| MP4 of the 5 min clip (720p, one core) | ready after **519 s** (the estimate given before it started was 535 s): 1.7 s of work per second of clip; 271 MB, H.264 + AAC, 300.0 s |
| a second MP4 asked while the first ran | said "queued, 1 ahead" with its own estimate, and was ready after the first (570 s) |
| recorder container | CPU 1-13% while recording, **102% (its single core) only while converting**; memory peaked at **829 MiB** (2 GiB limit), 83-90 MiB when idle |
| SFU container | CPU peak 32% (sharer + viewer + serving the 473 MB download), 224 MiB at most |

**The viewer's freezes in this run were not conclusive.** Chrome counted 149 freezes (53.9 s in total) over the 18.5
minutes at an average of 55 fps. The test PC was, during part of that time, decoding the 5 minute clip with ffmpeg,
looking for flashes and beeps and downloading 744 MB, and the soak only logs totals at the start and at the end, so these
freezes cannot be placed in time or told apart from the PC's own load. The clean comparison above (3 runs of 60 s with
nothing else running on the PC) had 0 freezes with replay on. What a real viewer sees with the recorder working is read
from production's health meter instead (next section).

## Production, the first minutes after the rollout, 2026-10-03

The swap was done at 21:14 UTC (18:14 in Brazil) with 8 people connected, all the switches on at once (health meter, key
frame limit 1000 ms, selective reception, replay and its interface). Read from the server and from the health meter of the
real viewers (`ops/health-summary.py`).

| what | result |
|---|---|
| time without the room | the old container stopped at 21:14:47.4 and the new one was healthy at 21:14:58.7: **11.3 s** (people reconnected by themselves within a minute: 11-14 connections) |
| the recorder with 3-4 real screens | 1.15 MB/s per screen (~9 Mbps) written; **0 packets lost, late or dropped**, 0 malformed, 8 MB receive buffer in effect; kernel UDP `RcvbufErrors` 0 |
| first replay saved by a friend | 84.7 s clip (60 s asked + 24.7 s up to the key frame), 106 MB, 1080p VP8 + Opus with thumbnail, built in **0.87 s** |
| its MP4 | ready after **89.9 s** (1.5 s of work per second of clip), 7.6 MB; the recorder container ran at ~99% of its core for that time and fell back to ~7% |
| the SFU container | 17-32% of one core with 3 screens and 11-14 connections; 350-380 MiB |
| people watching (health meter, 29-44 fps received at 1830-1920 px) | loss 0-0.3%, 0-3 freezes in 2-6 min of reports, jitter buffer 35-115 ms; the screen that was being sent ran at 31.8 fps and ~11 Mbps (encoder libvpx, not limited by cpu or bandwidth) |
| noise in the log | 311 "aborting with incomplete response" in Caddy (and as many `ECONNRESET` warnings in the SFU) right when the first clip was opened: the browser's video player cancelling its own range requests (`H3_REQUEST_CANCELLED`); two per minute afterwards |

## The gallery player: why the clip "never loaded", 2026-10-03 (night of the rollout)

The first people to open a clip in production waited a long time. `tests/e2e/replay-player-load.mjs` (a real Chrome
speaking HTTP/3 to the development instance, a PC in Brazil, round trip ~200 ms, a clip of 134 MB = 97.7 s of 1080p60
VP8: 60 s asked plus a **37.7 s lead-in**, the video before the part that was asked for that has to start at a key
frame) found it, and the numbers of the clip that production made first agree: its key frames were at 0, 34.7, 38.4 and
68.4 s, so a GOP of a real screen is ~30 s (not the 1-5 s of a recorder that controls its encoder).

| the player | first moving picture | requests for the file | MP4 asked for |
|---|---|---|---|
| first version: hid the lead-in by seeking past it, PC idle | **7.3 s** (1.8 s for the metadata, 6.1 s for the seek) | 1 | 0 |
| first version, PC busy (12 CPU loops on 12 threads, like a PC that runs a game) | **34.5 s** (33.6 s of seek), then it stuttered | 1 | 0 |
| now: plays from the first frame, PC idle | **0.8 s** | 1 | 0 |
| now: plays from the first frame, PC busy | **0.7 s**, and plays in real time (6.4 s in 6 s) | 2 | 0 |

The seek was never the network (the file came in one request, 54-82 MB in the first 7-40 s): a browser can show a
frame only after decoding the key frame and every frame up to it, 2,260 frames of 1080p here, so the cost was the
decoder's, and the busier the PC the longer. The conversion to MP4 was never started by the player: only the click on
"Baixar MP4" posts to `/replay/api/clips/:id/mp4` (the page does it from nowhere else; a UI test now fails if watching,
seeking, pausing or changing the speed asks for it). In production the person who opened a clip could see "Convertendo
para MP4..." because somebody else, who had waited for the same load, clicked the button: the progress is sent to
everyone who has that clip open.

What is left: **skipping inside a clip still decodes from the key frame before the target**, up to a GOP (~30 s of
1080p60) of frames, so a jump costs from a few seconds on a fast PC to many on a busy one. Only shorter GOPs fix it, and
the only way to get them is to ask the sender for key frames more often (`RECORDER_KEYFRAME_SAFETY_S`, off): each one is
~146 KB at 1080p and goes to the people watching live too.

## What a viewer can be spared: sizes do not work, frame rates do, 2026-10-03

The idea of selective reception is that a thumbnail or a hidden tile should not cost a viewer (and the server) the
full 12 Mbps of a screen. There are two ways to have a lighter version of a screen, and only one of them works with
Chrome sending through this server.

### Screen in 3 sizes (simulcast, `SCREEN_SIMULCAST_LAYERS=3`): the sender collapses

`tests/e2e/sender-layers.mjs` against the development instance (a PC in Brazil, round trip ~195 ms, no packet loss and
no NACK), Chrome 154 on Windows, VP8, a 1080p60 animation (much harder to encode than most games).

| the sharer sends | what it really gets out |
|---|---|
| 1 size (L1T3), max 12 Mbps | 60 fps, ~11.7 Mbps, bandwidth estimate climbs to 10-19 Mbps |
| 3 sizes, as the app sets them (max 600 kbps / 1.5 Mbps / 12 Mbps) | top size **5-7 fps, 1.7-2.0 Mbps**; middle 5-6 fps 0.6 Mbps; small 4-5 fps 0.23 Mbps; estimate stuck at 5.2-5.6 Mbps; encoder 11-18% of a core |

The source delivers 60 fps to the encoder; the encoder drops frames because the top size is only allocated about
**half of the estimate minus what the small sizes take** (the targets of the three always add up to ~0.46 x estimate),
and the estimate cannot grow because the sender uses only about half of it. What was tried in the real call, with no
effect: `x-google-max-bitrate` 15000 and 30000, `x-google-start-bitrate` 12000, no `scalabilityMode`, other maximums
for the top and the small sizes (300/800 kbps), removing `goog-remb` from the answer (the estimate then sits at a flat
6.7 Mbps instead of 5.2-5.6, same result). In a loopback call without a server (`tests/e2e/simulcast-loopback.mjs`,
round trip ~0) the same plateau appears (5.7 Mbps) and **is** lifted by `x-google-max-bitrate=30000` (estimate 30
Mbps, top size 12 Mbps at 48 fps) or by a 12 Mbps start bitrate (8-10 Mbps at 30-40 fps), so it is Chrome's bandwidth
estimate on a real path, not the encodings. Not understood well enough to fix; **sizes stay off** (the default is 1).
The code for them (sender, `ScreenQuality`, server) stays behind the setting and has unit tests, in case a future
Chrome or a different path behaves differently.

### Screen in one size with 3 frame rates (L1T3, the default): works today, no change at the sender

A VP8 `L1T3` screen has three temporal layers (T0 = 15 fps, T1 = 30 fps, T2 = 60 fps). The server can cut a viewer
down to T1 or T0 with `consumer.setPreferredLayers`. `tests/e2e/temporal-layers.mjs`, same setup:

| asked for | received | share of the bits |
|---|---|---|
| T2 (everything) | 59 fps, 11.9 Mbps | 100% |
| T1 | 30 fps, 7.1 Mbps | 60% |
| T0 | 15 fps, 4.6 Mbps | 39% |

So a thumbnail costs 40% instead of 100%, a hidden tile (paused) 0%. `ScreenQuality.js` picks T0 for a tile up to
450 px wide on the screen (CSS pixels, not device pixels), T1 up to 720 px and every frame above, so a 2x2 grid on a
1080p window (~950 px tiles) keeps all frames. H.264 screens (`SCREEN_CODEC`) are `L1T1`: they have nothing to reduce.

**The pause of hidden tiles and windows is not used (changed the evening of 2026-10-03).** The server can pause the
video of a consumer, and the rows above with "paused" are what that saves, but a paused video can only start again at
a new full picture from the sender: the median wait measured for a person who joins a screen that is already being
shared is 1.4-1.5 s, with waits of 9-10 s now and then (section on the recorder above). In production, the first
night, the people of the room found their screens stopped when they came back to the window ("não estava assim antes")
and the first version, which paused a tile out of sight after 1.5 s and everything after 3 s with the page hidden,
was taken out: `ScreenQuality.js` only chooses the frame-rate layer from the size of a tile that is on screen, a tile
out of sight keeps everything, and the server ignores a request to pause unless `SELECTIVE_PAUSE_HIDDEN=true` (which
also covers a tab that still runs the old page). A change of frame-rate layer needs no full picture.

## Key frame request limit (`KEYFRAME_REQUEST_DELAY_MS`), 2026-10-03

`tests/e2e/keyframe-delay.mjs` against the development instance (one core, one mediasoup worker), from a PC in
Brazil (round trip ~200 ms, VP8 in software). A sharer streams a 1080p60 animation; a normal viewer watches; a
"storm" viewer asks the sharer for a full frame (PLI) 5 times per second, like a viewer with packet loss does; new
viewers join during both phases.

| setting | key frames the sharer made under the storm | what the other viewer saw (storm / calm) | new viewer, median time to first image (storm) |
|---|---|---|---|
| 0 ms (no limit) | 2.34 per second | 58.6 / 58.3 fps, 0 freezes | 1.3 s |
| 400 ms | 2.45 per second | 56.9 / 56.7 fps, 3 / 1 freezes | 2.1 s |
| 1000 ms | **0.99 per second** | 50.9 / 53.9 fps, 10 / 5 freezes | 1.7 s |

- mediasoup already does not send a new request while one is pending, so with a round trip of ~200 ms the natural
  ceiling is ~2.4 per second. **400 ms therefore changes nothing here**; 1000 ms is the first value that bites.
- What the limit buys: at real 1080p a full frame is ~146 KB, six times a normal frame, so a storm costs the sharer
  ~2.8 Mbps and encoder time at 2.4 per second and half of that at 1 per second.
- The viewer-side numbers (fps, freezes, time to first image) vary more between runs of this link than between the
  settings (the calm phase of the 1000 ms run was already worse); they show no benefit and no clear harm. A viewer
  that joins right after another request waits at most the limit for its first image.
- Chosen for development: **1000 ms**. For production, enable it with the health meter on and compare the key frame
  counts per minute of the sharers before and after.
