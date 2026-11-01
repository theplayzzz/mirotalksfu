import test from "node:test";
import assert from "node:assert/strict";
import { Shelter } from "../src/games/dodging.js";
import { W, H, distance, seeded } from "../src/games/kit.js";
import { bots } from "./strategies.js";
import { orientedSpriteHitsCircle } from "../src/collision.js";
import { projectileAlpha } from "../src/games/blade-geometry.js";
import { projectileRotation } from "../src/engine.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const angles = Array.from({ length: 64 }, (_, i) => (i * Math.PI) / 32);

test("shelter spawns exactly on the real canvas boundary, including all four corners, without a first-step jump", () => {
  const g = new Shelter({ hits: () => false });
  const all = [
    ...angles,
    ...[
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ].map(([x, y]) => Math.atan2(y - g.player.y, x - g.player.x)),
  ];
  for (const angle of all) {
    g.drops = [];
    const b = g.spawnDrop(angle);
    assert.ok(
      Math.min(
        Math.abs(b.x),
        Math.abs(b.x - W),
        Math.abs(b.y),
        Math.abs(b.y - H),
      ) < 1e-7,
    );
    assert.ok(b.x >= 0 && b.x <= W && b.y >= 0 && b.y <= H);
    const x = b.x,
      y = b.y;
    g.update(1 / 120);
    close(b.x, x);
    close(b.y, y);
    assert.equal(b.age, 0);
    close(distance(b, g.player), b.startRadius);
  }
});

test("every direction gets identical time to the approach reference; velocity compensates the real distance", () => {
  for (const intensity of [0.7, 0.9, 1.5])
    for (const elapsed of [0, 6.25, 12.5, 24]) {
      const times = [];
      for (const angle of angles) {
        const g = new Shelter({ intensity, hits: () => false });
        g.elapsed = elapsed;
        const b = g.spawnDrop(angle);
        g.next = Infinity;
        const originalSpeed = b.speed;
        times.push(b.travelTime);
        close(
          (b.startRadius - g.contactRadius) / Math.hypot(b.vx, b.vy),
          b.travelTime,
        );
        close(b.arrival - b.spawnedAt, b.travelTime);
        g.elapsed = b.spawnedAt + b.travelTime / 2;
        g.update(0);
        close(distance(b, g.player), (b.startRadius + g.contactRadius) / 2);
        g.elapsed = b.arrival;
        g.update(0);
        close(distance(b, g.player), g.contactRadius);
        assert.equal(
          b.speed,
          originalSpeed,
          "difficulty changes cannot accelerate an in-flight projectile",
        );
      }
      times.forEach((t) => close(t, times[0]));
      const g = new Shelter({ intensity });
      g.elapsed = elapsed;
      const horizontal = g.spawnDrop(0),
        vertical = g.spawnDrop(Math.PI / 2);
      close(
        horizontal.speed / vertical.speed,
        (horizontal.startRadius - g.contactRadius) /
          (vertical.startRadius - g.contactRadius),
      );
    }
});

test("a barrier drawn close to the character blocks real sprite pixels inside the former exclusion zone", () => {
  const center = { x: W / 2, y: H / 2 },
    hits = (b, p, r) =>
      orientedSpriteHitsCircle(
        projectileAlpha,
        b,
        projectileRotation(b, center),
        p,
        r,
      ),
    g = new Shelter({ hits });
  const b = g.spawnDrop(0);
  g.next = Infinity;
  g.elapsed = b.arrival;
  g.update(0);
  g.move(center.x + 42, center.y - 20);
  g.press();
  g.move(center.x + 42, center.y + 20);
  g.release();
  close(g.maxInk - g.ink, 40);
  assert.ok(
    g.lines.every(
      (l) => distance(l.a, center) < 60 && distance(l.b, center) < 60,
    ),
  );
  for (let i = 0; i < 120 && !b.reflected && !g.finished; i++) g.step(1 / 120);
  assert.equal(b.reflected, true);
  assert.equal(g.score, 1);
  assert.equal(g.lives, 3);
});

