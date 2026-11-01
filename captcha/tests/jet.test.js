import test from "node:test";
import assert from "node:assert/strict";
import { Jet } from "../src/games/dodging.js";
import { COLUMN_BOUNDS, spacedColumn } from "../src/games/column-layout.js";
import { seeded } from "../src/games/kit.js";
import { bots } from "./strategies.js";
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("jet gates have one spaced file, stay clear of the opening and preserve their layout while moving", () => {
  const g = new Jet({ random: seeded(3), bodyHit: () => false }),
    saved = new Map();
  while (!g.finished) {
    for (const gate of g.gates) {
      const layout = JSON.stringify({
        gap: gate.gap,
        gapSize: gate.gapSize,
        parts: gate.parts,
      });
      if (saved.has(gate.id)) assert.equal(layout, saved.get(gate.id));
      else saved.set(gate.id, layout);
      assert.equal(new Set(gate.parts.map((p) => p.x)).size, 1);
      for (const side of ["top", "bottom"]) {
        const parts = gate.parts.filter((p) => p.side === side);
        assert.ok(parts.length >= 1 && parts.length <= 9);
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          assert.equal(p.size, 54);
          assert.equal(p.rotation, Math.PI * 1.25);
          assert.equal(p.flipY, true);
          assert.ok(p.y + COLUMN_BOUNDS.top >= g.track.top - 1e-6);
          assert.ok(p.y + COLUMN_BOUNDS.bottom <= g.track.bottom + 1e-6);
          if (i) {
            const gap =
              p.y - parts[i - 1].y - (COLUMN_BOUNDS.bottom - COLUMN_BOUNDS.top);
            assert.ok(gap >= 3 && gap <= 16);
          }
        }
        if (side === "top")
          close(
            parts.at(-1).y + COLUMN_BOUNDS.bottom,
            gate.gap - gate.gapSize / 2,
          );
        else close(parts[0].y + COLUMN_BOUNDS.top, gate.gap + gate.gapSize / 2);
      }
    }
    g.step(0.05);
  }
  assert.ok(saved.size > 20);
});

test("jet narrows its openings, accelerates by half-time and forces larger height changes", () => {
  const g = new Jet({ intensity: 1, random: seeded(3) });
  close(g.speed, 400);
  close(g.opening, 150);
  assert.ok(g.gates[0].parts.filter((p) => p.side === "top").length >= 4);
  assert.ok(g.gates[0].parts.filter((p) => p.side === "bottom").length >= 4);
  g.elapsed = 12.5;
  const peak = g.speed;
  close(peak, 720);
  close(g.opening, 112);
  g.elapsed = 25;
  assert.equal(g.speed, peak);
  close(g.opening, 92);
  let previous = 270;
  for (let i = 0; i < 1000; i++) {
    const next = g.nextGap(previous);
    assert.ok(next >= 177 && next <= 363);
    assert.ok(
      Math.abs(next - previous) >= 44 - 1e-7 &&
        Math.abs(next - previous) <= 96 + 1e-7,
    );
    previous = next;
  }
  assert.equal(spacedColumn(0, 82, 0).length, 0);
});

test("the revised jet remains playable with mouse only and actual PNG alpha at every intensity", () => {
  for (const intensity of [0.7, 0.9, 1.5])
    for (let seed = 1; seed <= 12; seed++) {
      const g = new Jet({
        intensity,
        random: seeded(seed),
      });
      while (!g.finished) {
        bots.jet(g);
        g.step(1 / 60);
      }
      assert.equal(
        g.reason,
        "survived",
        `intensity ${intensity}, seed ${seed}, time ${g.elapsed}`,
      );
    }
});

test("staying at one altitude no longer survives the changing corridor", () => {
  for (const seed of [1, 3, 8]) {
    const g = new Jet({ random: seeded(seed) });
    while (!g.finished) {
      g.input.down = g.player.y + g.vy * 0.19 > 285;
      g.step(1 / 60);
    }
    assert.equal(g.reason, "impact");
    assert.ok(g.elapsed < 18);
  }
});

test("Jet tests the tilted character against each individual sprite, with safe ceiling and floor", () => {
  let calls = [];
  const g = new Jet({
    bodyHit: (b, p) => {
      calls.push({ b, p });
      return false;
    },
  });
  g.press();
  g.step(0.02);
  assert.ok(calls.length >= g.kibes.length);
  assert.ok(
    calls.every(
      ({ b, p }) => b.size === 54 && p.size === 76 && Math.abs(p.angle) > 0,
    ),
  );
  assert.equal(g.finished, false);
});
