import test from "node:test";
import assert from "node:assert/strict";
import {
  makePlayer,
  playerCircles,
  playerExtents,
  circleRectContact,
  sweepCircleRect,
  resolveRoofContact,
  stepRoofBody,
  roofSupport,
  roofEquilibrium,
  playerShape,
} from "../src/games/roof-physics.js";
import { Stretch } from "../src/games/rooftops-game.js";
import { seeded } from "../src/games/kit.js";
import { launchPlan, bots } from "./strategies.js";
import { FLOOR_INK } from "../src/games/roof-course.js";
const close = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("continuous collision uses a rounded corner instead of the expanded rectangle's empty corner", () => {
  const box = { x: 50, y: 50, w: 80, h: 100 };
  const p = sweepCircleRect({ x: 0, y: 0, r: 10 }, 100, 100, box);
  close(p.time, (50 - Math.sqrt(50)) / 100);
  close(p.nx, -Math.SQRT1_2);
  close(p.ny, -Math.SQRT1_2);
  close(p.x, 50);
  close(p.y, 50);
  assert.equal(sweepCircleRect({ x: 38, y: 38, r: 10 }, 1, 1, box), null);
});

test("fast sweeps hit roofs, facades and undersides before passing through", () => {
  const box = { x: 300, y: 300, w: 200, h: 20 };
  const roof = sweepCircleRect({ x: 400, y: 50, r: 10 }, 0, 1000, box);
  close(roof.time, 0.24);
  assert.equal(roof.ny, -1);
  const side = sweepCircleRect({ x: 10, y: 310, r: 10 }, 3000, 0, box);
  close(side.time, 280 / 3000);
  assert.equal(side.nx, -1);
  const bottom = sweepCircleRect({ x: 400, y: 400, r: 10 }, 0, -400, box);
  close(bottom.time, 0.175);
  assert.equal(bottom.ny, 1);
});

test("the player follows its transparent silhouette instead of a square, including while rotated", () => {
  const body = makePlayer(100, 100);
  assert.equal(playerShape.circles.length, 13);
  assert.ok(playerShape.maxOutlineGap < 0.75);
  const empty = { x: 70, y: 71, w: 4, h: 3 };
  assert.ok(playerCircles(body).every((c) => !circleRectContact(c, empty)));
  assert.ok(
    playerCircles(body).some((c) =>
      circleRectContact(c, { x: 97, y: 128, w: 10, h: 20 }),
    ),
  );
  for (const angle of [0.4, 1.8, Math.PI]) {
    const b = makePlayer(100, 100, angle),
      bounds = playerExtents(angle);
    close(b.x, 100);
    close(b.y, 100);
    const parts = playerCircles(b);
    close(Math.max(...parts.map((c) => c.y + c.r)), 100 + bounds.bottom);
    close(Math.min(...parts.map((c) => c.x - c.r)), 100 + bounds.left);
  }
});

test("normal impacts bounce, while an eccentric impact transfers motion into spin", () => {
  const straight = makePlayer(0, 0);
  straight.vy = 400;
  const normal = {
    x: straight.cx,
    y: straight.cy + 28,
    nx: 0,
    ny: -1,
    depth: 0,
  };
  resolveRoofContact(straight, normal);
  close(straight.vy, -65);
  close(straight.vx, 0);
  close(straight.omega, 0);
  const edge = makePlayer(0, 0);
  edge.vx = 300;
  edge.vy = 400;
  resolveRoofContact(edge, {
    x: edge.cx + 25,
    y: edge.cy + 20,
    nx: 0,
    ny: -1,
    depth: 0,
  });
  assert.ok(Math.abs(edge.omega) > 1);
  assert.notEqual(edge.vy, straight.vy);
  assert.ok(
    edge.vx > 0,
    "a glancing hit can continue forward instead of a canned reversal",
  );
});

