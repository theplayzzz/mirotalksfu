import test from "node:test";
import assert from "node:assert/strict";
import { Web } from "../src/games/web-game.js";
import {
  attachWeb,
  rayRectangle,
  stepPendulum,
  WEB_GRAVITY,
  WEB_SWING_GRAVITY,
} from "../src/games/web-physics.js";
import { distance } from "../src/games/kit.js";
import { bots } from "./strategies.js";

function advance(g, seconds) {
  for (let t = 0; t < seconds && !g.finished; t += 1 / 120) g.step(1 / 120);
}

test("web ray finds the first surface within range, including parallel and backward rays", () => {
  const rect = { x: 200, y: 40, w: 100, h: 30 };
  assert.deepEqual(rayRectangle({ x: 250, y: 300 }, { x: 0, y: -1 }, rect), {
    distance: 230,
    x: 250,
    y: 70,
  });
  assert.equal(
    rayRectangle({ x: 250, y: 300 }, { x: 0, y: -1 }, rect, 229),
    null,
  );
  assert.equal(rayRectangle({ x: 250, y: 300 }, { x: 0, y: 1 }, rect), null);
  assert.equal(rayRectangle({ x: 150, y: 300 }, { x: 0, y: -1 }, rect), null);
  const g = new Web();
  g.blocks = [rect, { ...rect, y: 100 }].map((b, id) => ({ ...b, id }));
  g.player = { x: 250, y: 300, vx: 0, vy: 0 };
  g.move(250, 0);
  assert.equal(
    g.aim().hit.blockId,
    1,
    "nearest block occludes the farther one",
  );
  g.cameraX = 100;
  g.move(150, 0);
  assert.equal(g.aim().hit.x, 250, "mouse aims in scrolling world coordinates");
});

test("web has a finite flight time; releasing in flight cancels attachment", () => {
  const g = new Web();
  g.move(280, 70);
  g.press();
  advance(g, 0.04);
  assert.ok(g.shot && !g.rope);
  assert.ok(g.shot.travelled > 110 && g.shot.travelled < 150);
  g.release();
  advance(g, 0.3);
  assert.equal(g.attachments, 0);
  assert.equal(g.rope, null);
  g.press();
  advance(g, 0.3);
  assert.equal(g.attachments, 1);
  assert.equal(g.rope.y, 12);
});

test("a diagonal web lands on the block surface despite floating-point rounding", () => {
  const hit = rayRectangle(
    { x: 57.09891230799258, y: 478.15429471665993 },
    { x: 0.6099275452599057, y: -0.7924571846688159 },
    { x: 220, y: 46, w: 180, h: 24 },
    560,
  );
  assert.equal(hit.y, 70);
  assert.ok(hit.x >= 220 && hit.x <= 400);
});

test("missing a block consumes the flight instead of creating a floating anchor", () => {
  const g = new Web();
  g.move(800, 335);
  g.press();
  advance(g, 0.5);
  assert.equal(g.shot, null);
  assert.equal(g.rope, null);
  assert.equal(g.attachments, 0);
});

test("the initial pull eases to a bounded length without teleporting or reeling forever", () => {
  const p = { x: 0, y: 300, vx: 0, vy: 0 },
    rope = attachWeb(p, { x: 150, y: 0 });
  const start = { ...p },
    length = rope.length,
    amount = rope.reelAmount;
  stepPendulum(p, rope, 1 / 240);
  assert.ok(distance(p, start) < 0.5);
  for (let i = 0; i < 240; i++) stepPendulum(p, rope, 1 / 240);
  assert.ok(amount > 35 && amount < 100);
  assert.ok(Math.abs(rope.length - (length - amount)) < 1e-8);
  const after = rope.length;
  for (let i = 0; i < 240; i++) stepPendulum(p, rope, 1 / 240);
  assert.equal(rope.length, after, "holding cannot reel indefinitely");
});

test("a low grapple raises the body promptly and leaves the pendulum clear of the floor", () => {
  const heights = [];
  for (const dt of [1 / 240, 1 / 480]) {
    const body = { x: 320, y: 440, vx: 0, vy: 0 },
      rope = attachWeb(body, { x: 500, y: 70 });
    let elapsed = 0;
    while (elapsed < 0.4 - 1e-8) {
      const before = { ...body };
      stepPendulum(body, rope, dt);
      assert.ok(distance(body, before) < 4, "the lift is continuous");
      elapsed += dt;
    }
    assert.ok(
      body.y < 330 && body.y > 270,
      "visible lift near the illustrated height",
    );
    assert.ok(
      rope.y + rope.length + 35 < 450,
      "the belly of the swing clears the floor hazards",
    );
    assert.ok(
      Math.hypot(body.vx, body.vy) < 400,
      "reeling does not add a huge launch velocity",
    );
    assert.equal(rope.reelLeft, 0);
    heights.push(body.y);
  }
  assert.ok(Math.abs(heights[0] - heights[1]) < 1);
});

