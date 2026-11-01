import test from "node:test";
import assert from "node:assert/strict";
import { createAlphaMask, orientedSpriteHitsCircle } from "../src/collision.js";
import { masksOverlap } from "../src/mask-overlap.js";
import { playerAlpha } from "../src/games/player-alpha.js";
import { projectileAlpha } from "../src/games/blade-geometry.js";
const solid = (w, h) =>
  createAlphaMask(
    { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) },
    w,
    h,
  );
test("opaque cells collide without a halo, and unloaded masks cannot hit", () => {
  const m = solid(2, 2),
    p = { x: 0, y: 0 };
  assert.equal(masksOverlap(m, p, m, { x: 2.001, y: 0 }), false);
  assert.equal(masksOverlap(m, p, m, { x: 1.999, y: 0 }), true);
  assert.equal(masksOverlap(null, p, m, p), false);
});
test("transparent corners of overlapping sprite rectangles never become walls", () => {
  const data = new Uint8ClampedArray(16 * 4);
  data[(1 * 4 + 1) * 4 + 3] = 255;
  const m = createAlphaMask({ width: 4, height: 4, data }, 4, 4),
    small = solid(0.2, 0.2);
  assert.equal(
    masksOverlap(m, { x: 0, y: 0 }, small, { x: -1.5, y: -1.5 }),
    false,
  );
  assert.equal(
    masksOverlap(m, { x: 0, y: 0 }, small, { x: -0.5, y: -0.5 }),
    true,
  );
});
test("crossing pixel footprints collide even when neither pixel center is inside the other", () => {
  const m = solid(20, 1);
  assert.equal(
    masksOverlap(m, { x: 0, y: 0 }, m, { x: 9, y: 9, angle: Math.PI / 2 }),
    true,
  );
  assert.equal(
    masksOverlap(m, { x: 0, y: 0 }, m, { x: 11, y: 9, angle: Math.PI / 2 }),
    false,
  );
});
test("contact follows scale, rotation and the renderer's world-Y reflection", () => {
  const data = new Uint8ClampedArray(16 * 4);
  data[(1 * 4 + 3) * 4 + 3] = 255;
  const m = createAlphaMask({ width: 4, height: 4, data }, 4, 4),
    dot = solid(0.1, 0.1);
  for (const angle of [0, 0.6, 1.7])
    for (const flipY of [false, true])
      for (const size of [4, 8]) {
        const p = { x: 30, y: 20, size, angle, flipY },
          k = size / 4,
          c = Math.cos(angle),
          s = Math.sin(angle),
          q = {
            x: p.x + k * (c * 1.5 + s * 0.5),
            y: p.y + k * (s * 1.5 - c * 0.5) * (flipY ? -1 : 1),
          };
        assert.ok(masksOverlap(m, p, dot, q));
        assert.equal(
          masksOverlap(m, p, dot, { x: 2 * p.x - q.x, y: 2 * p.y - q.y }),
          false,
        );
      }
});
test("the actual character's visible cheek counts, while empty corners remain harmless", () => {
  const player = { x: 0, y: 0, size: 76, angle: 0 },
    source = { x: 50, y: 25, size: 54, rotation: Math.PI * 1.25, flipY: true };
  assert.equal(
    orientedSpriteHitsCircle(
      projectileAlpha,
      source,
      source.rotation,
      player,
      19,
    ),
    false,
  );
  assert.equal(
    masksOverlap(projectileAlpha, source, playerAlpha, player),
    true,
  );
  assert.equal(
    masksOverlap(
      projectileAlpha,
      { ...source, x: 35, y: 40 },
      playerAlpha,
      player,
    ),
    false,
  );
});
test("real mask overlap is symmetric across tilted flight poses", () => {
  for (const angle of [-0.22, 0, 0.22])
    for (const x of [-50, -30, 0, 30, 50])
      for (const y of [-40, -20, 20, 40]) {
        const b = { x, y, size: 54, rotation: Math.PI * 1.25, flipY: true },
          p = { x: 0, y: 0, size: 76, angle };
        assert.equal(
          masksOverlap(projectileAlpha, b, playerAlpha, p),
          masksOverlap(playerAlpha, p, projectileAlpha, b),
        );
      }
});
