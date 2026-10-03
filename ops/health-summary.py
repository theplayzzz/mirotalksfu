#!/usr/bin/env python3
"""Summarizes the room health meter files (see app/src/HealthMeter.js).

    python3 ops/health-summary.py /home/debian/mirotalk-dev/data/health            last 24 hours
    python3 ops/health-summary.py <dir> --hours 6 --peer Ana --room link

For every person it prints what the browser can do (encoder and decoder in hardware or software), how the
screens they SEND did (frame rate, what limited the encoder: cpu or bandwidth, key frames) and how the
screens they RECEIVE did (frame rate, freezes, dropped frames, key frames). Numbers are averages over the
reports (one every ~10 seconds) in the period.
"""
import argparse
import glob
import gzip
import json
import os
import time
from collections import defaultdict


def read_reports(directory, since_ms):
    for path in sorted(glob.glob(os.path.join(directory, "health-*.jsonl*"))):
        opener = gzip.open if path.endswith(".gz") else open
        try:
            with opener(path, "rt", encoding="utf-8") as handle:
                for line in handle:
                    try:
                        report = json.loads(line)
                    except ValueError:
                        continue
                    if report.get("ts", 0) >= since_ms:
                        yield report
        except OSError:
            continue


def mean(values, positive_only=False):
    values = [v for v in values if isinstance(v, (int, float)) and (v > 0 or not positive_only)]
    return sum(values) / len(values) if values else None


def fmt(value, digits=1, unit=""):
    return "-" if value is None else f"{value:.{digits}f}{unit}"


def percent(count, total):
    return None if not total else 100.0 * count / total


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory")
    parser.add_argument("--hours", type=float, default=24)
    parser.add_argument("--peer", help="only this person")
    parser.add_argument("--room", help="only this room")
    args = parser.parse_args()

    since = int((time.time() - args.hours * 3600) * 1000)
    people = defaultdict(lambda: {"env": None, "tx": [], "rx": [], "net": [], "reports": 0, "first": None, "last": None})
    for report in read_reports(args.directory, since):
        if args.peer and report.get("peer") != args.peer:
            continue
        if args.room and report.get("room") != args.room:
            continue
        person = people[report.get("peer", "?")]
        person["reports"] += 1
        person["first"] = person["first"] or report["ts"]
        person["last"] = report["ts"]
        if report.get("env"):
            person["env"] = report["env"]
        if report.get("net"):
            person["net"].append(report["net"])
        person["tx"].extend(t for t in report.get("tx", []) if t.get("type") == "screen")
        person["rx"].extend(r for r in report.get("rx", []) if r.get("type") == "screen")

    if not people:
        print("no reports in that period")
        return

    for name in sorted(people):
        person = people[name]
        minutes = (person["last"] - person["first"]) / 60000 if person["last"] else 0
        print(f"\n=== {name}   {person['reports']} reports over {minutes:.0f} min")
        env = person["env"]
        if env:
            caps = env.get("caps", {})
            print(f"  browser: {env.get('browser', '?')} on {env.get('os', '?')}, {env.get('cores', '?')} cores, {env.get('mem', '?')} GB")
            print(
                f"  can do (1080p60):  encode VP8 {caps.get('vp8e', '?')}, H.264 {caps.get('h264e', '?')}"
                f"   |   decode VP8 {caps.get('vp8d', '?')}, H.264 {caps.get('h264d', '?')}    (hw = hardware, sw = software, !smooth = may stutter)"
            )
        net = person["net"]
        if net:
            print(
                f"  network: rtt {fmt(mean([n.get('rtt') for n in net]), 0, ' ms')},"
                f" estimate up {fmt(mean([n.get('aout') for n in net], True), 0, ' kbps')} / down {fmt(mean([n.get('ain') for n in net], True), 0, ' kbps')}"
            )

        tx = person["tx"]
        if tx:
            samples = len(tx)
            seconds = samples * 10
            encoders = sorted({t.get("enc") for t in tx if t.get("enc")})
            print(f"  SENDING a screen ({samples} samples):")
            print(
                f"    {fmt(mean([t.get('fps') for t in tx]), 1)} fps at {fmt(mean([t.get('w') for t in tx]), 0)}px wide,"
                f" {fmt(mean([t.get('kbps') for t in tx]), 0, ' kbps')} (target {fmt(mean([t.get('tgtKbps') for t in tx]), 0)})"
            )
            print(
                f"    limited by cpu {fmt(percent(sum(1 for t in tx if t.get('lim') == 'cpu'), samples), 0, '%')},"
                f" by bandwidth {fmt(percent(sum(1 for t in tx if t.get('lim') == 'bandwidth'), samples), 0, '%')} of the time;"
                f" encoder {', '.join(encoders) or '?'}{' (hardware)' if any(t.get('hw') for t in tx) else ''},"
                f" {fmt(mean([t.get('encMs') for t in tx]), 1, ' ms')} per frame"
            )
            print(
                f"    key frames {fmt(sum(t.get('kf', 0) for t in tx) / max(1, seconds / 60), 1)}/min,"
                f" key frame requests {fmt(sum(t.get('pli', 0) for t in tx) / max(1, seconds / 60), 1)}/min,"
                f" rtt {fmt(mean([t.get('rtt') for t in tx]), 0, ' ms')}, loss {fmt(mean([t.get('lost') for t in tx]), 2, '%')}"
            )

        rx = person["rx"]
        if rx:
            samples = len(rx)
            minutes_rx = max(1.0, samples * 10 / 60)
            decoders = sorted({r.get("dec") for r in rx if r.get("dec")})
            print(f"  RECEIVING screens ({samples} samples):")
            print(
                f"    {fmt(mean([r.get('fps') for r in rx]), 1)} fps at {fmt(mean([r.get('w') for r in rx]), 0)}px wide,"
                f" {fmt(mean([r.get('kbps') for r in rx]), 0, ' kbps')}; decoder {', '.join(decoders) or '?'}"
                f"{' (hardware)' if any(r.get('hw') for r in rx) else ''}"
            )
            freezes = sum(r.get("frz", 0) for r in rx)
            print(
                f"    freezes {freezes} ({fmt(sum(r.get('frzMs', 0) for r in rx) / 1000, 1, ' s')} frozen),"
                f" dropped frames {fmt(sum(r.get('drop', 0) for r in rx) / minutes_rx, 1)}/min,"
                f" key frames {fmt(sum(r.get('kf', 0) for r in rx) / minutes_rx, 1)}/min,"
                f" loss {fmt(mean([r.get('loss') for r in rx]), 2, '%')}, jitter buffer {fmt(mean([r.get('jbMs') for r in rx]), 0, ' ms')}"
            )


if __name__ == "__main__":
    main()
