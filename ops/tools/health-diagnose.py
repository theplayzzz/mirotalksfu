#!/usr/bin/env python3
"""Where does a bad stream go bad? Reads the health meter files (browsers' reports and the server's own "srv" records) and, for
every window of time, labels each sender and each viewer with the most likely cause of what they got.

    python3 health-diagnose.py DIR                        today, windows of 5 minutes
    python3 health-diagnose.py DIR --day 2026-10-03 --from 21:30 --to 22:30 --window 10 --names

Causes for a SENDER (a screen it sends):
  capture    the screen capture gives few frames while the encoder has time and the picture is moving (the source is slow:
             Chrome converts and scales every captured frame on the processor and may use at most half of the time for it,
             so a whole 1440p screen, or a game using the GPU, can leave 16-32 fps: fps = 500 / milliseconds per captured
             frame). A smaller picture for the ENCODER does not fix it; a smaller capture may
  still      few frames and few bits: a screen that hardly changes (the capture gives frames only when it changes). Not a problem
  encoder    the encoder is busy nearly all the time, or frames the source gave never came out of it (the PC is overloaded).
             The time per frame of a hardware encoder (the graphics card's) is a delay, not a load: it is not counted as busy
  uplink     the way from the sender to the server loses packets / repeats a lot / has a long round trip while limited by bandwidth
  ok         about 60 fps and none of the above
Causes for a VIEWER (what it got of the screens):
  viewer-cpu      the browser dropped frames before showing them or the decoder was busy, without packet loss
  viewer-network  packets lost on the way to the viewer from a sender that is itself fine
  sender-<cause>  the picture was bad because its sender was (the cause above)
  layer-reduced   fewer frames on purpose (the layer the viewer asked of the server)
  server          several viewers lost packets at the same time with senders that were fine and a busy worker or low scores
  ok
Old records without the newer fields still work: the rules fall back to what they have (the label says so with a '?').
Names are hidden unless --names is given.
"""
import argparse
import collections
import datetime
import glob
import gzip
import json
import os
import re

FPS_TARGET = 60.0
MOVING_KBPS = 1500  # below this the picture hardly moves
PRESSURE = ["nominal", "fair", "serious", "critical"]


def read_records(directory, day):
    paths = sorted(glob.glob(os.path.join(directory, f"health-{day}.jsonl*")))
    for path in paths:
        opener = gzip.open if path.endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as handle:
            for line in handle:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue


def minutes(ts):
    d = datetime.datetime.utcfromtimestamp(ts / 1000)
    return d.hour * 60 + d.minute + d.second / 60.0


def hhmm(value):
    h, m = value.split(":")
    return int(h) * 60 + int(m)


def is_hardware(row):
    """The browser's own word (powerEfficientEncoder), or the name of the encoder when it does not say"""
    if row.get("hw") is True:
        return True
    if row.get("hw") is False:
        return False
    name = str(row.get("enc") or "")
    if not name or re.search(r"fallback|libvpx|openh264|libaom|dav1d|software", name, re.I):
        return False
    return bool(re.search(r"external|d3d11|mediafoundation|nvenc|amf|qsv|videotoolbox|vaapi|v4l2", name, re.I))


def busy(row):
    # the time per frame of a hardware encoder is the delay of its pipeline, not how busy it is
    if is_hardware(row):
        return 0.0
    return row.get("encMs", 0) * row.get("fps", 0) / 1000.0


