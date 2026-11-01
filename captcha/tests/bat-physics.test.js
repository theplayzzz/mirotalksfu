import test from "node:test";
import assert from "node:assert/strict";
import { createAlphaMask } from "../src/collision.js";
import {
  shapeFromMask,
  makeProjectile,
  syncArtwork,
  integrateProjectile,
  createBat,
  driveBat,
  batCapsules,
  batContact,
  resolveBatContact,
  swingOffset,
  SWING_DURATION,
  isBatStriking,
} from "../src/games/bat-physics.js";
import { canExpel } from "../src/games/bat-guidance.js";
import shape from "../src/games/projectile-shape.js";
import { Rhythm } from "../src/games/bat-game.js";
import { seeded } from "../src/games/kit.js";
import { bots, tap } from "./strategies.js";

const close = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const advance = (g, seconds, hz = 120) => {
  for (let t = 0; t < seconds && !g.finished; t += 1 / hz) g.step(1 / hz);
};

test("collider extraction keeps concave transparent gaps and computes mass around visible pixels", () => {
  const width = 9,
    height = 9,
    data = new Uint8ClampedArray(width * height * 4);
  // Hollow asymmetric shape; neither its rectangle nor its convex hull is solid.
  for (let y = 1; y < 8; y++)
    for (let x = 2; x < 8; x++) {
      if (x === 2 || x === 7 || y === 1 || y === 7)
        data[(y * width + x) * 4 + 3] = 255;
    }
  const s = shapeFromMask(createAlphaMask({ width, height, data }, 9, 9));
  assert.ok(s.center.x > 0);
  assert.ok(s.inertia > 0 && s.radius > 0);
  const b = makeProjectile(s, {
    x: 200,
    y: 300,
    vx: 0,
    vy: 0,
    size: 9,
    rotation: 0,
    flipY: false,
  });
  const probe = (x, y) =>
    batContact(b, s, { x, y }, [
      { a: { x, y }, b: { x, y }, radius: 0.05, from: 0, to: 0 },
    ]);
  assert.equal(probe(200, 300), null, "transparent interior stays empty");
  assert.equal(probe(196, 296), null, "transparent corner stays empty");
  assert.ok(probe(198, 300), "visible left edge contacts");
});

test("real sprite silhouette stays aligned through resizing, rotation, reflection and spin about its mass center", () => {
  for (const rotation of [0, 0.7, Math.PI * 1.25])
    for (const flipY of [false, true]) {
      const b = makeProjectile(shape, {
        x: 500,
        y: 300,
        vx: 0,
        vy: 0,
        size: 81,
        rotation,
        flipY,
      });
      close(b.x, 500);
      close(b.y, 300);
      const transform = (x, y) => ({
        x: b.x + (Math.cos(b.rotation) * x - Math.sin(b.rotation) * y) * 1.5,
        y:
          b.y +
          (Math.sin(b.rotation) * x + Math.cos(b.rotation) * y) *
            1.5 *
            (flipY ? -1 : 1),
      });
      const probe = (p) =>
        batContact(b, shape, p, [{ a: p, b: p, radius: 0.1, from: 0, to: 0 }]);
      const [px, py] = shape.points[50];
      assert.ok(probe(transform(px + shape.center.x, py + shape.center.y)));
      assert.equal(probe(transform(-21, -26)), null);
      const cx = b.cx,
        cy = b.cy;
      b.omega = 5;
      integrateProjectile(b, shape, 0.02);
      close(b.cx, cx);
      close(b.cy, cy);
      assert.notEqual(b.rotation, rotation);
      const x = b.x,
        y = b.y;
      syncArtwork(b, shape);
      close(b.x, x);
      close(b.y, y);
    }
});

const impactAt = (y) => {
  const body = {
    cx: 0,
    cy: 0,
    vx: -300,
    vy: 0,
    omega: 0,
    invMass: 1,
    invInertia: 1 / 200,
  };
  const bat = {
    x: -35,
    y: 0,
    gripX: -35,
    gripY: 70,
    vx: 0,
    vy: 0,
    omega: 8,
    invMass: 0,
    invInertia: 1 / 11000,
  };
  const contact = { x: 0, y, nx: 1, ny: 0, depth: 0, batFraction: 0.7 };
  const event = resolveBatContact(body, bat, contact);
  return { body, bat, event };
};
test("aligned impacts translate strongly, eccentric impacts spin and may keep approaching the player", () => {
  const central = impactAt(0),
    corner = impactAt(24);
  assert.ok(central.body.vx > 500);
  close(central.body.omega, 0);
  assert.ok(corner.body.vx < 0, "grazing contact is not an automatic save");
  assert.ok(Math.abs(corner.body.omega) > 20);
  assert.ok(corner.event.impulse < central.event.impulse / 2);
  assert.ok(central.bat.omega < 8, "bat recoils instead of an immovable wall");
});

