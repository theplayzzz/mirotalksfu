import test from "node:test";
import assert from "node:assert/strict";
import { challenges } from "../src/games/index.js";
import { catalog, gameById } from "../src/catalog.js";
import { seeded, distance, segmentDistance } from "../src/games/kit.js";
import { play, tap, bots, launchPlan } from "./strategies.js";
const advance = (g, seconds) => {
  for (let t = 0; t < seconds && !g.finished; t += 1 / 120) g.step(1 / 120);
};

test("only the original and thirteen approved mechanics are selectable", () => {
  assert.equal(catalog.length, 14);
  assert.equal(Object.keys(challenges).length, 13);
  for (const id of [
    "memory",
    "doors",
    "tower",
    "mines",
    "jump",
    "munch",
    "energy",
    "timber",
  ]) {
    assert.ok(!catalog.some((g) => g.id === id));
    assert.equal(gameById(id).id, "arena");
  }
  for (const g of catalog.filter((g) => g.id !== "arena")) {
    assert.equal(g.seconds, 25);
    assert.equal(
      g.revision,
      {
        rain: 4,
        orbit: 5,
        paddle: 5,
        rhythm: 7,
        gravity: 4,
        shelter: 7,
        stretch: 7,
        slash: 7,
        jet: 5,
        thunder: 5,
        juggle: 6,
        climb: 7,
        web: 5,
      }[g.id],
    );
  }
});
for (const id of Object.keys(challenges))
  test(`${id}: a mouse-only strategy has a real path to victory`, () => {
    const g = play(id);
    assert.equal(
      g.reason,
      "survived",
      `${g.detail}, score=${g.score}, time=${g.elapsed}`,
    );
    assert.ok(g.elapsed <= 25);
    const before = g.elapsed;
    g.step(0.05);
    assert.equal(g.elapsed, before);
  });