def sender_cause(rows):
    """rows: tx rows of one sender in the window -> (cause, details)"""
    n = len(rows)
    mean = lambda key: sum(r.get(key, 0) for r in rows) / n
    fps, enc_busy = mean("fps"), sum(busy(r) for r in rows) / n
    have_source = all("srcFps" in r for r in rows)
    src = mean("srcFps") if have_source else None
    lost, retx, rtt = mean("lost"), mean("retx"), mean("rtt")
    kbps = mean("kbps")
    moving = "kbps" not in rows[0] or kbps >= MOVING_KBPS
    hardware = sum(1 for r in rows if is_hardware(r)) / n > 0.5
    bw_limited = sum(1 for r in rows if r.get("lim") == "bandwidth") / n > 0.4
    cpu_limited = sum(r.get("limCpuMs", 0) for r in rows) / max(1.0, sum(r.get("dt", 2000) for r in rows)) > 0.1
    encoder_text = "hardware" if hardware else "busy %4.2f" % enc_busy
    details = (
        f"fps {fps:4.1f}" + (f" (source {src:4.1f})" if src is not None else "")
        + "  encoder " + encoder_text
        + f"  {kbps:5.0f} kbps  loss {lost:4.1f}%  repeats {retx:4.1f}%  rtt {rtt:4.0f} ms"
    )
    if lost >= 4 or retx >= 15 or (rtt >= 450 and bw_limited):
        return "uplink", details
    given = src if src is not None else fps
    if given < FPS_TARGET * 0.8 and enc_busy < 0.7:
        if not moving:
            return "still", details
        if given > 0:
            details += f"  (capture takes ~{500.0 / given:4.1f} ms per frame)"
        return ("capture" if have_source else "capture?"), details
    if enc_busy >= 0.85 or cpu_limited or (src is not None and fps < src * 0.75):
        return "encoder", details
    if fps >= FPS_TARGET * 0.9:
        return "ok", details
    return "slow?", details


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory")
    parser.add_argument("--day", default=datetime.datetime.utcnow().strftime("%Y-%m-%d"))
    parser.add_argument("--from", dest="start", default="00:00")
    parser.add_argument("--to", dest="end", default="23:59")
    parser.add_argument("--window", type=int, default=5, help="minutes per window")
    parser.add_argument("--names", action="store_true", help="show the names of the people")
    args = parser.parse_args()

    start, end, window = hhmm(args.start), hhmm(args.end), args.window
    names = {}

    def who(name):
        name = name or "?"
        if args.names:
            return name[:14]
        names.setdefault(name, f"p{len(names) + 1}")
        return names[name]

    epochs = []
    cells = collections.defaultdict(lambda: {"tx": collections.defaultdict(list), "rx": collections.defaultdict(list), "srv": [], "builds": set(), "cb": set(), "press": collections.defaultdict(int)})
    for record in read_records(args.directory, args.day):
        m = minutes(record["ts"])
        if record.get("kind") == "epoch":
            epochs.append((m, record.get("bld"), record.get("flags")))
            continue
        if not (start <= m < end):
            continue
        key = int((m - start) // window)
        cell = cells[key]
        if record.get("bld"):
            cell["builds"].add(record["bld"])
        if record.get("kind") == "srv":
            cell["srv"].append(record)
            continue
        if record.get("cb"):
            cell["cb"].add(record["cb"])
        peer = who(record.get("peer"))
        if record.get("press") in PRESSURE:
            cell["press"][peer] = max(cell["press"][peer], PRESSURE.index(record["press"]))
        for row in record.get("tx", []) or []:
            if row.get("type") == "screen":
                cell["tx"][peer].append(row)
        for row in record.get("rx", []) or []:
            if row.get("type") == "screen":
                # newer records say who sends the stream: one line per (viewer, sender); older ones are grouped per viewer
                key = (peer, who(row["from"])) if row.get("from") else (peer, None)
                cell["rx"][key].append(row)

    print("epochs of the day (start of every server run: build and switches):")
    for m, build, flags in epochs:
        print(f"  {int(m // 60):02d}:{int(m % 60):02d}  build {build}  {flags}")
    print()

    for key in sorted(cells):
        cell = cells[key]
        t0 = start + key * window
        print(f"=== {int(t0 // 60):02d}:{int(t0 % 60):02d}-{int((t0 + window) // 60):02d}:{int((t0 + window) % 60):02d} UTC   server build {','.join(sorted(cell['builds'])) or '?'}   pages' builds {','.join(sorted(cell['cb'])) or '?'}")
        verdict = {}
        for peer, rows in sorted(cell["tx"].items()):
            if len(rows) < 2:
                continue
            cause, details = sender_cause(rows)
            verdict[peer] = cause
            pressure = PRESSURE[cell["press"][peer]] if peer in cell["press"] else None
            guard = [r for r in rows if r.get("gWhy")]
            extra = (f"  PC pressure {pressure}" if pressure else "") + (f"  guard rung {guard[-1].get('gRung', 0)} capture rung {guard[-1].get('gCap', 0)} ({guard[-1]['gWhy']})" if guard else "")
            print(f"  SEND  {peer:<14} {cause:<9} {details}{extra}")
        workers = [w.get("cpu", 0) for rec in cell["srv"] for w in rec.get("workers", [])]
        worker_peak = max(workers) if workers else None
        if worker_peak is not None:
            print(f"  server: busiest worker {worker_peak:.0f}% of a core")
        # server-side scores of the screens as they arrive (producer) and as they leave (consumer)
        pscores = collections.defaultdict(list)
        cscores = collections.defaultdict(list)
        for rec in cell["srv"]:
            for p in rec.get("producers", []):
                if p.get("score") is not None:
                    pscores[who(p.get("peer"))].append(p["score"])
            for c in rec.get("consumers", []):
                if c.get("score") is not None:
                    cscores[who(c.get("to"))].append(c["score"])
        for peer, scores in sorted(pscores.items()):
            print(f"  server sees the screen of {peer} arrive with score {sum(scores) / len(scores):.1f}/10")

        lossy_viewers = 0
        for (peer, sender), rows in sorted(cell["rx"].items(), key=lambda kv: (kv[0][0], kv[0][1] or "")):
            if len(rows) < 2:
                continue
            n = len(rows)
            seconds = 10.0 * n
            loss = sum(r.get("loss", 0) for r in rows) / n
            fps = sum(r.get("fps", 0) for r in rows) / n
            drops = sum(r.get("drop", 0) for r in rows)
            shown = sum(r.get("fps", 0) * 10.0 for r in rows)
            drop_rate = drops / max(1.0, shown + drops)
            have_decode = any("decMs" in r for r in rows)
            dec_busy = sum((r.get("decMs", 0) * r.get("fps", 0) / 1000.0) for r in rows) / n
            # Chrome credits a freeze when it ends, so one sample can hold more than its own 10 s: never show more than all of the time
            frozen = min(100.0, sum(r.get("frzMs", 0) for r in rows) / 1000.0 / seconds * 100)
            reduced = sum(1 for r in rows if r.get("tl") is not None and r.get("tl") < 2)
            tags = []
            if (drop_rate > 0.08 or dec_busy > 0.65) and loss < 2:
                tags.append("viewer-cpu")
            if loss >= 3:
                if sender is not None and sender in verdict:
                    # exact: this stream comes from that sender
                    tags.append(f"sender-{verdict[sender]}" if verdict[sender] != "ok" else "viewer-network")
                else:
                    bad_senders = [p for p, c in verdict.items() if c == "uplink"]
                    tags.append("sender-uplink" if bad_senders else "viewer-network")
                lossy_viewers += 1
            if reduced:
                tags.append("layer-reduced")
            if not tags:
                tags.append("ok" if frozen < 2 else "unknown")
            score = cscores.get(peer)
            extra = f"  server->viewer score {sum(score) / len(score):.1f}/10" if score else ""
            label = f"{peer} <- {sender}" if sender else peer
            print(f"  VIEW  {label:<22} {','.join(tags):<22} fps {fps:4.1f}  loss {loss:4.1f}%  dropped {100 * drop_rate:4.1f}%  decoder busy {(f'{dec_busy:4.2f}' if have_decode else '   -')}  frozen {frozen:4.1f}% of the time{extra}")
        healthy_senders = sum(1 for c in verdict.values() if c == "ok")
        if lossy_viewers >= 3 and healthy_senders >= 2 and (worker_peak is None or worker_peak > 80):
            print("  >>> several viewers lost packets together while senders were fine: look at the server")
        print()


if __name__ == "__main__":
    main()
