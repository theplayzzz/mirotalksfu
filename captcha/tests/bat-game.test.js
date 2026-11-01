import test from "node:test";
import assert from "node:assert/strict";
import { Rhythm } from "../src/games/bat-game.js";
import {
  makeProjectile,
  createBat,
  SWING_DURATION,
} from "../src/games/bat-physics.js";
import { fullyOutside } from "../src/games/bat-guidance.js";
import shape from "../src/games/projectile-shape.js";
import { seeded, distance } from "../src/games/kit.js";
import { bots } from "./strategies.js";
import { orientedSpriteHitsCircle } from "../src/collision.js";
import { projectileAlpha } from "../src/games/blade-geometry.js";
const hits = (b, p, r) =>
  orientedSpriteHitsCircle(projectileAlpha, b, b.rotation, p, r);

test("bat attacks enter from three real edges with spaced, distance-adjusted arrivals", () => {
  const g = new Rhythm({ random: seeded(3) }),
    sides = new Set();
  let previous = 0;
  for (let i = 0; i < 30; i++) {
    g.elapsed = i * 0.75;
    const b = g.addShot();
    sides.add(b.side);
    assert.ok(b.source.x === 960 || b.source.y === 0 || b.source.y === 540);
    assert.ok(
      Math.abs(
        (distance(b.source, g.player) - g.defenseRadius) /
          Math.hypot(b.vx, b.vy) -
          b.travelTime,
      ) < 1e-7,
    );
    assert.ok(b.arrival - previous >= g.cooldown + 0.09 - 1e-7);
    previous = b.arrival;
  }
  assert.deepEqual(sides, new Set(["right", "top", "bottom"]));
});

test("a passive bat contact remains dangerous and returns to the character without scoring", () => {
  const g = new Rhythm({ random: seeded(3), hits });
  g.next = Infinity;
  g.move(280, 270);
  const b = g.shots[0];
  while (!b.contacts && g.elapsed < 4) g.step(1 / 120);
  assert.ok(b.contacts > 0);
  assert.equal(b.ejected, false);
  assert.equal(g.score, 0);
  while (g.lives === 3 && g.elapsed < 8) g.step(1 / 120);
  assert.equal(g.lives, 2);
  assert.equal(g.score, 0);
  assert.equal(b.gone, true);
});

test("sweeping the bat rapidly through a projectile without clicking cannot expel it", () => {
  const g = new Rhythm({ hits: () => false });
  g.next = Infinity;
  g.bat = createBat(180, 270);
  g.move(580, 270);
  const b = g.addShot({ x: 340, y: 270 });
  b.vx = -120;
  b.vy = 0;
  g.shots = [b];
  for (let i = 0; i < 120; i++) g.step(1 / 120);
  assert.ok(g.contacts.length > 0);
  assert.ok(g.contacts.some((c) => c.batRawPointSpeed > 500));
  assert.ok(
    g.contacts.every(
      (c) => !c.striking && !c.ejected && c.batPointSpeed <= 90.00001,
    ),
  );
  assert.equal(b.ejected, false);
  assert.equal(g.score, 0);
  assert.ok(g.shots.includes(b));
});

test("buffered clicks start after the previous animation has actually returned, without shortening recovery", () => {
  const g = new Rhythm();
  g.next = Infinity;
  g.shots = [];
  g.press();
  g.release();
  const first = g.swing;
  while (g.elapsed < 0.5) g.step(1 / 120);
  g.press();
  g.release();
  assert.equal(g.queuedSwing, true);
  const start = g.startSwing.bind(g),
    recorded = [];
  g.startSwing = (at) => {
    recorded.push({
      at,
      angle: g.bat.angle,
      rest: g.bat.restAngle,
      omega: g.bat.omega,
    });
    start(at);
  };
  while (g.swing === first && g.elapsed < 0.7) g.step(1 / 120);
  assert.equal(recorded.length, 1);
  assert.ok(recorded[0].at >= first.at + SWING_DURATION);
  assert.ok(recorded[0].at < first.at + SWING_DURATION + 0.005);
  assert.ok(Math.abs(recorded[0].angle - recorded[0].rest) < 1e-6);
  assert.ok(Math.abs(recorded[0].omega) < 1e-6);
  assert.equal(g.cooldown, 0.56);
});