test("high falls rebound less, slide less and settle sooner on roofs at different frame rates", () => {
  function landing(vx, hz, options) {
    const roof = { id: 1, x: 0, y: 350, w: 1600, h: 500 },
      body = makePlayer(500, 60);
    body.vx = vx;
    body.vy = 850;
    let first = null,
      bounce = 0,
      forward = 0,
      rest = 0,
      elapsed = 0;
    while (elapsed < 6) {
      const events = stepRoofBody(body, [roof], 1 / hz, options);
      elapsed += 1 / hz;
      if (!first && events.some((p) => p.ny < -0.65 && p.impulse > 20))
        first = { x: body.x, at: elapsed };
      if (!first) continue;
      bounce = Math.max(
        bounce,
        roof.y - body.y - playerExtents(body.angle).bottom,
      );
      forward = Math.max(forward, body.x - first.x);
      if (
        roofEquilibrium(body, [roof]) &&
        Math.hypot(body.vx, body.vy) < 18 &&
        Math.abs(body.omega) < 0.5
      )
        rest += 1 / hz;
      else rest = 0;
      if (rest > 0.3)
        return { bounce, forward, settledAfter: elapsed - first.at };
    }
    assert.fail("the body should settle on the wide roof");
  }
  const legacy = {
    restitution: 0.26,
    friction: 0.78,
    surfaceDrag: 0,
    maxRoofRebound: Infinity,
  };
  for (const hz of [20, 60, 120])
    for (const vx of [280, 450]) {
      const before = landing(vx, hz, legacy),
        after = landing(vx, hz, {});
      assert.ok(after.bounce < before.bounce * 0.5, `${hz}Hz rebound`);
      assert.ok(after.forward < before.forward * 0.5, `${hz}Hz runout`);
      assert.ok(
        after.settledAfter < before.settledAfter * 0.8,
        `${hz}Hz settling`,
      );
    }
});

test("the softer roof material does not brake or alter a free airborne trajectory", () => {
  const body = makePlayer(200, 150, 0.3),
    previous = { ...body };
  body.vx = previous.vx = 400;
  body.vy = previous.vy = -500;
  body.omega = previous.omega = 2;
  for (let i = 0; i < 24; i++) {
    stepRoofBody(body, [], 1 / 120);
    stepRoofBody(previous, [], 1 / 120, {
      restitution: 0.26,
      friction: 0.78,
      surfaceDrag: 0,
      maxRoofRebound: Infinity,
    });
  }
  assert.deepEqual(body, previous);
});

test("aiming and an empty click do not start the clock, while the first launch starts it for the rest of the round", () => {
  const g = new Stretch({ random: seeded(3) });
  for (let i = 0; i < 600; i++) g.step(0.05);
  assert.equal(g.elapsed, 0);
  assert.equal(g.finished, false);
  g.move(g.anchor.x, g.anchor.y);
  g.press();
  g.release();
  g.step(0.05);
  assert.equal(g.clockStarted, false);
  assert.equal(g.elapsed, 0);
  const p = launchPlan(g);
  g.press();
  g.move(g.anchor.x + p.x, g.anchor.y + p.y);
  g.release();
  assert.equal(g.clockStarted, true);
  while (g.phase === "flying" && !g.finished) g.step(1 / 60);
  assert.equal(g.phase, "aim");
  assert.equal(g.score, 1);
  const elapsed = g.elapsed;
  for (let i = 0; i < 10; i++) g.step(0.05);
  close(g.elapsed, elapsed + 0.5);
});

test("a real silhouette edge hits the roof even when the player's center is outside the building", () => {
  const box = { id: 1, x: 400, y: 300, w: 120, h: 214 },
    b = makePlayer(385, 200);
  b.vy = 500;
  let event = null;
  for (let i = 0; i < 80 && !event; i++)
    event = stepRoofBody(b, [box], 1 / 120).find((p) => p.impulse > 10);
  assert.ok(event);
  assert.equal(event.buildingId, 1);
  assert.ok(
    b.cx < box.x,
    "the old center-only condition would miss this contact",
  );
  assert.ok(event.ny < -0.5);
  assert.ok(Math.abs(b.omega) > 1);
  assert.ok(
    b.vx < 0,
    "this eccentric corner contact pushes the character back",
  );
});

test("the preview follows the actual launch through two descending dots without revealing contact or landing", () => {
  const g = new Stretch({ random: seeded(3) }),
    p = launchPlan(g);
  g.move(g.anchor.x - g.cameraX, g.anchor.y);
  g.press();
  g.move(g.anchor.x - g.cameraX + p.x, g.anchor.y + p.y);
  const drawn = { ...g.player },
    dots = structuredClone(g.preview);
  assert.ok(dots.length >= 3);
  const apex = dots.reduce(
    (best, dot, i) => (dot.y < dots[best].y ? i : best),
    0,
  );
  assert.equal(dots.length - 1 - apex, 2);
  assert.ok(dots.at(-1).time > 0.6);
  assert.ok(dots.at(-2).y < dots.at(-1).y);
  assert.equal("previewContact" in g, false);
  g.release();
  close(g.body.x, drawn.x);
  close(g.body.y, drawn.y);
  let index = 0;
  while (index < dots.length) {
    g.step(1 / 120);
    if (Math.abs(g.elapsed - dots[index].time) < 1e-6) {
      close(g.body.x, dots[index].x);
      close(g.body.y, dots[index].y);
      index++;
    }
  }
  assert.equal(g.contacts.length, 0);
  assert.equal(g.score, 0, "touching or bouncing is not yet a stable landing");
});

