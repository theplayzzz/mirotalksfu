import test from "node:test";
import assert from "node:assert/strict";
import { Paddle } from "../src/games/guarding.js";
import {
  shieldGeometry as profile,
  shieldBlockContact,
} from "../src/games/shield-geometry.js";
import {
  projectileAlpha,
  spriteWorldPoint,
} from "../src/games/blade-geometry.js";
import { orientedSpriteHitsCircle } from "../src/collision.js";
import { seeded, clamp } from "../src/games/kit.js";
import { bots } from "./strategies.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const hits = (b, p, r) =>
  orientedSpriteHitsCircle(projectileAlpha, b, b.rotation, p, r);
const pixels = [];
for (let y = 0; y < projectileAlpha.height; y++)
  for (let x = 0; x < projectileAlpha.width; x++)
    if (projectileAlpha.alpha[y * projectileAlpha.width + x])
      pixels.push({
        x:
          ((x + 0.5) * projectileAlpha.worldWidth) / projectileAlpha.width -
          projectileAlpha.worldWidth / 2,
        y:
          ((y + 0.5) * projectileAlpha.worldHeight) / projectileAlpha.height -
          projectileAlpha.worldHeight / 2,
      });
function reference(r, angle = 0) {
  const body = { x: Math.cos(angle) * r, y: Math.sin(angle) * r, size: 54 };
  let passed = 0,
    overlaps = false;
  for (const pixel of pixels) {
    const p = spriteWorldPoint(pixel, body, angle + Math.PI * 1.25);
    if (Math.hypot(p.x, p.y) < profile.radius - profile.thickness / 2) passed++;
    const a = clamp(Math.atan2(p.y, p.x), -profile.span / 2, profile.span / 2);
    if (
      Math.hypot(
        p.x - profile.radius * Math.cos(a),
        p.y - profile.radius * Math.sin(a),
      ) <=
      profile.thickness / 2 + 1e-8
    )
      overlaps = true;
  }
  return { fraction: passed / pixels.length, overlaps };
}
function isolated() {
  const g = new Paddle({ hits, random: seeded(3) });
  g.next = Infinity;
  return g;
}
function face(g, angle) {
  g.shieldAngle = angle;
  g.move(
    g.player.x + Math.cos(angle) * 180,
    g.player.y + Math.sin(angle) * 180,
  );
}
function placeAt(g, b, r) {
  g.elapsed = b.spawnedAt + (b.startRadius - r) / b.speed;
  g.update(0);
}

test("shield player is centered and every projectile starts on a real canvas edge or corner", () => {
  const g = isolated();
  assert.deepEqual(g.player, { x: 480, y: 270 });
  const angles = [
    ...Array.from({ length: 64 }, (_, i) => (i * Math.PI) / 32),
    ...[
      [0, 0],
      [960, 0],
      [960, 540],
      [0, 540],
    ].map(([x, y]) => Math.atan2(y - 270, x - 480)),
  ];
  for (const a of angles) {
    g.attacks = [];
    const b = g.spawnAttack(a);
    assert.ok(b.x === 0 || b.x === 960 || b.y === 0 || b.y === 540);
    const source = { ...b.source };
    g.update(1 / 120);
    assert.deepEqual({ x: b.x, y: b.y }, source);
  }
});

test("each side gets the same flight time to first alpha contact, with fixed velocity", () => {
  for (const intensity of [0.7, 0.9, 1.5])
    for (const elapsed of [0, 6.25, 12.5, 24]) {
      const times = [];
      for (const angle of [
        0,
        Math.PI / 2,
        Math.PI,
        Math.PI * 1.5,
        Math.PI / 4,
      ]) {
        const g = new Paddle({ intensity, hits: () => false });
        g.next = Infinity;
        g.elapsed = elapsed;
        const b = g.spawnAttack(angle),
          speed = b.speed;
        face(g, angle + Math.PI);
        close((b.startRadius - g.contactRadius) / speed, b.travelTime);
        times.push(b.travelTime);
        g.elapsed = b.arrival;
        g.update(0);
        close(b.radius, g.contactRadius);
        assert.equal(
          b.checked,
          false,
          "a missed first touch must leave the recovery window open",
        );
        close(b.speed, speed);
      }
      times.forEach((t) => close(t, times[0]));
    }
});

test("penetration counts opaque area and arc contact follows the drawing and rounded ends", () => {
  for (const r of [
    profile.contactRadius,
    116,
    107,
    99,
    profile.cutoffRadius - 1,
  ])
    for (const angle of [-0.8, -0.5, -0.4, -0.2, 0, 0.2, 0.4, 0.5, 0.8]) {
      const expected = reference(r, angle);
      close(profile.passedFraction(r), reference(r).fraction);
      assert.equal(
        profile.overlaps(r, angle),
        expected.overlaps,
        `r=${r}, angle=${angle}`,
      );
    }
  assert.equal(
    profile.overlaps(profile.contactRadius, 0.8),
    false,
    "transparent corners cannot block the shield",
  );
});

test("the shield can catch a projectile after its tip has already passed the barrier", () => {
  const g = isolated(),
    b = g.spawnAttack(0),
    r = (profile.contactRadius + profile.cutoffRadius * 3) / 4;
  face(g, Math.PI);
  placeAt(g, b, r);
  assert.ok(reference(r).fraction > 0.2 && reference(r).fraction < 0.4);
  assert.equal(b.checked, false);
  assert.equal(b.reflected, false);
  face(g, 0);
  g.update(0);
  assert.equal(b.reflected, true);
  assert.equal(g.score, 1);
  assert.ok(b.blockedFraction > 0.2 && b.blockedFraction <= 0.4);
});

test("after forty percent crosses, rotating the shield back cannot rescue that projectile", () => {
  const g = isolated(),
    b = g.spawnAttack(0),
    r = profile.cutoffRadius - 5;
  face(g, Math.PI);
  placeAt(g, b, r);
  assert.ok(reference(r).fraction > 0.4);
  assert.equal(b.checked, true);
  face(g, 0);
  g.update(0);
  assert.equal(b.reflected, false);
  assert.equal(g.score, 0);
  placeAt(g, b, 35);
  assert.equal(g.lives, 2);
});

test("sweeping a slow frame catches a valid crossing without granting a block after the deadline", () => {
  const from = profile.contactRadius + 10,
    to = profile.cutoffRadius - 30;
  const caught = shieldBlockContact(from, to, 0, 0, 0);
  assert.ok(caught && caught.passedFraction <= 0.4);
  assert.ok(caught.radius >= profile.cutoffRadius);
  assert.equal(
    shieldBlockContact(from, to, 0, Math.PI, 0),
    null,
    "ending aligned is insufficient if alignment happened after the deadline",
  );
});

test("three real alpha-collision rounds remain playable with mouse-driven shield rotation", () => {
  for (const seed of [1, 3, 9]) {
    const g = new Paddle({ random: seeded(seed), hits });
    while (!g.finished) {
      bots.paddle(g);
      g.step(1 / 30);
    }
    assert.equal(g.reason, "survived", `seed=${seed}, time=${g.elapsed}`);
    assert.ok(g.score > 35);
    assert.ok(
      g.attacks
        .filter((b) => b.reflected)
        .every((b) => b.blockedFraction <= 0.4),
    );
  }
});
