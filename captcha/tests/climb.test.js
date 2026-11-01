import test from "node:test";
import assert from "node:assert/strict";
import { Climb } from "../src/games/platforming.js";
import { seeded } from "../src/games/kit.js";
import { bots } from "./strategies.js";
import { climbMotion, climbPlatformPose } from "../src/games/climb-motion.js";
import {
  climbFootprint as footprint,
  platformLanding,
} from "../src/games/platform-contact.js";
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("both edges accept 20 and 50 percent of the visible character width, but not 19 percent", () => {
  const p = { x: 300, y: 300, w: 100 };
  for (const side of ["left", "right"])
    for (const fraction of [0.19, 0.2, 0.5]) {
      const x =
          side === "left"
            ? p.x + footprint.width * fraction - footprint.right
            : p.x + p.w - footprint.width * fraction - footprint.left,
        hit = platformLanding({ x, y: 240 }, { x, y: 340 }, p, p);
      if (fraction < 0.2) {
        assert.equal(hit, null);
        continue;
      }
      assert.ok(hit);
      close(hit.fraction, fraction);
      assert.ok(
        side === "left" ? hit.x <= p.x : hit.x >= p.x + p.w,
        "the center can be outside the platform",
      );
      assert.ok(
        footprint.feet.some(
          (f) =>
            Math.abs(hit.y + f.bottom - p.y) < 1e-7 &&
            Math.min(hit.x + f.right, p.x + p.w) >
              Math.max(hit.x + f.left, p.x),
        ),
      );
    }
});

test("the landing sweep catches a mid-frame overlap and rejects a late sideways overlap below the platform", () => {
  const p = { x: 300, y: 300, w: 100 },
    hit = platformLanding({ x: 250, y: 260 }, { x: 450, y: 320 }, p, p);
  assert.ok(hit && hit.t > 0 && hit.t < 1 && hit.fraction >= 0.2);
  assert.equal(
    platformLanding({ x: 100, y: 270 }, { x: 350, y: 400 }, p, p),
    null,
  );
  assert.equal(
    platformLanding({ x: 350, y: 340 }, { x: 350, y: 240 }, p, p),
    null,
    "upward motion passes through",
  );
});

test("platform movement and changing width are evaluated at the contact instant", () => {
  const staticPlatform = { x: 300, y: 300, w: 100 },
    edgeX = 300 + 0.2 * footprint.width - footprint.right,
    fixed = platformLanding(
      { x: edgeX, y: 240 },
      { x: edgeX, y: 340 },
      staticPlatform,
      staticPlatform,
    ),
    moving = platformLanding(
      { x: edgeX, y: 240 },
      { x: edgeX + 20, y: 340 },
      { x: 320, y: 300, w: 100 },
      staticPlatform,
    );
  assert.ok(fixed && moving);
  close(moving.t, fixed.t);
  close(moving.fraction, fixed.fraction);
  close(moving.fraction, 0.2);
  close(moving.x, fixed.x + 20 * moving.t);
  close(moving.left, 300 + 20 * moving.t);
  const narrowing = platformLanding(
    { x: 350, y: 240 },
    { x: 350, y: 340 },
    { x: 320, y: 300, w: 60 },
    staticPlatform,
  );
  assert.ok(narrowing);
  close(narrowing.right - narrowing.left, 100 - 40 * narrowing.t);
});

test("an edge landing actually launches the character and consumes that platform once", () => {
  for (const side of ["left", "right"]) {
    const g = new Climb({ hits: () => false }),
      p = { i: 1, x: 300, centerX: 350, y: 300, w: 100, used: false, phase: 0 };
    g.platforms = [p];
    Object.defineProperty(g, "platformWidth", { get: () => 100 });
    g.ensurePlatforms = () => {};
    const x =
      side === "left"
        ? p.x + 0.2 * footprint.width - footprint.right
        : p.x + p.w - 0.2 * footprint.width - footprint.left;
    g.player = { x, y: 270 };
    g.input.x = x;
    g.vy = 200;
    for (let i = 0; i < 20 && !g.score; i++) g.step(1 / 120);
    assert.equal(g.score, 1);
    assert.ok(g.vy < 0);
    assert.equal(p.used, true);
    assert.equal(g.lastLanding.platformId, 1);
    close(g.lastLanding.fraction, 0.2);
    for (let i = 0; i < 12; i++) g.step(1 / 120);
    assert.equal(g.score, 1);
  }
});

test("platforms narrow early, including those already generated ahead of the camera", () => {
  const g = new Climb({ random: seeded(3) });
  const p = g.platforms.find((p) => !p.used);
  const center = p.x + p.w / 2;
  assert.equal(p.w, 100);
  g.elapsed = g.duration / 3;
  g.update(0);
  assert.equal(g.difficulty, 1);
  assert.equal(p.w, 66);
  assert.equal(p.x + p.w / 2, center);
  g.elapsed = g.duration;
  g.update(0);
  assert.equal(p.w, 58);
});