test("pressure adds pairs and triples that fit one swing, while separate groups preserve recovery time", () => {
  const g = new Rhythm({
      random: seeded(3),
      intensity: 1.5,
      hits: () => false,
    }),
    all = [...g.shots],
    addShot = g.addShot.bind(g);
  g.addShot = (options) => {
    const b = addShot(options);
    all.push(b);
    return b;
  };
  while (!g.finished) g.step(1 / 120);
  assert.ok(all.length > 50, `${all.length} attacks in 25 seconds`);
  const groups = Map.groupBy(all, (b) => b.groupId);
  let lastArrival = -10;
  for (const members of groups.values()) {
    const first = members[0],
      last = members.at(-1);
    assert.ok(first.arrival - lastArrival >= g.cooldown + 0.09 - 1e-7);
    assert.equal(members.length, first.groupSize);
    assert.ok(last.arrival - first.arrival <= 0.101);
    assert.ok(members.every((b) => b.side === first.side));
    assert.ok(
      members.every(
        (b) => b.source.x === 960 || b.source.y === 0 || b.source.y === 540,
      ),
    );
    if (first.spawnedAt > 21) assert.equal(members.length, 3);
    lastArrival = last.arrival;
  }
  assert.ok([...groups.values()].some((g) => g.length === 2));
  assert.ok([...groups.values()].some((g) => g.length === 3));
});

test("an energetic swing only scores once the full projectile has actually left the canvas", () => {
  const g = new Rhythm({ random: seeded(3), hits });
  g.next = Infinity;
  const b = g.shots[0];
  while (g.elapsed < 6 && g.score === 0 && !g.finished) {
    bots.rhythm(g);
    g.step(1 / 120);
    if (!fullyOutside(b)) assert.equal(g.score, 0);
  }
  assert.equal(g.score, 1);
  assert.ok(fullyOutside(b));
  assert.equal(g.lives, 3);
  assert.ok(
    g.contacts.some(
      (c) => c.ejected && c.batNormalSpeed >= 100 && c.batWork >= 24000,
    ),
  );
});

test("a weak deflection can leave the view and return without being deleted or scoring", () => {
  const g = new Rhythm({ random: seeded(3) });
  g.next = Infinity;
  g.move(50, 490);
  g.bat = createBat(50, 490);
  const b = g.addShot({ x: 940, y: 180 });
  b.free = true;
  b.contacts = 1;
  b.returnAt = 0;
  b.vx = 500;
  b.vy = -80;
  g.shots = [b];
  let outside = false,
    returned = false;
  while (g.elapsed < 2.2 && !g.finished) {
    g.step(1 / 120);
    if (fullyOutside(b)) outside = true;
    else if (outside) returned = true;
  }
  assert.ok(outside && returned);
  assert.ok(g.shots.includes(b));
  assert.equal(g.score, 0);
  assert.equal(b.ejected, false);
});

test("even a strong hit that flies into the character still costs a life", () => {
  const g = new Rhythm({ hits });
  g.next = Infinity;
  g.move(700, 450);
  g.bat = createBat(700, 450);
  const b = makeProjectile(shape, {
    x: 140,
    y: 270,
    vx: -250,
    vy: 0,
    size: 62,
    rotation: Math.PI * 1.25,
  });
  b.free = true;
  b.ejected = true;
  b.contacts = 1;
  g.shots = [b];
  g.step(0.05);
  assert.equal(g.lives, 2);
  assert.equal(g.score, 0);
  assert.equal(g.shots.length, 0);
});

test("diverse incoming directions remain playable with real alpha collisions and mouse swings", () => {
  for (const seed of [1, 3, 9]) {
    const g = new Rhythm({ random: seeded(seed), hits });
    while (!g.finished) {
      bots.rhythm(g);
      g.step(1 / 60);
    }
    assert.equal(g.reason, "survived", `seed=${seed}, time=${g.elapsed}`);
    assert.ok(g.score >= 20);
  }
});
