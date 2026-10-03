#!/usr/bin/env python3
"""Compares what the viewers of production saw in time windows (UTC), from the health meter files.
usage: python3 health-windows.py DIR 'label=HH:MM-HH:MM' ...   (today's file only)"""
import glob, json, sys, datetime, collections

directory = sys.argv[1]
windows = []
for spec in sys.argv[2:]:
    label, span = spec.split("=")
    a, b = span.split("-")
    windows.append((label, a, b))

today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
rows = []
for path in sorted(glob.glob(f"{directory}/health-{today}.jsonl*")):
    for line in open(path):
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass

def hhmm(ts):
    return datetime.datetime.utcfromtimestamp(ts / 1000).strftime("%H:%M")

for label, a, b in windows:
    n = 0
    seconds = 0.0
    fps_sum = 0.0
    kbps_sum = 0.0
    frz = 0
    frz_ms = 0
    loss_sum = 0.0
    drop = 0
    kf = 0
    pli = 0
    nack = 0
    jb = 0.0
    low = 0  # samples under 20 fps
    per_peer = collections.defaultdict(lambda: [0, 0, 0.0])
    for r in rows:
        t = hhmm(r["ts"])
        if not (a <= t < b):
            continue
        for x in r.get("rx", []):
            if x.get("type") != "screen":
                continue
            n += 1
            dt = r.get("dt", 10000) / 1000.0
            seconds += dt
            fps_sum += x.get("fps", 0)
            kbps_sum += x.get("kbps", 0)
            frz += x.get("frz", 0)
            frz_ms += x.get("frzMs", 0)
            loss_sum += x.get("loss", 0)
            drop += x.get("drop", 0)
            kf += x.get("kf", 0)
            pli += x.get("pli", 0)
            nack += x.get("nack", 0)
            jb += x.get("jbMs", 0)
            if x.get("fps", 0) < 20:
                low += 1
            p = per_peer[r.get("peer", "?")]
            p[0] += 1
            p[1] += x.get("frz", 0)
            p[2] += x.get("frzMs", 0)
    if not n:
        print(f"{label}: no samples")
        continue
    minutes = seconds / 60.0
    print(
        f"{label} {a}-{b}: {n} samples ({minutes:.0f} viewer-screen-minutes) | fps {fps_sum/n:.1f} | {kbps_sum/n:.0f} kbps | "
        f"freezes {frz/minutes:.2f}/min, frozen {frz_ms/1000.0/seconds*100:.1f}% of the time | loss {loss_sum/n:.2f} | "
        f"dropped {drop/minutes:.1f}/min | key frames {kf/minutes:.1f}/min | PLI {pli/minutes:.1f}/min | NACK {nack/minutes:.0f}/min | "
        f"jitter buffer {jb/n:.0f} ms | samples under 20 fps {100.0*low/n:.0f}%"
    )
    worst = sorted(per_peer.items(), key=lambda kv: -kv[1][2])[:3]
    print("    frozen seconds by viewer (top 3, names hidden):", [f"v{i+1}: {w[1][2]/1000.0:.0f}s in {w[1][0]} samples" for i, w in enumerate(worst)])
