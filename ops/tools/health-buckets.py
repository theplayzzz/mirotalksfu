#!/usr/bin/env python3
"""Viewer health of production in buckets of N minutes (UTC) and by frame-rate class, from the health meter files.
usage: python3 health-buckets.py DIR START END BUCKET_MIN"""
import glob, json, sys, datetime, collections

directory, start, end, bucket = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
rows = []
for path in sorted(glob.glob(f"{directory}/health-{today}.jsonl*")):
    for line in open(path):
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass

def minute_of_day(ts):
    d = datetime.datetime.utcfromtimestamp(ts / 1000)
    return d.hour * 60 + d.minute

def parse(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)

s, e = parse(start), parse(end)
buckets = collections.OrderedDict()
for r in rows:
    m = minute_of_day(r["ts"])
    if not (s <= m < e):
        continue
    key = s + ((m - s) // bucket) * bucket
    b = buckets.setdefault(key, {"n": 0, "sec": 0.0, "fps": 0.0, "frz": 0, "frzMs": 0, "peers": set(), "screens": set(), "low_n": 0, "low_frz": 0, "low_ms": 0, "low_sec": 0.0, "hi_n": 0, "hi_frz": 0, "hi_ms": 0, "hi_sec": 0.0})
    for x in r.get("rx", []):
        if x.get("type") != "screen":
            continue
        dt = r.get("dt", 10000) / 1000.0
        b["n"] += 1
        b["sec"] += dt
        b["fps"] += x.get("fps", 0)
        b["frz"] += x.get("frz", 0)
        b["frzMs"] += x.get("frzMs", 0)
        b["peers"].add(r.get("peer"))
        b["screens"].add(x.get("id"))
        if x.get("fps", 0) < 20:
            b["low_n"] += 1; b["low_frz"] += x.get("frz", 0); b["low_ms"] += x.get("frzMs", 0); b["low_sec"] += dt
        elif x.get("fps", 0) >= 40:
            b["hi_n"] += 1; b["hi_frz"] += x.get("frz", 0); b["hi_ms"] += x.get("frzMs", 0); b["hi_sec"] += dt

print("bucket(UTC)  viewers screens samples | fps  freezes/min frozen% | <20fps: freezes/min frozen% | >=40fps: freezes/min frozen%")
for key, b in buckets.items():
    if not b["n"]:
        continue
    minutes = b["sec"] / 60.0
    def rate(frz, sec):
        return frz / (sec / 60.0) if sec else float("nan")
    def pct(ms, sec):
        return ms / 1000.0 / sec * 100 if sec else float("nan")
    print(
        f"{key//60:02d}:{key%60:02d}      {len(b['peers']):>3}  {len(b['screens']):>3}  {b['n']:>5} | {b['fps']/b['n']:4.1f}  {b['frz']/minutes:6.2f}  {b['frzMs']/1000.0/b['sec']*100:5.1f}% |"
        f" {rate(b['low_frz'], b['low_sec']):6.2f} {pct(b['low_ms'], b['low_sec']):5.1f}% ({b['low_n']:>4}) | {rate(b['hi_frz'], b['hi_sec']):6.2f} {pct(b['hi_ms'], b['hi_sec']):5.1f}% ({b['hi_n']:>4})"
    )