test("flight speed reaches its maximum by half-time while later pressure still rises", () => {
  for (const id of [
    "rain",
    "orbit",
    "paddle",
    "rhythm",
    "gravity",
    "jet",
    "shelter",
    "slash",
    "thunder",
  ]) {
    const g = new challenges[id]({ duration: 25 });
    const initial = g.speed;
    g.elapsed = 12.5;
    const peak = g.speed;
    g.elapsed = 25;
    assert.equal(g.speed, peak, id);
    assert.ok(peak > initial * 1.7, id);
  }
  const g = new challenges.rain({ random: seeded(3) });
  g.elapsed = 12.5;
  g.update(0);
  const first = g.next - g.elapsed;
  g.elapsed = 24.9;
  g.next = 0;
  g.update(0);
  assert.ok(g.next - g.elapsed < first);
});
test("rain and free movement have bounded smoothing instead of cursor teleportation", () => {
  for (const id of ["rain", "thunder"]) {
    const g = new challenges[id]({ random: seeded(3) });
    g.move(890, 292);
    g.step(1 / 120);
    assert.ok(g.player.x > 480 && g.player.x < 890, id);
  }
});
test("circular shield contacts are serialized even at highest intensity", () => {
  const g = play("paddle", { intensity: 1.5 });
  assert.equal(g.reason, "survived");
  for (let i = 1; i < g.arrivalLog.length; i++)
    assert.ok(g.arrivalLog[i] - g.arrivalLog[i - 1] >= 0.2149);
  assert.ok(g.score > 45);
});
test("both rain corridors stay narrow, separated and clear of the full rotated artwork", () => {
  for (let seed = 1; seed <= 32; seed++) {
    const g = new challenges.rain({ random: seeded(seed) });
    for (let n = 0; n < 45; n++) {
      g.elapsed = (n / 44) * 25;
      const previous = [...g.lastGaps],
        row = g.spawnRow();
      assert.equal(row.gaps.length, 2);
      assert.ok(row.gaps[1].x - row.gaps[0].x >= 230);
      for (const gap of row.gaps) {
        assert.ok(gap.width >= 78 && gap.width <= 96);
        assert.ok(gap.safeRight - gap.safeLeft >= 14);
        assert.ok(previous.some((x) => Math.abs(x - gap.x) <= 220));
        for (const b of row.parts) {
          const r = Math.hypot(b.size * 0.8, b.size) / 2;
          assert.ok(b.x + r <= gap.left + 1e-7 || b.x - r >= gap.right - 1e-7);
        }
        assert.ok(
          row.parts.some(
            (b) =>
              b.boundary &&
              Math.abs(b.x + Math.hypot(b.size * 0.8, b.size) / 2 - gap.left) <
                2.01,
          ),
        );
        assert.ok(
          row.parts.some(
            (b) =>
              b.boundary &&
              Math.abs(b.x - Math.hypot(b.size * 0.8, b.size) / 2 - gap.right) <
                2.01,
          ),
        );
      }
      assert.ok(
        previous.every((x) =>
          row.gaps.some((gap) => Math.abs(x - gap.x) <= 220),
        ),
      );
    }
  }
});
test("either rain branch can be followed through a complete round", () => {
  for (const branch of [0, 1])
    for (let seed = 1; seed <= 8; seed++) {
      const g = new challenges.rain({ random: seeded(seed) });
      while (!g.finished) {
        const row = g.rows
          .filter((r) => r.y < 497)
          .sort((a, b) => b.y - a.y)[0];
        if (row) g.move(row.gaps[branch].x, 458);
        g.step(1 / 120);
      }
      assert.equal(g.reason, "survived", `branch ${branch}, seed ${seed}`);
    }
});
test("shield flight time is identical across every edge at the same difficulty", () => {
  for (const elapsed of [0, 6.25, 12.5, 24]) {
    const flights = [];
    for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5, Math.PI / 4]) {
      const g = new challenges.paddle({ random: () => angle / (Math.PI * 2) });
      g.elapsed = elapsed;
      const b = g.spawnAttack();
      flights.push(b);
      assert.ok(
        Math.abs(b.speed * b.travelTime - (b.startRadius - g.contactRadius)) <
          1e-7,
      );
      assert.ok(Math.abs(b.arrival - b.spawnedAt - b.travelTime) < 1e-7);
      assert.equal(b.radius, b.startRadius);
    }
    for (const b of flights) assert.equal(b.travelTime, flights[0].travelTime);
    assert.ok(
      flights[0].speed > flights[1].speed * 2,
      "horizontal distance needs higher speed, not a later contact",
    );
    assert.ok(Math.abs(flights[0].speed - flights[2].speed) < 1e-7);
    assert.ok(Math.abs(flights[1].speed - flights[3].speed) < 1e-7);
  }
});
test("bat cooldown prevents click spamming; misses consume exactly three chances", () => {
  const g = new challenges.rhythm({ random: seeded(3) });
  tap(g);
  const swing = g.swing;
  for (let i = 0; i < 15; i++) tap(g);
  assert.equal(g.swing, swing);
  assert.equal(g.lives, 3);
  while (!g.finished) g.step(0.05);
  assert.equal(g.reason, "impact");
  assert.equal(g.hitCount, 3);
  assert.equal(g.lives, 0);
  assert.equal(g.player.x, 105);
  assert.ok(g.shots.every((b) => b.flipY));
});
test("nonfatal impacts change expression temporarily and the third distinct hit loses", () => {
  const g = new challenges.shelter();
  for (let i = 0; i < 3; i++) {
    g.hurt("Teste", 0);
    assert.equal(g.lives, 2 - i);
    assert.ok(g.hitUntil > g.elapsed);
    if (i < 2) {
      advance(g, 0.5);
      assert.ok(g.elapsed >= g.hitUntil);
      assert.equal(g.finished, false);
    }
  }
  assert.equal(g.reason, "impact");
  assert.equal(g.hitCount, 3);
});
test("ink budget is conserved when drawing through the center and refunds only destroyed area", () => {
  const g = new challenges.shelter({ random: seeded(1) });
  g.move(350, 270);
  g.press();
  g.move(350, 310);
  g.release();
  const used = g.lines.reduce((s, l) => s + l.length, 0);
  assert.ok(used > 0);
  assert.ok(Math.abs(g.ink + used - g.maxInk) < 1e-7);
  const ink = g.ink;
  g.move(300, g.player.y);
  g.press();
  g.move(660, g.player.y);
  g.release();
  assert.equal(
    g.ink,
    ink - 360,
    "drawing through the character uses ink normally",
  );
  assert.ok(g.lines.some((l) => segmentDistance(g.player, l.a, l.b) < 1e-7));
  const beforeImpact = g.ink;
  g.drops.push({ x: 350, y: g.player.y, vx: 0, vy: 0 });
  g.step(0.01);
  assert.ok(g.ink > beforeImpact && g.ink < g.maxInk);
  assert.equal(g.score, 1);
  g.elapsed = 2;
  g.update(0);
  assert.equal(g.ink, g.maxInk);
  g.move(612, g.player.y);
  g.press();
  for (let a = 0.04; a <= Math.PI * 2; a += 0.04)
    g.move(480 + Math.cos(a) * 132, g.player.y + Math.sin(a) * 132);
  g.release();
  assert.ok(g.ink >= 0);
  assert.ok(g.lines.reduce((s, l) => s + l.length, 0) <= g.maxInk + 0.001);
});
test("gravity and jet columns consist of sprite colliders; jet boundaries are harmless", () => {
  for (const id of ["gravity", "jet"]) {
    const g = new challenges[id]({ random: seeded(3) });
    g.step(0.01);
    assert.ok(g.gates.some((b) => b.x < 960));
    assert.ok(g.kibes.length >= (id === "gravity" ? 10 : 6));
    assert.ok(g.kibes.every((b) => b.size === 54));
  }
  const g = new challenges.jet();
  g.player.y = 700;
  g.step(0.01);
  assert.equal(g.player.y, g.limits.bottom);
  assert.equal(g.finished, false);
  g.player.y = 0;
  g.step(0.01);
  assert.ok(Math.abs(g.player.y - g.limits.top) < 0.01);
  assert.equal(g.finished, false);
});
test("slingshot offers reachable elevated landings with bounce physics across random layouts", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const g = play("stretch", { seed });
    assert.equal(g.reason, "survived", `seed ${seed}`);
    assert.equal(g.score, g.goal);
  }
  const g = new challenges.stretch({ random: seeded(3) }),
    p = launchPlan(g);
  g.move(g.anchor.x, g.anchor.y);
  g.press();
  g.move(g.anchor.x + p.x, g.anchor.y + p.y);
  g.release();
  while (!g.finished && !g.bounces) g.step(1 / 120);
  assert.equal(g.bounces, 1);
  assert.ok(g.vy < 0, "a landing actually rebounds");
  const short = play("stretch", { duration: 8 });
  assert.equal(short.reason, "survived");
  assert.equal(short.goal, 2);
});
test("cuts require a mouse stroke rather than a stationary click", () => {
  const g = new challenges.slash();
  g.targets = [{ x: 260, y: 260, vx: 0, vy: 0 }];
  tap(g, 260, 260);
  assert.equal(g.score, 0);
  g.move(240, 260);
  g.press();
  g.move(280, 260);
  g.release();
  assert.equal(g.score, 1);
});
test("warning salvos grow from 6 to 12 to 18 with a clear reachable pocket", () => {
  const g = new challenges.thunder({ random: seeded(3) });
  for (const [time, count] of [
    [0, 6],
    [8, 12],
    [20, 18],
  ]) {
    g.elapsed = time;
    g.newWave();
    assert.equal(g.wave.paths.length, count);
    assert.ok(distance(g.safePocket, g.player) < 200);
    assert.ok(
      g.wave.paths.every(
        (p) => segmentDistance(g.safePocket, p.a, p.b) >= g.wave.safeRadius,
      ),
    );
  }
});
test("the population grows from four to thirteen with larger targets", () => {
  const g = new challenges.juggle({ random: seeded(3) });
  assert.equal(g.balls.length, 4);
  for (let t = 0; t <= 25; t += 5) {
    g.elapsed = t;
    g.update(0);
    assert.equal(g.balls.length, Math.min(13, 4 + Math.floor((t / 25) * 10)));
    assert.ok(g.balls.every((b) => b.size === 75));
  }
});
test("climbing is endless, consumes each landing, and preserves a lethal floor", () => {
  const g = new challenges.climb({ random: seeded(3) });
  while (g.elapsed < 12 && !g.finished) {
    bots.climb(g);
    g.step(1 / 120);
  }
  assert.equal(g.goal, 0);
  assert.ok(g.score > 8);
  assert.ok(g.topIndex > 12);
  assert.ok(g.platforms.every((p) => p.i > g.highest || p.used));
  assert.ok(g.floor.every((b) => b.rotation === -Math.PI / 4));
  const h = g.highest,
    old = g.score;
  advance(g, 0.05);
  assert.ok(g.highest >= h);
  assert.ok(g.score <= old + 1);
});