test("preview length adapts to the pull and always includes exactly two visible descending samples in free flight", () => {
  const endings = [];
  for (const pull of [
    { x: -30, y: 30 },
    { x: -60, y: 70 },
    { x: -70, y: 110 },
    { x: 0, y: 140 },
  ]) {
    const g = new Stretch({ random: seeded(3) });
    g.buildings = [];
    g.anchor = { x: 200, y: 350 };
    g.player = { ...g.anchor };
    g.move(200, 350);
    g.press();
    g.move(200 + pull.x, 350 + pull.y);
    const dots = g.preview,
      apex = dots.reduce(
        (best, dot, i) => (dot.y < dots[best].y ? i : best),
        0,
      );
    assert.ok(apex > 0);
    assert.equal(dots.length - 1 - apex, 2);
    assert.ok(
      dots[apex + 1].y > dots[apex].y && dots[apex + 2].y > dots[apex + 1].y,
    );
    endings.push(dots.at(-1).time);
  }
  assert.ok(endings[3] > endings[0] * 2);
  assert.ok(
    endings[3] > 0.9,
    "the old 0.42s cap no longer truncates a high arc",
  );
});

test("horizontal and downward previews stop after two points instead of showing the whole fall", () => {
  for (const y of [0, -60]) {
    const g = new Stretch();
    g.buildings = [];
    g.move(g.anchor.x, g.anchor.y);
    g.press();
    g.move(g.anchor.x - 60, g.anchor.y + y);
    const start = g.launchBody();
    assert.equal(g.preview.length, 2);
    assert.ok(g.preview[0].y > start.y && g.preview[1].y > g.preview[0].y);
  }
});

test("a solid obstacle truncates the preview before contact even if it precedes the apex", () => {
  const g = new Stretch();
  g.buildings = [{ id: 1, x: 250, y: 0, w: 20, h: 540 }];
  g.anchor = { x: 200, y: 350 };
  g.player = { ...g.anchor };
  g.move(200, 350);
  g.press();
  g.move(130, 460);
  const body = g.launchBody();
  let contactAt = null;
  for (let i = 0; i < 120 && contactAt === null; i++)
    if (stepRoofBody(body, g.buildings, 1 / 120).some((p) => p.impulse > 5))
      contactAt = (i + 1) / 120;
  assert.ok(contactAt !== null);
  assert.ok(g.preview.length > 0 && g.preview.at(-1).time < contactAt);
  assert.ok(g.preview.every((p, i, a) => !i || p.y < a[i - 1].y));
  assert.equal("previewContact" in g, false);
});

test("the grab cursor matches the real drag target, stays grabbing during a pull and resets in flight", () => {
  const g = new Stretch({ random: seeded(3) });
  g.move(700, 100);
  assert.equal(g.pointerCursor, "default");
  g.press();
  assert.equal(
    g.input.down,
    false,
    "the instruction must point at the real interactive area",
  );
  g.move(g.anchor.x, g.anchor.y);
  assert.equal(g.pointerCursor, "grab");
  g.press();
  assert.equal(g.pointerCursor, "grabbing");
  g.move(g.anchor.x - 100, g.anchor.y + 80);
  assert.equal(g.pointerCursor, "grabbing");
  assert.match(g.hint, /Solte/);
  g.release();
  assert.equal(g.pointerCursor, "default");
  assert.equal(g.phase, "flying");
});

test("buildings stay solid to the ground, hazards occupy only gaps and subsequent targets advance right at different heights", () => {
  const g = new Stretch({ random: seeded(3) });
  let oldTarget = g.target,
    lastScore = 0;
  const heights = [g.support.y, g.target.y];
  while (!g.finished) {
    bots.stretch(g);
    g.step(1 / 60);
    for (const b of g.buildings) close(b.y + b.h, g.groundY);
    assert.ok(
      g.floor.every((p) =>
        g.buildings.every(
          (b) =>
            p.x + (FLOOR_INK.right * p.size) / 64 <= b.x ||
            p.x + (FLOOR_INK.left * p.size) / 64 >= b.x + b.w,
        ),
      ),
    );
    if (g.score > lastScore && !g.finished) {
      assert.ok(g.target.x > oldTarget.x + oldTarget.w);
      assert.notEqual(g.target.y, oldTarget.y);
      oldTarget = g.target;
      lastScore = g.score;
      heights.push(g.target.y);
    }
  }
  assert.equal(g.reason, "survived");
  assert.ok(heights[2] > heights[1] && heights[3] < heights[2]);
  assert.ok(g.cameraX > 700);
});