test("the pull responds more strongly near the ground while keeping short anchors bounded", () => {
  const low = attachWeb({ x: 320, y: 440 }, { x: 500, y: 70 }),
    high = attachWeb({ x: 320, y: 260 }, { x: 500, y: 70 });
  assert.ok(low.reelAmount > high.reelAmount + 50);
  const short = attachWeb({ x: 400, y: 145 }, { x: 400, y: 70 });
  assert.equal(short.length, 75);
  assert.equal(short.reelAmount, 0);
  assert.ok(low.reelDuration < 0.42 && high.reelDuration >= 0.18);
});

test("finishing the lift leaves a supported swing, without an inward kick, slack or a second drop", () => {
  for (const hz of [120, 240, 480])
    for (const offset of [0, 180]) {
      const body = { x: 320, y: 440, vx: 0, vy: 0 },
        rope = attachWeb(body, { x: 320 + offset, y: 70 });
      let settled = false;
      for (let i = 0; i < hz; i++) {
        stepPendulum(body, rope, 1 / hz);
        const length = distance(body, rope);
        assert.ok(
          Math.abs(length - rope.length) < 0.02,
          "the lift must not leave artificial slack",
        );
        if (rope.reelLeft > 0) continue;
        settled = true;
        const radial =
          ((body.x - rope.x) * body.vx + (body.y - rope.y) * body.vy) / length;
        assert.ok(
          Math.abs(radial) < 1e-6,
          "only the tangent remains after reeling",
        );
        if (!offset) {
          assert.ok(Math.abs(body.y - (rope.y + rope.targetLength)) < 0.02);
          assert.ok(
            Math.abs(body.vy) < 1e-6,
            "a vertical lift holds its new height",
          );
        }
      }
      assert.ok(settled);
    }
});

test("the attached pendulum is slightly faster while released flight keeps its original gravity", () => {
  const crossing = (options) => {
    const body = { x: -150, y: 200, vx: 0, vy: 0 },
      rope = attachWeb(body, { x: 0, y: 0 });
    rope.reelLeft = 0;
    let time = 0;
    while (body.x < 0 && time < 2) {
      stepPendulum(body, rope, 1 / 480, options);
      time += 1 / 480;
    }
    return time;
  };
  const previous = crossing({ gravity: WEB_GRAVITY }),
    faster = crossing();
  assert.ok(faster < previous * 0.97 && faster > previous * 0.9);
  const body = { x: 0, y: 0, vx: 0, vy: 0 };
  stepPendulum(body, null, 0.1);
  assert.equal(body.vy, 78);
});

test("the initial roof contact lets the grapple lift off without pinning or stretching the rope", () => {
  for (const hz of [20, 60, 120]) {
    const g = new Web();
    let attached = false,
      lifted = false;
    for (let i = 0; i < hz && !g.finished; i++) {
      bots.web(g, hz);
      g.step(1 / hz);
      lifted ||= g.player.x > 170 && g.player.y < 325;
      if (g.rope) {
        attached = true;
        assert.ok(distance(g.player, g.rope) <= g.rope.length + 0.02);
      }
    }
    assert.ok(attached && lifted);
  }
});

test("taut cable removes outward velocity while preserving the tangent; a slack cable cannot push", () => {
  const p = { x: 0, y: 100, vx: 200, vy: 40 },
    rope = attachWeb(p, { x: 0, y: 0 });
  rope.reelLeft = 0;
  stepPendulum(p, rope, 1 / 10000, { gravity: 0, drag: 0 });
  assert.ok(Math.abs(distance(p, rope) - 100) < 1e-8);
  assert.ok(Math.abs(p.vx - 200) < 0.02);
  assert.ok(Math.abs((p.x * p.vx + p.y * p.vy) / 100) < 1e-8);
  Object.assign(p, { x: 0, y: 60, vx: 7, vy: -20 });
  stepPendulum(p, rope, 0.01, { gravity: 0, drag: 0 });
  assert.equal(rope.taut, false);
  assert.equal(p.vy, -20);
  assert.ok(distance(p, rope) < 61);
});

test("gravity swings in both directions without continually injecting energy", () => {
  const p = { x: -150, y: 200, vx: 0, vy: 0 },
    rope = attachWeb(p, { x: 0, y: 0 });
  rope.reelLeft = 0;
  const initialEnergy = -WEB_SWING_GRAVITY * p.y;
  let left = false,
    right = false,
    maxEnergy = initialEnergy;
  for (let i = 0; i < 240 * 7; i++) {
    stepPendulum(p, rope, 1 / 240);
    left ||= p.vx < -100;
    right ||= p.vx > 100;
    maxEnergy = Math.max(
      maxEnergy,
      0.5 * (p.vx ** 2 + p.vy ** 2) - WEB_SWING_GRAVITY * p.y,
    );
    assert.ok(distance(p, rope) <= rope.length + 1e-7);
  }
  assert.ok(left && right, "holding permits a return swing");
  assert.ok(
    maxEnergy <= initialEnergy + 1000,
    "constraint does not pump momentum",
  );
});

