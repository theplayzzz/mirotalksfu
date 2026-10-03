# Measurements

Numbers behind the decisions, with how they were taken, so they can be repeated. Newest first.

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
1080p window (~950 px tiles) keeps all frames. H.264 screens (`SCREEN_CODEC`) are `L1T1`: they have nothing to reduce,
only the pause.

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
