import test from "node:test";
import assert from "node:assert/strict";
import { Orbit } from "../src/games/dodging.js";
import { distance, seeded, segmentDistance } from "../src/games/kit.js";
import { orientedSpriteHitsCircle } from "../src/collision.js";
import { projectileAlpha } from "../src/games/blade-geometry.js";
import { bots } from "./strategies.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const angles = Array.from({ length: 64 }, (_, i) => (i * Math.PI) / 32);
const onEdge = (p) =>
  p.x >= 0 &&
  p.x <= 960 &&
  p.y >= 0 &&
  p.y <= 540 &&
  (p.x === 0 || p.x === 960 || p.y === 0 || p.y === 540);

const sources = [0, 960].flatMap((x) =>
  [1, 40, 135, 270, 405, 500, 539].map((y) => ({ x, y })),
);
const onWall = (p) => (p.x === 0 || p.x === 960) && p.y > 0 && p.y < 540;

test("orbit warnings and shots start only on the left and right walls without jumping inward", () => {
  const g = new Orbit({ hits: () => false });
  g.next = Infinity;
  for (const source of sources) {
    g.attacks = [];
    const b = g.spawnAttack(source, Math.PI / 3, 0);
    assert.ok(onWall(b.source));
    g.update(1 / 30);
    assert.deepEqual({ x: b.x, y: b.y }, b.source);
    assert.equal(b.age, 0);
    const lines = [];
    const pending = g.spawnAttack(source, Math.PI / 3, 1);
    g.draw({
      ctx: {},
      circle() {},
      text() {},
      enemy() {},
      player() {},
      line(from, to) {
        lines.push({ from, to });
      },
    });
    assert.ok(
      lines.some(
        (l) =>
          l.from === pending.source &&
          l.to === pending.exit &&
          onWall(l.from) &&
          onEdge(l.to),
      ),
    );
  }
  for (const origin of [
    { x: 480, y: 0 },
    { x: 480, y: 540 },
    { x: 0, y: -50 },
    { x: 960, y: 600 },
  ])
    assert.ok(
      onWall(g.spawnAttack(origin, 0).source),
      "spawn enforces the side-wall contract",
    );
});

test("every lateral origin and aim receive the same time to the first dangerous orbit crossing", () => {
  for (const intensity of [0.7, 0.9, 1.5])
    for (const elapsed of [0, 6.25, 12.5, 24]) {
      const times = [];
      for (const source of sources)
        for (const target of angles) {
          const g = new Orbit({ intensity, hits: () => false });
          g.elapsed = elapsed;
          g.next = Infinity;
          const b = g.spawnAttack(source, target);
          g.update(0);
          const speed = Math.hypot(b.vx, b.vy);
          close(distance(b.contact, g.center), g.contactRadius);
          close(distance(b.source, b.contact) / speed, b.travelTime);
          assert.ok(
            (b.contact.x - g.center.x) * b.vx +
              (b.contact.y - g.center.y) * b.vy <
              0,
            "the first crossing is on the near side",
          );
          assert.ok(
            segmentDistance(g.center, b.source, b.exit) <= g.radius + 1e-7,
            "the shot must cross the orbit",
          );
          times.push(b.travelTime);
          g.elapsed = b.launchedAt + b.travelTime / 2;
          g.update(0);
          close(distance(b.source, b), b.travelDistance / 2);
          g.elapsed = b.arrival;
          g.update(0);
          close(distance(b, g.center), g.contactRadius);
          close(Math.hypot(b.vx, b.vy), speed);
        }
      times.forEach((t) => close(t, times[0]));
    }
});

test("distance normalization prevents an alpha collision before the shared reaction time", () => {
  const g = new Orbit({ hits: () => false });
  g.next = Infinity;
  for (const source of sources)
    for (const target of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      g.attacks = [];
      g.elapsed = 0;
      const b = g.spawnAttack(source, target);
      g.update(0);
      g.elapsed = b.arrival - 0.001;
      g.update(0);
      for (const a of angles) {
        const p = {
          x: g.center.x + Math.cos(a) * g.radius,
          y: g.center.y + Math.sin(a) * g.radius,
        };
        assert.equal(
          orientedSpriteHitsCircle(
            projectileAlpha,
            b,
            b.rotation,
            p,
            g.playerCollisionRadius,
          ),
          false,
        );
      }
    }
});

