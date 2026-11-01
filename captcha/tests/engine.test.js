import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PeachSimulation,
  MAX_KIBES,
  INITIAL_PROJECTILE_COUNT,
  WIDTH,
  HEIGHT,
  projectileRotation,
} from "../src/engine.js";

test("bounces multiply kibes, with a fixed cap", () => {
  const game = new PeachSimulation({ duration: 40, random: () => 0.3 });
  game.move(60, 60);
  for (let i = 0; i < 1200; i++) game.step(1 / 60);
  assert.ok(game.bounces > 0);
  assert.ok(game.kibes.length > INITIAL_PROJECTILE_COUNT);
  assert.ok(game.kibes.length <= MAX_KIBES);
});

test("survival always ends, including a player who constantly teleports away", () => {
  for (const duration of [8, 15, 25, 40]) {
    const game = new PeachSimulation({ duration });
    for (let i = 0; i < (duration + 1) * 120 && !game.finished; i++) {
      game.move(i % 2 ? 40 : WIDTH - 40, i % 3 ? 40 : HEIGHT - 40);
      game.step(1 / 120);
    }
    assert.equal(game.finished, true);
    assert.ok(game.elapsed <= duration + 0.02);
    assert.ok(["impact", "survived"].includes(game.reason));
  }
});

test("defaults to 40 seconds and clamps longer rounds to 40", () => {
  assert.equal(new PeachSimulation().duration, 40);
  assert.equal(new PeachSimulation({ duration: 100 }).duration, 40);
});

test("starts slowly and accelerates continuously to a very fast final 40 seconds", () => {
  const game = new PeachSimulation({ random: () => 0.3, hitTest: () => false });
  game.move(60, 60);
  const initial = Math.hypot(game.kibes[0].vx, game.kibes[0].vy);
  assert.ok(initial < 150);
  let previous = initial;
  while (!game.finished) {
    game.step(1 / 60);
    const current = Math.hypot(game.kibes[0].vx, game.kibes[0].vy);
    assert.ok(current >= previous - 1e-9);
    assert.ok(game.kibes.length <= MAX_KIBES);
    previous = current;
  }
  assert.ok(Math.abs(previous / initial - 9) < 0.001);
  assert.equal(game.remaining, 0);
  assert.equal(game.reason, "survived");
});

test("starts with two projectiles coming from opposite sides", () => {
  const game = new PeachSimulation({ random: () => 0.3 });
  assert.equal(game.kibes.length, 2);
  const [left, right] = game.kibes;
  assert.ok(
    left.x < WIDTH / 2 && left.y < HEIGHT / 2 && left.vx > 0 && left.vy > 0,
  );
  assert.ok(
    right.x > WIDTH / 2 && right.y > HEIGHT / 2 && right.vx < 0 && right.vy < 0,
  );
  assert.equal(left.duplicationsLeft, 8);
  assert.equal(right.duplicationsLeft, 8);
});

test("both originals duplicate independently on their first eight wall hits, and copies never duplicate", () => {
  const game = new PeachSimulation({ hitTest: () => false });
  const originals = game.kibes.slice();
  for (const [index, projectile] of originals.entries()) {
    for (let i = 0; i < 12; i++) {
      projectile.x = WIDTH - 13;
      projectile.y = 60;
      projectile.vx = 1;
      projectile.vy = 0;
      game.step(1 / 120);
      assert.equal(
        game.kibes.length,
        INITIAL_PROJECTILE_COUNT + index * 8 + Math.min(i + 1, 8),
      );
    }
  }
  for (const copy of game.kibes.slice(INITIAL_PROJECTILE_COUNT)) {
    assert.equal(copy.duplicationsLeft, 0);
    copy.x = WIDTH - 13;
    copy.vx = 1;
    copy.vy = 0;
  }
  game.step(1 / 120);
  assert.equal(
    game.kibes.length,
    18,
    "copies cannot create a second generation",
  );
  assert.equal(game.duplications, 16);
});

test("each round and rebound vary, while every bounced projectile stays inside and keeps its speed", () => {
  const slowRandom = new PeachSimulation({
    random: () => 0.1,
    hitTest: () => false,
  });
  const highRandom = new PeachSimulation({
    random: () => 0.9,
    hitTest: () => false,
  });
  assert.notEqual(slowRandom.kibes[0].vy, highRandom.kibes[0].vy);
  for (const game of [slowRandom, highRandom]) {
    const initial = game.kibes[0];
    initial.x = WIDTH - 13;
    initial.y = 60;
    initial.vx = 1;
    initial.vy = 0;
    game.step(1 / 120);
    for (const projectile of game.kibes) {
      assert.ok(projectile.vx < 0, "right-wall ricochets point back inside");
      assert.ok(
        Math.abs(Math.hypot(projectile.vx, projectile.vy) - game.speed) < 1e-8,
      );
    }
  }
  assert.notEqual(slowRandom.kibes[0].vy, highRandom.kibes[0].vy);
});

test("an injected shape test controls hits instead of the rectangular bounds", () => {
  const game = new PeachSimulation({ hitTest: () => false });
  game.elapsed = 3;
  Object.assign(game.kibes[0], game.player, { vx: 0, vy: 0 });
  game.step(1 / 120);
  assert.equal(
    game.finished,
    false,
    "overlapping transparent bounds do not cause a hit",
  );
  game.hitTest = () => true;
  game.step(1 / 120);
  assert.equal(game.reason, "impact");
});

test("the artwork tip points at the peach in all directions, independently of movement", () => {
  const source = { x: 100, y: 100 };
  for (const target of [
    { x: 200, y: 100 },
    { x: 100, y: 200 },
    { x: 0, y: 100 },
    { x: 100, y: 0 },
    { x: 200, y: 200 },
    { x: 0, y: 0 },
  ]) {
    const angle = projectileRotation(source, target) - Math.PI / 4;
    const length = Math.hypot(target.x - source.x, target.y - source.y);
    assert.ok(
      Math.abs(Math.cos(angle) - (target.x - source.x) / length) < 1e-9,
    );
    assert.ok(
      Math.abs(Math.sin(angle) - (target.y - source.y) / length) < 1e-9,
    );
  }
});

test("collision reports a loss after the warm-up", () => {
  const game = new PeachSimulation();
  game.elapsed = 3;
  game.kibes[0] = { ...game.player, vx: 0, vy: 0, splitAt: 10 };
  game.step(1 / 60);
  assert.equal(game.finished, true);
  assert.equal(game.reason, "impact");
});

test("movement stays inside the arena and finished simulations stop updating", () => {
  const game = new PeachSimulation();
  game.move(-100, 10000);
  assert.ok(game.target.x > 0 && game.target.y < HEIGHT);
  game.finish("impact");
  game.step(1);
  assert.equal(game.elapsed, 0);
});