test("contact impulse conserves momentum for free bodies and honors restitution; separating surfaces are not launched", () => {
  const b = {
    cx: 0,
    cy: 0,
    vx: -300,
    vy: 0,
    omega: 0,
    invMass: 1,
    invInertia: 0.005,
  };
  const bat = {
    x: 0,
    y: 0,
    vx: 200,
    vy: 0,
    omega: 0,
    invMass: 0.25,
    invInertia: 0.001,
  };
  const p = { x: 0, y: 0, nx: 1, ny: 0, depth: 0, batFraction: 0.5 };
  resolveBatContact(b, bat, p, { friction: 0, restitution: 0.42 });
  close(b.vx + 4 * bat.vx, -300 + 4 * 200);
  close(b.vx - bat.vx, 500 * 0.42);
  const vx = b.vx,
    omega = b.omega;
  const e = resolveBatContact(b, bat, p);
  assert.equal(e.impulse, 0);
  close(b.vx, vx);
  close(b.omega, omega);
});

test("a stationary bat yields; active swing adds energy without setting a canned launch velocity", () => {
  const moving = impactAt(0);
  const body = {
    cx: 0,
    cy: 0,
    vx: -300,
    vy: 0,
    omega: 0,
    invMass: 1,
    invInertia: 1 / 200,
  };
  const bat = {
    x: -35,
    y: 0,
    gripX: -35,
    gripY: 70,
    vx: 0,
    vy: 0,
    omega: 0,
    invMass: 0,
    invInertia: 1 / 11000,
  };
  resolveBatContact(body, bat, {
    x: 0,
    y: 0,
    nx: 1,
    ny: 0,
    depth: 0,
    batFraction: 0.7,
  });
  assert.ok(moving.body.vx > body.vx + 400);
  assert.ok(bat.omega < 0, "passive joint gives way");
});

test("rapid mouse motion transfers a weak impulse while a click strike keeps its full impact", () => {
  const collide = (striking) => {
    const body = {
        cx: 400,
        cy: 270,
        vx: -300,
        vy: 0,
        omega: 0,
        invMass: 1,
        invInertia: 1 / 200,
        radius: 25,
      },
      bat = {
        x: 365,
        y: 270,
        gripX: 365,
        gripY: 340,
        vx: 1000,
        vy: 0,
        omega: 0,
        invMass: 0,
        invInertia: 1 / 11000,
        swingAge: striking ? 0.15 : 99,
        aimVX: 1000,
        aimVY: 0,
      },
      contact = { x: 400, y: 270, nx: 1, ny: 0, depth: 0, batFraction: 0.7 },
      event = resolveBatContact(body, bat, contact, { striking });
    return { body, bat, event };
  };
  const passive = collide(false),
    strike = collide(true);
  assert.equal(
    passive.bat.vx,
    strike.bat.vx,
    "cursor positioning keeps the same speed",
  );
  assert.ok(passive.event.batRawPointSpeed >= 1000);
  assert.ok(passive.event.batPointSpeed <= 90);
  assert.ok(passive.event.impulse < strike.event.impulse / 3);
  assert.ok(Math.hypot(passive.body.vx, passive.body.vy) < 240);
  assert.ok(strike.body.vx > 800);
  assert.equal(canExpel(passive.body, passive.bat, passive.event), false);
  assert.equal(canExpel(strike.body, strike.bat, strike.event), true);
});

test("a fast mouse, windup and recovery cannot qualify as a click strike", () => {
  const body = { cx: 700, cy: 270, vx: 800, vy: 0, radius: 25 },
    event = { striking: true, batNormalSpeed: 700, batWork: 100000 },
    bat = { aimVX: 1200, aimVY: 1200 };
  for (const age of [-0.01, 0.02, 0.15, 0.4, 0.56, 99]) {
    bat.swingAge = age;
    assert.equal(isBatStriking(bat), age === 0.15);
    assert.equal(canExpel(body, bat, event), age === 0.15);
  }
  bat.swingAge = 0.15;
  assert.equal(canExpel(body, bat, { ...event, striking: false }), false);
});

test("the physical return reaches its resting angle and zero angular speed at the existing cooldown deadline", () => {
  for (const dt of [1 / 240, 1 / 1000]) {
    const bat = createBat(280, 294);
    let time = 0,
      disturbed = false;
    while (time < SWING_DURATION - 1e-9) {
      const step = Math.min(dt, SWING_DURATION - time),
        previous = bat.angle;
      time += step;
      driveBat(bat, { x: 280, y: 294 }, time, step);
      if (!disturbed && time >= 0.39) {
        bat.omega -= 3;
        disturbed = true;
      }
      assert.ok(
        Math.abs(bat.angle - previous) < 18 * step,
        "recoil returns continuously",
      );
    }
    close(bat.angle, bat.restAngle);
    close(bat.omega, 0);
  }
});