test("warning delays and slow frames preserve each projectile's fixed flight time", () => {
  for (const dt of [1 / 120, 1 / 20]) {
    const g = new Orbit({ intensity: 1.5, hits: () => false });
    g.next = Infinity;
    const bodies = sources.map((source, i) =>
      g.spawnAttack(source, (i * Math.PI) / 7, 0.22),
    );
    while (g.elapsed < 0.21 - 1e-8) g.step(Math.min(dt, 0.21 - g.elapsed));
    assert.ok(
      bodies.every(
        (b) =>
          b.launchedAt === null && b.x === b.source.x && b.y === b.source.y,
      ),
    );
    while (bodies.some((b) => b.launchedAt === null)) g.step(dt);
    for (const b of bodies) close(b.arrival - b.launchedAt, b.travelTime);
    const speeds = bodies.map((b) => b.speed);
    g.elapsed = 15;
    g.update(0);
    bodies.forEach((b, i) => close(b.speed, speeds[i]));
  }
});

test("shots continue past their aim and leave through any of the four edges without disappearing inside", () => {
  const exits = new Set();
  for (const [source, target] of [
    [{ x: 0, y: 539 }, -Math.PI / 2],
    [{ x: 960, y: 1 }, Math.PI / 2],
    [{ x: 0, y: 270 }, 0],
    [{ x: 960, y: 270 }, Math.PI],
  ]) {
    const g = new Orbit({ hits: () => false });
    g.next = Infinity;
    const b = g.spawnAttack(source, target);
    g.update(0);
    assert.ok(onWall(b.source) && onEdge(b.exit));
    exits.add(
      b.exit.x === 0
        ? "left"
        : b.exit.x === 960
          ? "right"
          : b.exit.y === 0
            ? "top"
            : "bottom",
    );
    const timeToAim = distance(b.source, b.aim) / b.speed;
    g.elapsed = timeToAim + 0.02;
    g.update(0);
    assert.ok(g.attacks.includes(b));
    assert.ok(
      (b.x - b.aim.x) * b.vx + (b.y - b.aim.y) * b.vy > 0,
      "the shot flies past the aimed point",
    );
    g.elapsed = distance(b.source, b.exit) / b.speed;
    g.update(0);
    close(b.x, b.exit.x);
    close(b.y, b.exit.y);
    assert.ok(g.attacks.includes(b));
    g.elapsed += 150 / b.speed;
    g.update(0);
    assert.ok(
      !g.attacks.includes(b),
      "remove only after the sprite has left the field",
    );
  }
  assert.deepEqual(exits, new Set(["left", "right", "top", "bottom"]));
});

test("natural salvos keep all births on side walls while sampling different heights and targets", () => {
  const g = new Orbit({ random: seeded(5), hits: () => false }),
    seen = new Map();
  while (!g.finished) {
    g.step(0.05);
    for (const b of g.attacks) seen.set(b, b);
  }
  const bodies = [...seen.values()];
  assert.ok(bodies.length > 100 && bodies.every((b) => onWall(b.source)));
  assert.deepEqual(new Set(bodies.map((b) => b.source.x)), new Set([0, 960]));
  assert.ok(
    Math.min(...bodies.map((b) => b.source.y)) < 60 &&
      Math.max(...bodies.map((b) => b.source.y)) > 480,
  );
  assert.ok(
    bodies.every(
      (b) => segmentDistance(g.center, b.source, b.exit) <= g.radius + 1e-7,
    ),
  );
});

test("lateral orbit attacks retain mouse-only paths to victory with bitmap collisions", () => {
  let wins = 0;
  for (const seed of [1, 3, 9]) {
    const g = new Orbit({
      random: seeded(seed),
      hits: (b, p, r) =>
        orientedSpriteHitsCircle(projectileAlpha, b, b.rotation, p, r),
    });
    while (!g.finished) {
      bots.orbit(g);
      g.step(1 / 60);
    }
    if (g.reason === "survived") {
      wins++;
      assert.ok(g.salvos > 20);
    }
  }
  assert.ok(wins >= 1, "the difficult game must retain a real path to victory");
});