test("occasional platforms cross most of the arena while the others keep shorter ranges", () => {
  const g = new Climb({ random: seeded(3) });
  g.camera = 6000;
  g.ensurePlatforms();
  const roaming = g.platforms.filter((p) => p.motion === "roaming"),
    local = g.platforms.filter((p) => p.i > 1 && p.motion === "local");
  assert.ok(roaming.length >= 8 && local.length > roaming.length * 2);
  for (let i = 1; i < roaming.length; i++)
    assert.ok(roaming[i].i - roaming[i - 1].i >= 4);
  for (const p of [...roaming, ...local]) {
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i <= 240; i++) {
      const pose = climbPlatformPose(
        { ...p, phase: (i * Math.PI) / 120 },
        1,
        0,
      );
      min = Math.min(min, pose.x);
      max = Math.max(max, pose.x);
      assert.ok(pose.x >= 48 - 1e-7 && pose.x + pose.w <= 912 + 1e-7);
    }
    assert.ok(p.motion === "roaming" ? max - min > 750 : max - min < 185);
  }
});

test("both movement ranges expand late and larger ranges do not multiply the travel speed", () => {
  let previous = climbMotion(1 / 3);
  for (const progress of [0.5, 0.75, 0.9, 0.96, 1]) {
    const current = climbMotion(progress);
    assert.ok(current.localAmplitude > previous.localAmplitude);
    assert.ok(current.roamingAmplitude > previous.roamingAmplitude);
    previous = current;
  }
  for (const intensity of [0.7, 0.9, 1.5]) {
    const delta = climbMotion(1, intensity).travelSpeed / 120;
    const distances = ["local", "roaming"].map((motion) => {
      const p = {
        i: 2,
        centerX: 480,
        phase: 0,
        rangeScale: 1,
        motionRate: 1,
        motion,
      };
      return climbPlatformPose(p, 1, delta).x - climbPlatformPose(p, 1, 0).x;
    });
    assert.ok(distances.every((d) => d <= delta && d > delta * 0.99));
  }
});

test("platform motion keeps accelerating through the last seconds of short and long rounds", () => {
  for (const duration of [8, 25, 40]) {
    const g = new Climb({ duration, intensity: 1, random: seeded(3) }),
      checkpoints = [0, 1 / 3, 0.5, 0.75, 0.9, 0.96, 1];
    let previous = 0;
    const rates = checkpoints.map((progress) => {
      g.elapsed = duration * progress;
      const rate = g.platformTravelSpeed;
      assert.ok(
        rate > previous,
        `${duration}s at ${progress}: no late plateau`,
      );
      previous = rate;
      return rate;
    });
    assert.ok(rates.at(-1) > rates[1] * 2.7);
    assert.ok(rates.at(-2) > rates[2] * 1.9);
    assert.ok(rates.at(-1) < rates[1] * 2.8, "bounded final speed");
  }
});

test("already visible platforms move faster near the deadline without a phase jump", () => {
  const displacement = (progress) => {
    const g = new Climb({ random: seeded(3), intensity: 1 }),
      p = g.platforms.find((p) => p.i === 2);
    p.phase = 0;
    g.elapsed = g.duration * progress;
    g.update(0);
    const before = p.drawX;
    g.update(0);
    assert.equal(
      p.drawX,
      before,
      "difficulty changes cannot advance the phase without time",
    );
    g.update(1 / 120);
    return { distance: Math.abs(p.drawX - before), phase: g.platformClock };
  };
  const middle = displacement(0.5),
    late = displacement(0.98);
  assert.ok(late.phase > middle.phase * 1.9);
  assert.ok(late.distance > middle.distance * 2.7);
  assert.ok(late.distance < 8, "one frame remains continuous at maximum speed");
});

test("keyboard directions cannot move the character, and mouse following has a small lag", () => {
  const g = new Climb({ random: seeded(3) });
  g.input.keys.add("arrowright");
  g.input.keys.add("d");
  g.step(0.05);
  assert.equal(g.input.x, 480);
  assert.equal(g.player.x, 480);
  g.move(520, 200);
  g.step(0.05);
  assert.ok(g.player.x > 480 && g.player.x < 520);
  assert.ok(
    Math.abs(g.player.x - (480 + 40 * (1 - Math.exp(-0.05 / 0.115)))) < 1e-7,
  );
});

test("narrow moving platforms still allow a full mouse-only climb at different frame rates", () => {
  for (const seed of [1, 3, 9, 21])
    for (const dt of [1 / 120, 1 / 30]) {
      const g = new Climb({ random: seeded(seed) });
      while (!g.finished) {
        bots.climb(g);
        g.step(dt);
      }
      assert.equal(
        g.reason,
        "survived",
        `seed=${seed}, dt=${dt}, score=${g.score}`,
      );
      assert.ok(g.score > 20);
    }
});

test("the faster final platforms remain reachable at high intensity using only the mouse", () => {
  for (const [duration, dt, seed] of [
    [8, 1 / 30, 3],
    [25, 1 / 120, 9],
    [40, 1 / 20, 21],
  ]) {
    const g = new Climb({ duration, intensity: 1.5, random: seeded(seed) });
    while (!g.finished) {
      bots.climb(g);
      g.step(dt);
    }
    assert.equal(
      g.reason,
      "survived",
      `${duration}s, ${dt}s step, score=${g.score}`,
    );
    assert.ok(g.score > duration);
  }
});
