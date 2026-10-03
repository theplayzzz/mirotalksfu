#!/usr/bin/env python3
"""What the viewers' stats looked like minute by minute in a window (UTC): frozen share, loss, NACK, PLI, dropped frames, jitter buffer,
and how many viewers froze in that minute. Viewers are v1, v2, ... in order of first appearance.
usage: python3 health-spike.py DIR START END"""
import glob, json, sys, datetime, collections

directory, start, end = sys.argv[1], sys.argv[2], sys.argv[3]
today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
rows = []
for path in sorted(glob.glob(f"{directory}/health-{today}.jsonl*")):
    for line in open(path):
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass

def mod(ts):
    d = datetime.datetime.utcfromtimestamp(ts / 1000)
    return d.hour * 60 + d.minute

def parse(h):
    a, b = h.split(":")
    return int(a) * 60 + int(b)

s, e = parse(start), parse(end)
agg = collections.defaultdict(lambda: {"sec": 0.0, "frz": 0, "frzMs": 0, "loss": 0.0, "n": 0, "nack": 0, "pli": 0, "drop": 0, "jb": 0.0, "fps": 0.0, "frozen_viewers": set(), "viewers": set(), "kbps": 0.0, "rtt": 0.0})
for r in rows:
    m = mod(r["ts"])
    if not (s <= m < e):
        continue
    who = r.get("peer") or "?"
    for x in r.get("rx", []):
        if x.get("type") != "screen":
            continue
        a = agg[m]
        a["sec"] += r.get("dt", 10000) / 1000.0
        a["frz"] += x.get("frz", 0); a["frzMs"] += x.get("frzMs", 0)
        a["loss"] += x.get("loss", 0); a["n"] += 1
        a["nack"] += x.get("nack", 0); a["pli"] += x.get("pli", 0); a["drop"] += x.get("drop", 0)
        a["jb"] += x.get("jbMs", 0); a["fps"] += x.get("fps", 0); a["kbps"] += x.get("kbps", 0)
        a["viewers"].add(who)
        a["rtt"] += (r.get("net") or {}).get("rtt", 0)
        if x.get("frz", 0):
            a["frozen_viewers"].add(who)

print("min    frozen%  freezes  viewers(frozen/all) | loss%  nack  pli  drop | jitterbuf ms | fps  kbps | rtt")
for m in range(s, e):
    a = agg.get(m)
    if not a or not a["n"]:
        continue
    n = a["n"]
    print(f"{m//60:02d}:{m%60:02d}  {a['frzMs']/1000.0/a['sec']*100:6.1f}%  {a['frz']:6d}   {len(a['frozen_viewers'])}/{len(a['viewers'])}                 | {a['loss']/n:5.2f} {a['nack']:5d} {a['pli']:4d} {a['drop']:5d} | {a['jb']/n:6.0f}       | {a['fps']/n:4.1f} {a['kbps']/n:5.0f} | {a['rtt']/n:4.0f}")