test("arrival order remains chronological as difficulty rises, with no invisible waiting or interior spawn", () => {
  for (const duration of [8, 25, 40]) {
    const g = new Shelter({
      duration,
      intensity: 1.5,
      random: seeded(9),
      hits: () => false,
    });
    const seen = new Set(),
      arrivals = [];
    while (!g.finished) {
      g.step(0.05);
      for (const b of g.drops)
        if (!seen.has(b)) {
          seen.add(b);
          arrivals.push({ at: b.arrival, volley: b.volleyId });
          assert.ok(b.age >= 0 && b.age < 0.05);
          assert.ok(b.radius <= b.startRadius);
          const p = b.source;
          assert.ok(p.x === 0 || p.x === W || p.y === 0 || p.y === H);
        }
    }
    assert.ok(arrivals.length > 12);
    for (let i = 1; i < arrivals.length; i++) {
      if (arrivals[i].volley === arrivals[i - 1].volley)
        close(arrivals[i].at, arrivals[i - 1].at);
      else assert.ok(arrivals[i].at > arrivals[i - 1].at);
    }
  }
});

test("volleys grow from two to eight independent directions, keeping every source and flight deadline on the real field", () => {
  const g = new Shelter({ random: seeded(3) });
  for (const [elapsed, count] of [
    [0, 2],
    [5, 4],
    [12.5, 8],
    [24, 8],
  ]) {
    g.elapsed = elapsed;
    const volley = g.spawnVolley();
    assert.equal(volley.length, count);
    assert.equal(new Set(volley.map((b) => b.angle)).size, count);
    assert.ok(volley.every((b) => b.volleyId === g.volleySerial));
    assert.ok(volley.every((b) => b.arrival === volley[0].arrival));
    assert.ok(
      volley.every(
        (b) =>
          b.source.x === 0 ||
          b.source.x === W ||
          b.source.y === 0 ||
          b.source.y === H,
      ),
    );
  }
});

test("the denser schedule is identical with an empty field or a continuously drawn circular barrier", () => {
  const run = (circle) => {
    const g = new Shelter({ random: seeded(9), hits: () => false }),
      log = [],
      spawn = g.spawnDrop.bind(g);
    g.spawnDrop = (...args) => {
      const b = spawn(...args);
      log.push({ at: g.elapsed, angle: b.angle, arrival: b.arrival });
      return b;
    };
    if (circle) {
      g.move(612, 270);
      g.press();
    }
    while (!g.finished) {
      if (circle)
        g.move(
          480 + Math.cos(g.elapsed * 18) * 132,
          270 + Math.sin(g.elapsed * 18) * 132,
        );
      g.step(1 / 120);
    }
    return log;
  };
  const empty = run(false),
    circle = run(true);
  assert.deepEqual(circle, empty, "spawning cannot inspect the ink or drawing");
  assert.ok(empty.length >= 200 && empty.length <= 220);
  assert.ok(
    empty.filter((b) => b.at > 20).length >
      empty.filter((b) => b.at < 5).length * 5,
  );
});

test("fast circular drawing no longer provides automatic protection against the increased density", () => {
  const center = { x: W / 2, y: H / 2 },
    hits = (b, p, r) =>
      orientedSpriteHitsCircle(
        projectileAlpha,
        b,
        projectileRotation(b, center),
        p,
        r,
      );
  for (const omega of [12, 18, 24]) {
    const g = new Shelter({ random: seeded(3), hits });
    g.move(center.x + 132, center.y);
    g.press();
    while (!g.finished) {
      g.move(
        center.x + Math.cos(g.elapsed * omega) * 132,
        center.y + Math.sin(g.elapsed * omega) * 132,
      );
      g.step(1 / 120);
    }
    assert.equal(g.reason, "impact", `${omega} rad/s`);
    assert.equal(g.hitCount, 3);
    assert.ok(g.elapsed < g.duration);
    assert.ok(
      g.score > 20,
      "the circle can block attacks but cannot hold indefinitely",
    );
  }
});

test("mouse-drawn barriers remain viable with the normalized flight times and ink stays conserved", () => {
  for (const intensity of [0.7, 0.9, 1.5])
    for (let seed = 1; seed <= 8; seed++) {
      const g = new Shelter({ intensity, random: seeded(seed) });
      while (!g.finished) {
        bots.shelter(g);
        g.step(1 / 60);
        assert.ok(g.ink >= 0 && g.ink <= g.maxInk);
        close(g.ink + g.lines.reduce((sum, l) => sum + l.length, 0), g.maxInk);
      }
      assert.equal(
        g.reason,
        "survived",
        `seed ${seed}, intensity ${intensity}`,
      );
      assert.ok(g.score > 20);
    }
});
