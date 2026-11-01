import test from "node:test";
import assert from "node:assert/strict";
import { Juggle } from "../src/games/guarding.js";
import { orientedSpriteHitsCircle } from "../src/collision.js";
import { projectileRotation } from "../src/engine.js";
import { projectileAlpha } from "../src/games/blade-geometry.js";

const center = { x: 480, y: 270 };
const hits = (b, p, r) =>
  orientedSpriteHitsCircle(
    projectileAlpha,
    b,
    projectileRotation(b, center),
    p,
    r,
  );
const ball = (x, y) => ({ x, y, ix: 0, iy: 0, size: 75 });
const tap = (g, p) => {
  g.move(p.x, p.y);
  g.press();
  g.release();
};

test("targets start fully outside the canvas and enter from the true edge without teleporting", () => {
  const g = new Juggle({ random: () => 0.5 });
  for (let i = 0; i < 100; i++) g.addBall((i * Math.PI) / 50);
  assert.ok(
    g.balls.every((b) => b.x <= -40 || b.x >= 1000 || b.y <= -40 || b.y >= 580),
  );
  assert.ok(
    g.balls.every(
      (b) =>
        b.entry.x === 0 ||
        b.entry.x === 960 ||
        b.entry.y === 0 ||
        b.entry.y === 540,
    ),
  );
  const before = g.balls.map((b) => ({ x: b.x, y: b.y }));
  g.step(1 / 120);
  g.balls.forEach((b, i) => {
    const moved = Math.hypot(b.x - before[i].x, b.y - before[i].y);
    assert.ok(moved > 0 && moved <= g.speed / 120 + 1e-7);
    assert.ok(
      Math.hypot(b.x - center.x, b.y - center.y) <
        Math.hypot(before[i].x - center.x, before[i].y - center.y),
    );
  });
});

test("the wider click reaches the visible alpha without turning transparent corners into targets", () => {
  const g = new Juggle({ hits, random: () => 0.5 });
  const b = ball(300, 270);
  g.balls = [b];
  let fringe;
  for (let y = 245; y <= 339 && !fringe; y++)
    for (let x = 253; x <= 347; x++) {
      const p = { x, y };
      if (hits(b, p, 15) && !hits(b, p, 12)) {
        fringe = p;
        break;
      }
    }
  assert.ok(
    fringe,
    "there must be a real band of newly reachable alpha pixels",
  );
  tap(g, { x: 350, y: 240 });
  assert.equal(g.score, 0, "empty space does not catch the image rectangle");
  tap(g, fringe);
  assert.equal(g.score, 1);
  assert.ok(b.ix < 0, "the extra reach still pushes away from the player");
});

test("one click pushes every overlapping target, counts each, and leaves distant targets alone", () => {
  const g = new Juggle({ hits, random: () => 0.5 });
  const group = Array.from({ length: 7 }, (_, i) =>
    ball(300 + i * 0.5, 270 + i * 0.5),
  );
  const far = ball(750, 400);
  g.balls = [...group, far];
  tap(g, { x: 300, y: 270 });
  assert.equal(g.score, 7);
  assert.ok(
    group.every(
      (b) =>
        b.pushes === 1 && b.ix * (b.x - center.x) + b.iy * (b.y - center.y) > 0,
    ),
  );
  assert.equal(far.ix, 0);
  assert.equal(far.iy, 0);
  assert.match(g.feedback.text, /7 afastados/);
});

test("rapid clicks all repel every reached target without waiting for a simulation frame", () => {
  const g = new Juggle({ hits, random: () => 0.5 });
  const group = [ball(300, 270), ball(301, 270), ball(302, 270)];
  g.balls = group;
  for (let i = 0; i < 60; i++) {
    tap(g, { x: 301, y: 270 });
    assert.equal(g.score, (i + 1) * group.length);
    assert.ok(group.every((b) => b.pushes === i + 1 && b.ix < 0));
  }
  assert.equal(g.elapsed, 0);
  assert.equal(g.lives, 3);
});

test("the recoil travels about 25% farther at both fast and slow frame rates", () => {
  function retreat(time, dt, decay) {
    const g = new Juggle({ hits, random: () => 0.5 });
    g.elapsed = time;
    g.knockbackDecay = decay;
    const b = ball(580, 270);
    g.balls = [b];
    tap(g, b);
    let peak = 580;
    for (let t = 0; t < 1.3; t += dt) {
      g.update(dt);
      peak = Math.max(peak, b.x);
    }
    return peak - 580;
  }
  for (const time of [0, 12.5, 24]) {
    const distances = [];
    for (const dt of [1 / 120, 1 / 30]) {
      const original = retreat(time, dt, 3.4);
      const expanded = retreat(time, dt, 3.4 / 1.25);
      assert.ok(Math.abs(expanded / original - 1.25) < 0.005);
      distances.push(expanded);
    }
    assert.ok(
      Math.abs(distances[0] - distances[1]) < 0.1,
      "recoil distance does not depend on frame rate",
    );
  }
});