test("bat follows the cursor with bounded smoothing and a continuous windup, follow-through and return", () => {
  const bat = createBat(245, 365);
  driveBat(bat, { x: 600, y: 230 }, 99, 1 / 240);
  assert.ok(bat.aimX > 245 && bat.aimX < 251);
  assert.ok(Math.hypot(bat.vx, bat.vy) <= 1200.001);
  const b = createBat(280, 294);
  let previous = b.angle;
  for (let t = 0; t < SWING_DURATION + 0.25; t += 1 / 240) {
    driveBat(b, { x: 280, y: 294 }, t, 1 / 240);
    assert.ok(
      Math.abs(b.angle - previous) < 0.076,
      "no pose teleport on recovery",
    );
    previous = b.angle;
  }
  assert.ok(
    swingOffset(0.4) > 0.5 && swingOffset(0.4) < 1.08,
    "return has visible duration",
  );
  close(swingOffset(SWING_DURATION), 0);
  close(swingOffset(0.205 - 1e-7), swingOffset(0.205 + 1e-7), 1e-5);
  close(swingOffset(0.295 - 1e-7), swingOffset(0.295 + 1e-7), 1e-5);
  assert.ok(batCapsules(b).every((p) => p.radius > 0));
});

test("fast projectiles cannot tunnel through the moving bat in a slow frame", () => {
  const g = new Rhythm({ random: seeded(3) });
  g.bat = createBat(280, 294);
  g.move(280, 294);
  g.next = 999;
  const b = makeProjectile(shape, { x: 330, y: 294, vx: -1600, vy: 0 });
  b.free = true;
  g.shots = [b];
  g.step(0.05);
  assert.ok(b.contacts > 0 && g.contacts.length > 0);
  assert.ok(b.vx > -1600);
});

test("partially hit projectiles retain their trajectory, spin, and ability to hurt the player", () => {
  const g = new Rhythm();
  g.next = 999;
  const b = makeProjectile(shape, { x: 600, y: 250, vx: 220, vy: -180 });
  b.free = true;
  b.contacts = 1;
  b.omega = 8;
  b.dirX = -1;
  b.dirY = 0;
  g.shots = [b];
  const rotation = b.rotation;
  g.step(0.05);
  assert.ok(b.vx > 200 && b.vy < 0 && b.rotation !== rotation);
  const weak = makeProjectile(shape, { x: 140, y: 294, vx: -200, vy: 0 });
  weak.free = true;
  weak.contacts = 1;
  weak.omega = 5;
  g.shots = [weak];
  g.step(0.05);
  assert.equal(g.lives, 2);
  assert.equal(g.hitCount, 1);
  assert.equal(g.shots.length, 0);
  advance(g, 0.1);
  assert.equal(g.hitCount, 1);
});

test("swing cooldown rejects spam and buffers only one click near the end of recovery", () => {
  const g = new Rhythm();
  g.next = 999;
  g.shots = [];
  tap(g, 280, 294);
  const swing = g.swing;
  advance(g, 0.2);
  tap(g, 280, 294);
  assert.equal(g.swing, swing);
  assert.equal(g.queuedSwing, false);
  advance(g, 0.3);
  tap(g, 280, 294);
  assert.equal(g.swing, swing);
  assert.equal(g.queuedSwing, true);
  advance(g, 0.08);
  assert.notEqual(g.swing, swing);
  assert.equal(g.queuedSwing, false);
});

test("missed swings create no phantom hits; parking the bat cannot win without playing", () => {
  const g = new Rhythm({ random: seeded(3) });
  tap(g, 700, 450);
  advance(g, 0.6);
  assert.equal(g.contacts.length, 0);
  assert.equal(g.score, 0);
  const parked = new Rhythm({ random: seeded(3) });
  parked.move(280, 294);
  while (!parked.finished) parked.step(1 / 60);
  assert.equal(parked.reason, "impact");
  assert.equal(parked.hitCount, 3);
});

test("mouse-only swing timing survives at 20–120 fps using actual contact physics", () => {
  for (const hz of [20, 30, 60, 120]) {
    const g = new Rhythm({ random: seeded(3) });
    while (!g.finished) {
      bots.rhythm(g);
      g.step(1 / hz);
    }
    assert.equal(g.reason, "survived", `${hz} fps`);
    assert.ok(g.score >= 25);
    assert.ok(g.contacts.length > 25);
  }
});
