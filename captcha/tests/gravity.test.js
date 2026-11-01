import test from "node:test";
import assert from "node:assert/strict";
import { Gravity } from "../src/games/gravity-game.js";
import { seeded } from "../src/games/kit.js";
import { bots, tap } from "./strategies.js";
import spriteShape from "../src/games/projectile-shape.js";

function spriteHitsCircle(b, p, r) {
  const scale = b.size / spriteShape.worldHeight;
  if (Math.hypot(b.x - p.x, b.y - p.y) > r + (spriteShape.radius + 2) * scale)
    return false;
  const c = Math.cos(b.rotation),
    s = Math.sin(b.rotation),
    flip = b.flipY ? -1 : 1;
  // Actual opaque contour samples: first contact is on the boundary of the alpha mask.
  return spriteShape.points.some(([lx, ly]) => {
    const x = (lx + spriteShape.center.x) * scale,
      y = (ly + spriteShape.center.y) * scale;
    return (
      (b.x + c * x - s * y - p.x) ** 2 +
        (b.y + (s * x + c * y) * flip - p.y) ** 2 <=
      r * r
    );
  });
}

const advance = (g, seconds) => {
  for (let t = 0; t < seconds && !g.finished; t += 1 / 120) g.step(1 / 120);
};

test("gravity columns use one stable file with visible gaps and keep every sprite inside the expanded track", () => {
  const g = new Gravity({ random: seeded(3), hits: () => false });
  assert.ok(g.track.bottom - g.track.top >= 430);
  assert.ok(g.limits.bottom - g.limits.top > 360);
  for (let t = 0; t < 25; t += 0.05) {
    g.step(0.05);
    for (const gate of g.gates) {
      const parts = g.kibes.filter((p) => p.gateId === gate.id);
      assert.ok(parts.length >= 3 && parts.length <= 6);
      assert.equal(new Set(parts.map((p) => p.x)).size, 1);
      const inkHeight = g.spriteBounds.bottom - g.spriteBounds.top;
      for (let i = 0; i < parts.length; i++) {
        assert.equal(parts[i].rotation, Math.PI * 1.25);
        assert.equal(parts[i].flipY, true);
        assert.ok(parts[i].y + g.spriteBounds.top >= g.track.top - 1e-6);
        assert.ok(parts[i].y + g.spriteBounds.bottom <= g.track.bottom + 1e-6);
        if (i) {
          const gap = parts[i].y - parts[i - 1].y - inkHeight;
          assert.ok(
            gap >= 24 && gap < g.playerRadius * 2,
            `visible gap ${gap}`,
          );
        }
      }
    }
  }
});

test("generated sequences never repeat a side more than twice and include staggered two- and three-column patterns", () => {
  let pairs = 0,
    triples = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const g = new Gravity({
      random: seeded(seed),
      duration: 40,
      intensity: 1.5,
      hits: () => false,
    });
    const seen = new Map();
    while (!g.finished) {
      for (const gate of g.gates)
        if (!seen.has(gate.id)) seen.set(gate.id, { ...gate });
      g.step(0.05);
    }
    let previous,
      run = 0;
    const patterns = new Map();
    for (const gate of seen.values()) {
      run = gate.top === previous ? run + 1 : 1;
      previous = gate.top;
      assert.ok(run <= 2);
      assert.ok(gate.safeMax - gate.safeMin >= 60);
      if (gate.weaveCount) {
        const group = patterns.get(gate.pattern) || [];
        group.push(gate);
        patterns.set(gate.pattern, group);
      }
    }
    for (const gates of patterns.values()) {
      // A newly spawned group is observed together, before any differential motion.
      assert.equal(gates.length, gates[0].weaveCount);
      if (gates.length === 2) pairs++;
      else triples++;
      for (let i = 1; i < gates.length; i++) {
        assert.notEqual(gates[i].top, gates[i - 1].top);
        assert.ok(gates[i].x - gates[i - 1].x >= 126);
        assert.ok(gates[i].x - gates[i - 1].x <= g.speed * 0.33);
      }
      const low = Math.max(...gates.map((b) => b.safeMin)),
        high = Math.min(...gates.map((b) => b.safeMax));
      assert.ok(
        high - low > 70,
        "the shorter obstacles retain a usable central route",
      );
    }
  }
  assert.ok(pairs > 0 && triples > 0);
});

test("clicking during ascent reverses acceleration without teleporting and can turn the player before reaching the ceiling", () => {
  const g = new Gravity({ hits: () => false });
  tap(g, g.player.x, g.player.y);
  advance(g, 0.22);
  assert.ok(g.vy < 0 && g.player.y < g.limits.bottom - 80);
  const y = g.player.y,
    vy = g.vy;
  tap(g, g.player.x, g.player.y);
  assert.equal(g.player.y, y);
  assert.equal(g.vy, vy);
  assert.equal(g.gravity, 1);
  advance(g, 0.16);
  assert.ok(g.vy > 0 && g.player.y > g.limits.top + 100);
  const bottomOfTurn = g.player.y;
  advance(g, 0.1);
  assert.ok(g.player.y > bottomOfTurn);
});

test("an idle player cannot bypass the alternating columns by staying on either edge", () => {
  for (const direction of [1, -1]) {
    const g = new Gravity({ random: seeded(3) });
    if (direction < 0) tap(g, g.player.x, g.player.y);
    while (!g.finished) g.step(0.05);
    assert.equal(g.reason, "impact");
    assert.ok(g.elapsed < 5);
  }
});

test("mouse-only paths survive short, standard and long rounds, with midair turns and slow-frame input", () => {
  let midairTurns = 0;
  for (const duration of [8, 25, 40])
    for (const intensity of [0.7, 0.9, 1.5])
      for (const hz of [20, 60])
        for (let seed = 1; seed <= 8; seed++) {
          const g = new Gravity({
            random: seeded(seed),
            duration,
            intensity,
            hits: spriteHitsCircle,
          });
          let flips = 0;
          while (!g.finished) {
            const before = g.gravity;
            bots.gravity(g);
            if (before !== g.gravity) {
              flips++;
              if (
                g.player.y > g.limits.top + 20 &&
                g.player.y < g.limits.bottom - 20
              )
                midairTurns++;
            }
            g.step(1 / hz);
          }
          assert.equal(
            g.reason,
            "survived",
            `${duration}s, intensity ${intensity}, ${hz}fps, seed ${seed}`,
          );
          assert.ok(flips > 2 && g.score > 3);
        }
  assert.ok(midairTurns > 20);
});
