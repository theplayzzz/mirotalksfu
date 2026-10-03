# Measurements

Numbers behind the decisions, with how they were taken, so they can be repeated. Newest first.

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
