import test from "node:test";
import assert from "node:assert/strict";
import { Thunder } from "../src/games/dodging.js";
import { canvasPath } from "../src/games/canvas-path.js";
import { seeded, segmentDistance, distance } from "../src/games/kit.js";
import { projectileAlpha } from "../src/games/blade-geometry.js";
import { orientedSpriteHitsCircle } from "../src/collision.js";
import { bots } from "./strategies.js";
const realHit = (b, p, r) =>
  orientedSpriteHitsCircle(projectileAlpha, b, b.rotation, p, r);

const onEdge = (p) =>
  p.x >= 0 &&
  p.x <= 960 &&
  p.y >= 0 &&
  p.y <= 540 &&
  (p.x === 0 || p.x === 960 || p.y === 0 || p.y === 540);

test("full-canvas paths meet two real edges for axial, diagonal and random angles", () => {
  const random = seeded(34);
  for (let i = 0; i < 1000; i++) {
    const point = { x: 90 + random() * 780, y: 80 + random() * 380 };
    const angle = i < 8 ? (i * Math.PI) / 4 : random() * Math.PI * 2;
    const p = canvasPath(point, angle);
    assert.ok(onEdge(p.a) && onEdge(p.b));
    assert.ok(segmentDistance(point, p.a, p.b) < 1e-9);
    assert.ok(
      Math.abs(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) - p.length) < 1e-9,
    );
  }
});

test("each warned path spawns at exactly the same edge and follows its complete line", () => {
  for (let seed = 1; seed <= 15; seed++) {
    const g = new Thunder({ random: seeded(seed), hits: () => false });
    g.elapsed = 19;
    g.newWave();
    assert.equal(g.wave.paths.length, 18);
    const paths = g.wave.paths;
    assert.ok(
      paths.every(
        (p) =>
          onEdge(p.a) &&
          onEdge(p.b) &&
          segmentDistance(g.safePocket, p.a, p.b) >= g.wave.safeRadius,
      ),
    );
    g.elapsed = g.wave.fireAt;
    g.update(1 / 30);
    const bodies = [...g.drops];
    assert.equal(bodies.length, paths.length);
    bodies.forEach((b, i) => {
      assert.deepEqual({ x: b.x, y: b.y }, paths[i].a);
      assert.equal(b.age, 0, "no hidden first-frame jump into the playfield");
    });
    g.step(1 / 30);
    bodies.forEach((b, i) =>
      assert.ok(segmentDistance(b, paths[i].a, paths[i].b) < 1e-8),
    );
  }
});

test("each salvo targets the captured player position with a minority of its trajectories", () => {
  for (const elapsed of [0, 8, 20, 24.9])
    for (const seed of [1, 7, 13]) {
      const g = new Thunder({ random: seeded(seed), hits: () => false });
      g.elapsed = elapsed;
      g.newWave();
      const aimed = g.wave.paths.filter((p) => p.kind === "aimed"),
        random = g.wave.paths.filter((p) => p.kind === "random"),
        origin = { ...g.player };
      assert.equal(aimed.length, g.wave.aimedCount);
      assert.ok(random.length > aimed.length);
      assert.equal(
        aimed.length,
        g.wave.paths.length === 6 ? 1 : g.wave.paths.length === 12 ? 3 : 5,
      );
      assert.ok(aimed.every((p) => segmentDistance(origin, p.a, p.b) < 1e-8));
      const geometry = JSON.stringify(g.wave.paths);
      g.move(g.safePocket.x, g.safePocket.y);
      g.elapsed = g.wave.fireAt;
      g.update(0);
      assert.equal(
        JSON.stringify(g.wave.paths),
        geometry,
        "moving does not retarget the warned lines",
      );
      assert.deepEqual(g.wave.origin, origin);
    }
});

test("the protected region shrinks and always requires meaningful movement, including from corners", () => {
  for (const elapsed of [0, 12.5, 24.9])
    for (const position of [
      { x: 480, y: 270 },
      { x: 36, y: 36 },
      { x: 924, y: 504 },
    ]) {
      const g = new Thunder({ random: seeded(4) });
      g.player = { ...position };
      g.elapsed = elapsed;
      g.newWave();
      const moved = distance(g.safePocket, position);
      assert.ok(moved >= 100 + 40 * g.progress - 1e-7 && moved <= 185 + 1e-7);
      assert.ok(g.wave.safeRadius <= 72 && g.wave.safeRadius >= 56);
      assert.ok(g.wave.fireAt - g.elapsed >= 0.32 - 1e-7);
      assert.ok(
        g.wave.paths.every(
          (p) => segmentDistance(g.safePocket, p.a, p.b) >= g.wave.safeRadius,
        ),
      );
    }
});

test("standing still is punished by aimed projectiles with actual PNG contact", () => {
  for (const position of [
    { x: 480, y: 270 },
    { x: 36, y: 36 },
    { x: 924, y: 504 },
  ]) {
    const g = new Thunder({ random: seeded(5), hits: realHit });
    g.player = { ...position };
    Object.assign(g.input, position);
    g.elapsed = 18;
    g.newWave();
    while (!g.finished) g.step(1 / 60);
    assert.equal(g.reason, "impact");
    assert.ok(g.elapsed < 21);
  }
});

test("the narrowing pocket remains reachable with mouse-only smoothing across frames and intensities", () => {
  for (const hz of [20, 60])
    for (const intensity of [0.7, 0.9, 1.5])
      for (const seed of [2, 7, 13])
        for (const position of [
          { x: 480, y: 270 },
          { x: 36, y: 36 },
          { x: 924, y: 504 },
        ]) {
          const g = new Thunder({
            intensity,
            random: seeded(seed),
            hits: realHit,
          });
          g.player = { ...position };
          Object.assign(g.input, position);
          while (!g.finished) {
            bots.thunder(g);
            g.step(1 / hz);
          }
          assert.equal(
            g.reason,
            "survived",
            `${hz} fps / intensity ${intensity} / seed ${seed} / x ${position.x} at ${g.elapsed}`,
          );
          assert.ok(g.turn >= 6);
        }
});

test("slow projectiles survive past three seconds until they finish crossing the canvas", () => {
  const g = new Thunder({ intensity: 0.7, hits: () => false });
  const p = canvasPath({ x: 480, y: 270 }, Math.atan2(540, 960));
  const speed = g.speed;
  g.wave = {
    paths: [{ ...p, vx: p.dx * speed, vy: p.dy * speed }],
    fireAt: 0,
    fired: false,
  };
  g.update(0);
  const body = g.drops[0];
  for (let i = 0; i < 62; i++) g.step(0.05);
  assert.ok(
    g.drops.includes(body),
    "long diagonals must not disappear prematurely",
  );
  assert.ok(body.x < p.b.x && body.y < p.b.y);
  while (body.age < p.length / speed + 0.3 && g.drops.includes(body))
    g.step(0.05);
  assert.ok(
    !g.drops.includes(body),
    "a sprite is removed only after it clears the border",
  );
});