test("release adds a small forward and upward jump to the existing pendulum velocity", () => {
  const g = new Web();
  g.move(280, 70);
  g.press();
  advance(g, 0.85);
  assert.ok(g.rope && g.player.vx > 100);
  const before = { ...g.player };
  g.release();
  assert.equal(g.player.x, before.x);
  assert.equal(g.player.y, before.y);
  assert.equal(g.player.vx, before.vx + 30);
  assert.equal(g.player.vy, before.vy - 110);
  const launched = { ...g.player };
  advance(g, 0.05);
  assert.ok(g.player.x > before.x + launched.vx * 0.04);
  assert.ok(g.player.vy > launched.vy + 35);
});

test("the empty floor safely catches fast falls, and the goal requires crossing the actual flag", () => {
  const falling = new Web();
  falling.player = { x: 300, y: 390, vx: 0, vy: 3000 };
  advance(falling, 0.05);
  assert.ok(
    falling.player.y < 490,
    "continuous contact prevents tunnelling through the floor",
  );
  advance(falling, 2.5);
  assert.equal(falling.finished, false);
  assert.ok(falling.player.y > 475 && falling.player.y < 490);
  assert.equal(falling.floor.length, 0);
  const floorHeight = falling.player.y;
  falling.move(470, 0);
  falling.press();
  advance(falling, 0.6);
  assert.ok(
    falling.rope && falling.player.y < floorHeight - 80,
    "the player can grapple back into the course after landing",
  );
  const g = new Web();
  Object.assign(g.player, { x: g.finish.lineX - 2, y: 300, vx: 0, vy: 0 });
  g.refreshVisible();
  g.step(1 / 120);
  assert.equal(g.finished, false);
  g.player.vx = 400;
  g.step(1 / 120);
  assert.equal(g.reason, "survived");
  assert.equal(g.courseProgress, 1);
  const idle = new Web({ duration: 8 });
  advance(idle, 8.1);
  assert.equal(idle.reason, "timeout", "waiting on the platform cannot win");
});

test("the release jump adds a modest arc and extra airtime for the next web", () => {
  const flight = (kick) => {
    const g = new Web();
    Object.assign(g.player, { x: 400, y: 350, vx: 260, vy: -140 });
    g.rope = attachWeb(g.player, { x: 250, y: 70 });
    g.input.down = true;
    g.release({ kick });
    let apex = g.player.y,
      time = 0;
    while (time < 2) {
      stepPendulum(g.player, null, 1 / 240);
      time += 1 / 240;
      apex = Math.min(apex, g.player.y);
      if (g.player.y >= 350 && g.player.vy > 0) break;
    }
    return { apex, time, x: g.player.x };
  };
  const natural = flight(false),
    jump = flight(true);
  assert.ok(natural.apex - jump.apex > 20 && natural.apex - jump.apex < 40);
  assert.ok(jump.time - natural.time > 0.25 && jump.time - natural.time < 0.32);
  assert.ok(jump.x > natural.x + 60);
});

test("cancelling, pausing and finishing do not give a jump; repeated releases cannot create air jumps", () => {
  const g = new Web();
  Object.assign(g.player, { x: 400, y: 350, vx: 260, vy: -140 });
  const before = { ...g.player };
  g.rope = attachWeb(g.player, { x: 250, y: 70 });
  g.input.down = true;
  g.release({ kick: false });
  assert.deepEqual(g.player, before);
  g.input.down = true;
  g.release();
  assert.deepEqual(g.player, before, "no attached rope, no impulse");
  g.rope = attachWeb(g.player, { x: 250, y: 70 });
  g.input.down = true;
  g.finished = true;
  g.release();
  assert.deepEqual(g.player, before);
  g.finished = false;
  g.rope = attachWeb(g.player, { x: 250, y: 70 });
  g.input.down = true;
  g.release();
  const jumped = { ...g.player };
  for (let i = 0; i < 5; i++) g.release();
  assert.deepEqual(g.player, jumped);
});

test("the assist does not replace a return swing with a preset forward launch", () => {
  const g = new Web();
  Object.assign(g.player, { x: 400, y: 350, vx: -250, vy: -80 });
  g.rope = attachWeb(g.player, { x: 550, y: 70 });
  g.input.down = true;
  g.release();
  assert.ok(g.player.vx < -200 && g.player.vy < -150);
});

for (const [duration, hz] of [
  [8, 60],
  [8, 120],
  [25, 20],
  [25, 60],
  [25, 120],
  [40, 60],
])
  test(`mouse-only web course is reachable in a ${duration}s round at ${hz}Hz`, () => {
    const g = new Web({ duration });
    let maxCamera = 0;
    for (let i = 0; i < duration * hz + 1 && !g.finished; i++) {
      bots.web(g, hz);
      g.step(1 / hz);
      maxCamera = Math.max(maxCamera, g.cameraX);
      for (const v of Object.values(g.player)) assert.ok(Number.isFinite(v));
    }
    assert.equal(
      g.reason,
      "survived",
      `${g.detail}: ${JSON.stringify(g.player)}`,
    );
    assert.ok(g.attachments >= (duration === 8 ? 2 : 5));
    assert.ok(g.releases >= (duration === 8 ? 1 : 5));
    assert.ok(g.player.x >= g.finish.lineX && g.elapsed < duration);
    if (duration > 8) assert.ok(maxCamera > 960);
  });
