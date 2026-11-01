import test from "node:test";
import assert from "node:assert/strict";
import { Web } from "../src/games/web-game.js";
import { buildWebCourse, WEB_PATTERNS } from "../src/games/web-course.js";
import { raySprite, attachWeb } from "../src/games/web-physics.js";
import {
  projectileAlpha,
  spriteWorldPoint,
  spriteLocalPoint,
} from "../src/games/blade-geometry.js";

const advance = (g, seconds) => {
  for (let t = 0; t < seconds && !g.finished; t += 1 / 240) g.step(1 / 240);
};

test("the course contains distinct upper, lower, central, shifted and floating passages with no floor hazards", () => {
  const course = buildWebCourse();
  assert.equal(course.gates.length, 8);
  assert.deepEqual(
    new Set(course.gates.map((g) => g.kind)),
    new Set(WEB_PATTERNS.map((p) => p.kind)),
  );
  for (const gate of course.gates) {
    assert.ok(gate.parts.length);
    assert.ok(gate.spans.every((s) => s.y >= 12 && s.y + s.h <= 514));
    assert.ok(
      gate.spans.every(
        (s) => gate.safeY + 34 < s.y || gate.safeY - 34 > s.y + s.h,
      ),
      gate.kind,
    );
  }
  const floating = course.gates.find((g) => g.kind === "floating");
  assert.ok(
    floating.spans[0].y > 100 &&
      floating.spans[0].y + floating.spans[0].h < 420,
  );
  assert.equal(new Web().floor.length, 0);
  assert.ok(
    course.ceiling.x < 0 &&
      course.ceiling.x + course.ceiling.w > course.finish.x + 960,
  );
  assert.ok(course.finish.lineX > course.gates.at(-1).x + 400);
});

test("the continuous ceiling accepts aim across former block gaps and after scrolling", () => {
  const g = new Web();
  for (const camera of [0, 800, 2000]) {
    g.cameraX = camera;
    g.kibes = [];
    for (const screenX of [20, 205, 420, 650, 920]) {
      g.player = { x: camera + screenX, y: 220, vx: 0, vy: 0 };
      g.move(screenX, 0);
      const hit = g.aim().hit;
      assert.equal(hit.kind, "ceiling");
      assert.equal(hit.y, 12);
      assert.equal(hit.x, camera + screenX);
    }
  }
});

test("sprite rays skip transparent cells and return the first opaque pixel, with scale, rotation and reflection", () => {
  const mask = {
    width: 4,
    height: 4,
    worldWidth: 4,
    worldHeight: 4,
    alpha: new Uint8Array([0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
  };
  for (const size of [4, 12])
    for (const rotation of [0, 0.7, Math.PI])
      for (const flipY of [false, true]) {
        const sprite = { x: 230, y: 180, size, rotation, flipY },
          origin = spriteWorldPoint({ x: -5, y: -0.5 }, sprite, rotation, mask),
          target = spriteWorldPoint({ x: 5, y: -0.5 }, sprite, rotation, mask),
          length = Math.hypot(target.x - origin.x, target.y - origin.y),
          direction = {
            x: (target.x - origin.x) / length,
            y: (target.y - origin.y) / length,
          },
          hit = raySprite(origin, direction, sprite, mask),
          local = spriteLocalPoint(hit, sprite, rotation, mask);
        assert.ok(Math.abs(local.x + 1) < 1e-5);
        assert.ok(Math.abs(local.y + 0.5) < 1e-5);
        assert.equal(
          raySprite(origin, direction, sprite, mask, hit.distance - 0.01),
          null,
        );
        const throughGap = spriteWorldPoint(
          { x: -5, y: 0.5 },
          sprite,
          rotation,
          mask,
        );
        assert.equal(raySprite(throughGap, direction, sprite, mask), null);
      }
});

test("an opaque obstacle occludes the ceiling and accepts a web at its actual drawn surface", () => {
  const g = new Web(),
    obstacle = g.gates[0].parts.at(-1);
  g.player = { x: obstacle.x - 180, y: obstacle.y + 110, vx: 0, vy: 0 };
  g.move(obstacle.x, obstacle.y);
  const hit = g.aim().hit;
  assert.equal(hit.kind, "obstacle");
  assert.equal(hit.obstacleId, obstacle.id);
  assert.ok(raySprite(g.player, g.aim().direction, obstacle, projectileAlpha));
  g.press();
  advance(g, 0.1);
  assert.equal(g.rope?.obstacleId, obstacle.id);
  assert.equal(g.attachLog[0].kind, "obstacle");
  assert.ok(g.rope.length > 80);
});

test("releasing and firing again at the same instant never discards or reuses the previous shot", () => {
  const g = new Web();
  g.move(280, 0);
  g.press();
  const oldId = g.shot.id;
  advance(g, 0.02);
  g.release();
  g.move(230, 0);
  g.press();
  assert.equal(g.shot.id, oldId + 1);
  advance(g, 0.2);
  assert.equal(g.attachments, 1);
  assert.equal(g.attachLog[0].shotId, oldId + 1);
  const at = g.elapsed;
  g.release();
  g.move(g.player.x + 110, 0);
  g.press();
  assert.equal(g.elapsed, at);
  assert.equal(g.shot.id, oldId + 2);
  advance(g, 0.2);
  assert.equal(g.attachments, 2);
  assert.equal(g.attachLog[1].shotId, oldId + 2);
});

test("nearby ceiling anchors work and side/below anchors do not reel down into a hazard", () => {
  const g = new Web();
  g.player = { x: 270, y: 60, vx: 0, vy: 0 };
  g.move(270, 0);
  g.press();
  advance(g, 0.025);
  assert.equal(g.attachments, 1);
  for (const anchor of [
    { x: 450, y: 330 },
    { x: 450, y: 390 },
  ]) {
    const rope = attachWeb({ x: 300, y: 330 }, anchor);
    assert.equal(rope.reelAmount, 0);
  }
});
