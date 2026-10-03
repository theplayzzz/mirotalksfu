# Diagnosing a bad stream: what is recorded and how to read it

When somebody says "that screen is stuttering", the question is always the same: is it the sender's capture, the sender's
PC, the sender's internet, the viewer's PC, the viewer's internet, something we do on purpose (fewer frames for a small
tile), a change we made to the server, or the server itself? The health meter records enough to answer, for any minute of
any day, without asking anybody to reproduce it.

## What is recorded

One file per day, `health-YYYY-MM-DD.jsonl` (older days gzipped, 14 days kept), in `HEALTH_DIR` (`/data/health` in the
container, `/home/debian/mirotalksfu/data/health` on the server). Three kinds of lines, all with `ts` (ms) and `bld` (the
commit of the server's image, 7 characters):

| line | written by | when | what it says |
|---|---|---|---|
| `{"kind":"epoch", "flags":…}` | the server | every start | the commit, the day it was built, and every switch that changes what people see (`sel=adaptive kfd=1000 replay=1 codec=vp8 layers=1 guard=observe pause=0`). The analysis splits the day into epochs here |
| a report with `peer`, `rx`, `tx`, `net` | each browser | every 10 s | what that browser sends (`tx`) and receives (`rx`), `cb` (the commit of the PAGE it runs: an old tab shows up), `vis` (the page is visible or hidden) |
| `{"kind":"srv", "workers":…, "producers":…, "consumers":…}` | the server | every 10 s | what the SERVER sees: how each screen arrives (score, bitrate, loss, round trip), what it sends to each viewer (bitrate, the layer, mediasoup's score) and the load of every worker as a share of a core |

Names are the ones people typed in the room, kept only here, never sent back to anybody.

### A sender's row (`tx`)

| field | meaning | what it tells |
|---|---|---|
| `fps`, `w`, `h`, `kbps`, `tgtKbps` | frames per second the encoder made, its picture size, what was sent and what the browser aimed for | the result |
| `srcFps`, `srcW`, `srcH` | frames per second the **capture** gave, and the size of the captured screen (a 2K screen says 2560x1440 here and 1920x1080 in `w`/`h`) | low `srcFps` with an idle encoder = the capture is the problem |
| `setW`, `setH`, `setFps` | what `getSettings()` says the browser made of the capture request | the constraints were honoured or not |
| `encMs` | milliseconds per frame in the encoder | with `fps`: `encMs x fps / 1000` = how busy the encoder is (1 = busy all the time) |
| `lim`, `limCpuMs`, `limBwMs` | what the browser says limits the picture and for how long in the interval | the browser's own opinion; it can say `none` while frames are being dropped |
| `scale`, `maxKbps`, `maxFps`, `degr`, `hint` | what the encoder was told: size divisor, bitrate and frame-rate ceilings, `degradationPreference`, `contentHint` | `degr=maintain-resolution` or `hint=detail` drop frames instead of shrinking the picture |
| `codec`, `enc`, `hw` | codec, encoder implementation (hidden by the browser unless it has a permission), hardware or not | |
| `lost`, `rtt`, `retx`, `nack`, `pli`, `kf`, `huge`, `qlr`, `sendMs` | loss the server reports back, round trip, share of what was sent that was a repeat, NACK/PLI/key frame counts, picture-size changes, pacing delay | the sender's line |
| `gRung`, `gWhy`, `gMode` | the sender guard's step on its ladder (0 = full size), why, and whether it applies or only observes | |

### A viewer's row (`rx`)

| field | meaning |
|---|---|
| `fps`, `w`, `h`, `kbps` | what arrived |
| `loss`, `nack`, `pli`, `jbMs` | packets lost on the way to this viewer, requests for repeats, jitter buffer |
| `frz`, `frzMs`, `drop`, `pause` | freezes (and their time, credited when they end, so one sample can hold more than 10 s), frames dropped before they were shown, pauses |
| `decMs`, `dec`, `hw` | milliseconds per frame in the decoder (`decMs x fps / 1000` = how busy it is), implementation, hardware or not |
| `tl`, `lw`, `tw` | the temporal layer this viewer asked the server for (0 = a quarter of the frames, 2 = all), **why** (`full`, `tile`, `struggle`, `floor`), and the width of its tile |

`env` (once per page load): browser, OS, cores, memory, `gpu`, `scr` (screen size and pixel ratio), and what the browser says it can
encode and decode in hardware or software for VP8, VP9, H.264 and AV1.

## Reading it

```bash
# every window of 5 minutes, with the most likely cause for each sender and each viewer (names hidden)
ssh ovh-mirotalk 'python3 - /home/debian/mirotalksfu/data/health --from 21:30 --to 22:30 --window 5' < ops/tools/health-diagnose.py
# the same with the names; another day; bigger windows
… --names   |   --day 2026-10-03   |   --window 10
```

The other scripts in `ops/tools/` (`health-windows.py`, `health-buckets.py`, `health-spike.py`) and `ops/health-summary.py`
look at the same files from other sides (frozen share by window, minute by minute, per viewer).

### The rules (`health-diagnose.py`)

For a **sender**, in a window:

| cause | condition |
|---|---|
| `uplink` | loss reported back >= 4%, or repeats >= 15% of what is sent, or round trip >= 450 ms while the browser says bandwidth limits it |
| `capture` | the capture gives < 48 fps while the encoder is busy < 70% of the time (with `srcFps`; without it the label is `capture?`: low frame rate with an idle encoder) |
| `encoder` | the encoder is busy >= 85% of the time, or frames the capture gave never came out of it (`fps` < 75% of `srcFps`) |
| `ok` | >= 54 fps and none of the above |

For a **viewer**:

| cause | condition |
|---|---|
| `viewer-cpu` | frames dropped before being shown > 8%, or the decoder busy > 65%, with loss < 2% |
| `sender-uplink` | loss >= 3% while some sender in the window is `uplink` |
| `viewer-network` | loss >= 3% and every sender is fine |
| `layer-reduced` | it asked for fewer frames (`tl` < 2): not a fault |
| `server` | three or more viewers lose packets together, with two or more senders fine and a busy worker (> 80% of a core) |

### Telling "the internet" from "our change"

* **Same person, before and after a build:** the `epoch` lines and `bld` split the day; compare the same sender or viewer in the windows
  on either side of a change (the diagnosis prints the server build and the builds of the pages of each window).
* **A tab that did not reload:** `cb` differs from `bld`. Its behaviour is that of the old page.
* **One person bad, the rest fine:** their PC or their line. **Everybody bad at once while the senders are fine and a worker is
  busy:** the server. **One sender bad for every viewer:** the sender (`srv` says it arrives badly: producer score low).
* **The server's score:** mediasoup scores every stream 0-10. A screen that arrives with a low `producers[].score` was already bad when it
  reached us; one that arrives well and leaves badly to one viewer (`consumers[].score` low for that `to`) is that viewer's problem.

Switches and builds are never a guess: the `epoch` line says exactly what was on.
