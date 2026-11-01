import test from "node:test";
import assert from "node:assert/strict";
import { PLAYFIELD } from "../src/playfield.js";
import { PeachSimulation, WIDTH, HEIGHT } from "../src/engine.js";
import { challenges } from "../src/games/index.js";
import { W, H, seeded, distance } from "../src/games/kit.js";
import { edgePoint, incoming } from "../src/games/mechanics.js";
import { driveBat } from "../src/games/bat-physics.js";

const edge = (p) => p.x === 0 || p.x === W || p.y === 0 || p.y === H;
const recorder = () => {
  const shapes = [];
  const ctx = new Proxy({}, { get: (o, k) => o[k] ?? (() => {}) });
  const v = { ctx, shapes };
  for (const kind of [
    "rect",
    "line",
    "circle",
    "text",
    "enemy",
    "enemyPiece",
    "player",
    "bar",
  ])
    v[kind] = (...args) => shapes.push({ kind, args });
  return v;
};

test("all fourteen games use the canvas coordinate system independently of the DOM header", () => {
  assert.deepEqual(
    [W, H, WIDTH, HEIGHT],
    [PLAYFIELD.width, PLAYFIELD.height, W, H],
  );
  assert.equal(Object.keys(challenges).length + 1, 14);
  for (const [id, Game] of Object.entries(challenges)) {
    const g = new Game({ random: seeded(3) });
    for (const p of [
      { x: 0, y: 0 },
      { x: W, y: H },
      { x: W / 2, y: 5 },
    ]) {
      g.move(p.x, p.y);
      assert.deepEqual(
        { x: g.input.x, y: g.input.y },
        p,
        `${id}: full pointer range`,
      );
    }
  }
  const arena = new PeachSimulation();
  arena.move(0, 0);
  assert.deepEqual(arena.target, { x: 24, y: 24 });
  arena.move(W, H);
  assert.deepEqual(arena.target, { x: W - 24, y: H - 24 });
});

test("rain starts entirely above the field and crosses its true top progressively", () => {
  const g = new challenges.rain({ random: seeded(3), hits: () => false });
  g.next = Infinity;
  const row = g.spawnRow(),
    initial = row.parts.map((p) => p.y);
  for (const b of row.parts)
    assert.ok(
      b.y + Math.hypot(b.size * 0.8, b.size) / 2 < 0,
      "even rotated drawing starts offscreen",
    );
  g.update(0.05);
  assert.deepEqual(
    row.parts.map((p) => p.y),
    initial,
    "birth frame does not jump into the field",
  );
  let crossed = false;
  for (let i = 0; i < 120 && !crossed; i++) {
    const before = row.parts.map((p) => p.y),
      speed = g.speed;
    g.step(1 / 120);
    row.parts.forEach((p, i) =>
      assert.ok(p.y - before[i] <= speed / 120 + 0.01),
    );
    crossed = row.parts.some((p) => p.y >= 0);
  }
  assert.ok(
    crossed && row.parts.some((p) => p.y < 10),
    "the row enters through y=0",
  );
  assert.equal(g.player.y, 458);
});

test("central mechanics share the geometric center and distance-normalized entries reach it from real edges", () => {
  for (const id of ["paddle", "shelter", "slash", "thunder", "juggle"]) {
    const g = new challenges[id]();
    assert.deepEqual(g.player, { x: W / 2, y: H / 2 }, id);
  }
  const g = new challenges.orbit();
  assert.deepEqual(g.center, { x: W / 2, y: H / 2 });
  assert.ok(Math.abs(distance(g.player, g.center) - g.radius) < 1e-8);
  const methods = {
    orbit: "spawnAttack",
    paddle: "spawnAttack",
    shelter: "spawnDrop",
    slash: "spawnTarget",
  };
  for (const [id, method] of Object.entries(methods)) {
    const game = new challenges[id]();
    const born = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((a) =>
      id === "orbit"
        ? game[method]({ x: a < 0 ? 0 : 960, y: 270 }, a)
        : game[method](a),
    );
    assert.ok(
      born.every((b) => edge(b.source)),
      id,
    );
    // Shield serializes deadlines, so isolate new games for the equal-flight check.
    const times = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((a) => {
      const one = new challenges[id]();
      return (
        id === "orbit"
          ? one[method]({ x: a < 0 ? 0 : 960, y: 270 }, a)
          : one[method](a)
      ).travelTime;
    });
    assert.ok(
      times.every((t) => Math.abs(t - times[0]) < 1e-8),
      id,
    );
  }
  for (let i = 0; i < 32; i++) {
    const p = edgePoint(g, (i * Math.PI) / 16);
    assert.ok(edge(p));
    assert.ok(edge(incoming(g, { angle: (i * Math.PI) / 16 })));
  }
});

test("jet and gravity columns fill the vertical field with symmetric physical margins", () => {
  for (const id of ["gravity", "jet"]) {
    const g = new challenges[id]({ hits: () => false, bodyHit: () => false });
    assert.deepEqual(g.track, { top: 0, bottom: H }, id);
    assert.equal(g.limits.top, H - g.limits.bottom);
    assert.ok(g.limits.top <= 36, "margin is for the character, not a header");
    const v = recorder();
    g.draw(v);
    const rails = v.shapes.filter(
      (s) => s.kind === "line" && s.args[0].y === s.args[1].y,
    );
    assert.ok(rails.some((s) => s.args[0].y === 0 && s.args[1].x === W));
    assert.ok(rails.some((s) => s.args[0].y === H && s.args[1].x === W));
  }
});

test("upper-band platforms are drawn as soon as they enter, while offscreen platforms stay culled", () => {
  const g = new challenges.climb();
  g.camera = 0;
  g.platforms = [-20, -4, 0, 30, 60, 90].map((y, i) => ({
    x: 200,
    y,
    w: 90,
    i: i + 1,
    used: false,
  }));
  const v = recorder();
  g.draw(v);
  assert.deepEqual(
    v.shapes.filter((s) => s.kind === "rect").map((s) => s.args[1]),
    [-4, 0, 30, 60, 90],
  );
});

test("drawing, cutting, shielding and the bat can reach the former header band", () => {
  for (const id of ["shelter", "slash"]) {
    const g = new challenges[id]();
    g.move(200, 5);
    g.press();
    g.move(300, 5);
    g.release();
    const segments = g.lines ?? g.trail;
    assert.ok(
      segments.length && segments.every((l) => l.a.y === 5 && l.b.y === 5),
      id,
    );
  }
  const g = new challenges.rhythm();
  g.move(200, 5);
  for (let i = 0; i < 120; i++) driveBat(g.bat, g.input, 99, 1 / 120);
  assert.ok(Math.abs(g.bat.aimY - 5) < 1e-7);
  const thunder = new challenges.thunder({ hits: () => false });
  thunder.move(100, 0);
  for (let i = 0; i < 120; i++) thunder.step(1 / 120);
  assert.ok(thunder.player.y < 37, "only the character-sized boundary remains");
});