test("landings remain possible with mouse-only input after camera scrolling and at slow frame rates", () => {
  for (const hz of [20, 60])
    for (let seed = 1; seed <= 8; seed++) {
      const g = new Stretch({ random: seeded(seed) });
      while (!g.finished) {
        bots.stretch(g);
        g.step(1 / hz);
      }
      assert.equal(g.reason, "survived", `${hz}fps, seed ${seed}`);
      assert.equal(g.score, 5);
      assert.ok(g.cameraX > 600);
      assert.ok(roofSupport(g.body, g.buildings));
      assert.ok(roofEquilibrium(g.body, g.buildings));
    }
});

test("the course ends farther away on a wider final building, with a fixed arrival flag", () => {
  for (const seed of [1, 5, 9]) {
    const g = new Stretch({ random: seeded(seed) });
    assert.equal(g.goal, 5);
    assert.equal(g.buildings.length, 6);
    assert.equal(g.finish.id, g.goal);
    assert.equal(g.finish.final, true);
    assert.ok(g.courseLength >= 1800);
    assert.ok(
      g.finish.w > Math.max(...g.buildings.slice(1, -1).map((b) => b.w)),
    );
    const centers = g.buildings.map((b) => b.x + b.w / 2);
    assert.ok(centers.at(-1) - centers.at(-2) >= 440);
    const labels = [],
      rects = [];
    g.cameraX = g.finish.x - 500;
    g.drawBuilding(
      { rect: (...v) => rects.push(v), line() {}, text: (t) => labels.push(t) },
      g.finish,
    );
    assert.ok(labels.includes("CHEGADA"));
    assert.equal(rects.filter((r) => r[2] === 8 && r[3] === 8).length, 12);
  }
});

test("gap hazards fill the edges and interior of each gap using the visible sprite width", () => {
  const g = new Stretch({ random: seeded(3) });
  for (let i = 1; i < g.buildings.length; i++) {
    const left = g.buildings[i - 1].x + g.buildings[i - 1].w,
      right = g.buildings[i].x,
      bounds = g.allFloor
        .filter((p) => p.x > left && p.x < right)
        .map((p) => ({
          left: p.x + (FLOOR_INK.left * p.size) / 64,
          right: p.x + (FLOOR_INK.right * p.size) / 64,
        }));
    assert.ok(bounds.length >= 5);
    assert.ok(bounds[0].left >= left && bounds[0].left - left < 4);
    assert.ok(bounds.at(-1).right <= right && right - bounds.at(-1).right < 4);
    for (let n = 1; n < bounds.length; n++)
      assert.ok(bounds[n].left - bounds[n - 1].right < 7);
  }
});

test("an unsupported tilted pose keeps rolling back under gravity instead of being frozen as a landing", () => {
  for (const hz of [20, 60, 120]) {
    const g = new Stretch({ gapHazards: false }),
      angle = -1.05;
    g.body = makePlayer(
      g.target.x + g.target.w / 2,
      g.target.y - playerExtents(angle).bottom,
      angle,
    );
    g.player = { x: g.body.x, y: g.body.y };
    g.phase = "flying";
    g.clockStarted = true;
    assert.ok(roofSupport(g.body, g.buildings));
    assert.equal(roofEquilibrium(g.body, g.buildings), null);
    for (let t = 0; t < 0.5; t += 1 / hz) g.step(1 / hz);
    assert.equal(
      g.score,
      0,
      "low speed in a tilted frame cannot score a landing",
    );
    assert.ok(g.body.angle > angle + 0.025, `gravity tips it back at ${hz}fps`);
  }
});

test("horizontal launch is gentler while vertical reach and bounce remain physical", () => {
  const g = new Stretch();
  g.pull = { x: -80, y: 100 };
  const b = g.launchBody();
  assert.ok(b.vx < 80 * 5.7 && b.vx > 80 * 5);
  close(b.vy, -570);
});
