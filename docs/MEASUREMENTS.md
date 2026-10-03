# Measurements

Numbers behind the decisions, with how they were taken, so they can be repeated. Newest first.

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

So a thumbnail costs 40% instead of 100%, a hidden tile (paused) 0%. `ScreenQuality.js` picks T0 for a tile up to 30%
of the screen's width, T1 up to 45% and everything above, so a 2x2 grid on a 1080p window keeps all frames. H.264
screens (`SCREEN_CODEC`) are `L1T1`: they have nothing to reduce, only the pause.

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
