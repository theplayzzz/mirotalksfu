import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAlphaMask,
  alphaMaskHitsCircle,
  orientedSpriteHitsCircle,
} from "../src/collision.js";

function sampleMask() {
  const width = 10,
    height = 10;
  const data = new Uint8ClampedArray(width * height * 4);
  // One small visible shape, surrounded by a fully transparent square.
  for (let y = 3; y <= 6; y++) {
    for (let x = 5; x <= 7; x++) data[(y * width + x) * 4 + 3] = 255;
  }
  return createAlphaMask({ width, height, data }, 20, 20);
}

test("transparent image corners and empty interior do not collide", () => {
  const mask = sampleMask();
  const source = { x: 100, y: 100 };
  assert.equal(
    alphaMaskHitsCircle(mask, source, 0, { x: 91, y: 91 }, 0.4),
    false,
  );
  assert.equal(
    alphaMaskHitsCircle(mask, source, 0, { x: 95, y: 101 }, 0.4),
    false,
  );
  assert.equal(
    alphaMaskHitsCircle(mask, source, 0, { x: 103, y: 101 }, 0.4),
    true,
  );
});

test("the hit shape follows rendering rotation and translation", () => {
  const mask = sampleMask();
  const source = { x: 200, y: 300 };
  for (const angle of [0, Math.PI / 2, Math.PI, 1.13]) {
    const solid = {
      x: source.x + 3 * Math.cos(angle) - Math.sin(angle),
      y: source.y + 3 * Math.sin(angle) + Math.cos(angle),
    };
    const empty = {
      x: source.x - 9 * Math.cos(angle) + 9 * Math.sin(angle),
      y: source.y - 9 * Math.sin(angle) - 9 * Math.cos(angle),
    };
    assert.equal(alphaMaskHitsCircle(mask, source, angle, solid, 0.4), true);
    assert.equal(alphaMaskHitsCircle(mask, source, angle, empty, 0.4), false);
  }
});

test("an unloaded sprite cannot cause an invisible collision", () => {
  assert.equal(
    alphaMaskHitsCircle(null, { x: 0, y: 0 }, 0, { x: 0, y: 0 }, 24),
    false,
  );
});
test("upright, reflected and resized sprites keep the alpha hitbox aligned", () => {
  const data = new Uint8ClampedArray(10 * 10 * 4);
  data[(3 * 10 + 6) * 4 + 3] = 255;
  const mask = createAlphaMask({ width: 10, height: 10, data }, 20, 20),
    source = { x: 100, y: 100, size: 108, flipY: true },
    angle = 0.7;
  const dx = 3 * Math.cos(angle) + 3 * Math.sin(angle),
    dy = 3 * Math.sin(angle) - 3 * Math.cos(angle);
  assert.equal(
    orientedSpriteHitsCircle(
      mask,
      source,
      angle,
      { x: 100 + dx * 2, y: 100 - dy * 2 },
      0.3,
    ),
    true,
  );
  assert.equal(
    orientedSpriteHitsCircle(
      mask,
      source,
      angle,
      { x: 100 - dx * 2, y: 100 + dy * 2 },
      0.3,
    ),
    false,
  );
});
