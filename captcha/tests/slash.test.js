import test from "node:test";
import assert from "node:assert/strict";
import { createAlphaMask, orientedSpriteHitsCircle } from "../src/collision.js";
import {
  projectileAlpha,
  bladeMaskHit,
  sliceSprite,
} from "../src/games/blade-geometry.js";
import { Slash, SLASH_TARGET_SIZE } from "../src/games/slash-game.js";
import { seeded } from "../src/games/kit.js";
import { bots, tap } from "./strategies.js";
const realHit = (t, p, r) =>
  orientedSpriteHitsCircle(projectileAlpha, t, t.rotation, p, r);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const advance = (g, t) => {
  for (let i = 0; i < t * 120 && !g.finished; i++) g.step(1 / 120);
};
const target = (x = 260, y = 260) => ({
  x,
  y,
  vx: 0,
  vy: 0,
  size: SLASH_TARGET_SIZE,
  rotation: 0,
  id: 1,
});

test("continuous blade intersection hits a tiny opaque cell and ignores transparent image areas", () => {
  const data = new Uint8ClampedArray(20 * 20 * 4);
  data[(4 * 20 + 14) * 4 + 3] = 255;
  const mask = createAlphaMask({ width: 20, height: 20, data }, 20, 20),
    body = { x: 0, y: 0, size: 20 };
  assert.ok(
    bladeMaskHit(mask, body, 0, {
      a: { x: -100, y: -5.5 },
      b: { x: 100, y: -5.5 },
      radius: 0.1,
    }),
  );
  assert.equal(
    bladeMaskHit(mask, body, 0, {
      a: { x: -9, y: -9 },
      b: { x: -8, y: -9 },
      radius: 0.1,
    }),
    null,
  );
  assert.equal(
    bladeMaskHit(mask, body, 0, {
      a: { x: -2, y: 0 },
      b: { x: 2, y: 0 },
      radius: 0.1,
    }),
    null,
  );
});

test("the blade follows the PNG's exact rotation, size and reflection", () => {
  const mask = projectileAlpha,
    index = mask.alpha.findIndex((v) => v),
    solid = {
      x:
        (((index % mask.width) + 0.5) * mask.worldWidth) / mask.width -
        mask.worldWidth / 2,
      y:
        ((Math.floor(index / mask.width) + 0.5) * mask.worldHeight) /
          mask.height -
        mask.worldHeight / 2,
    };
  for (const angle of [0, 0.8, Math.PI * 1.25])
    for (const flipY of [false, true])
      for (const size of [54, 108]) {
        const body = { x: 300, y: 240, size, flipY },
          scale = size / 54,
          c = Math.cos(angle),
          s = Math.sin(angle);
        const world = (p) => ({
          x: body.x + (c * p.x - s * p.y) * scale,
          y: body.y + (s * p.x + c * p.y) * scale * (flipY ? -1 : 1),
        });
        const p = world(solid);
        assert.ok(
          bladeMaskHit(mask, body, angle, {
            a: { x: p.x - 0.2, y: p.y },
            b: { x: p.x + 0.2, y: p.y },
            radius: 0.1,
          }),
        );
        assert.equal(
          bladeMaskHit(mask, body, angle, {
            a: world({ x: -21, y: -26 }),
            b: world({ x: -20.5, y: -26 }),
            radius: 0.1,
          }),
          null,
        );
      }
});

test("relative sweeping catches an element crossing a fresh blade between frames", () => {
  const mask = createAlphaMask(
    { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) },
    1,
    1,
  );
  const before = { x: -10, y: 0, size: 1 },
    after = { x: 10, y: 0, size: 1 };
  const line = { a: { x: 0, y: -20 }, b: { x: 0, y: 20 }, radius: 0.2 };
  assert.equal(bladeMaskHit(mask, before, 0, line), null);
  assert.equal(bladeMaskHit(mask, after, 0, line), null);
  assert.ok(bladeMaskHit(mask, after, 0, line, before));
});

test("subpixel mouse motions accumulate into a real cut instead of being discarded", () => {
  const g = new Slash();
  g.next = Infinity;
  g.targets = [target()];
  g.move(220, 260);
  g.press();
  for (let i = 1; i <= 700; i++) g.move(220 + i * 0.1, 260);
  assert.equal(g.score, 1);
  assert.equal(g.cutCount, 1);
  assert.equal(g.fragments.length, 2);
  assert.ok(g.trail.at(-1).b.x > 289);
});

test("a moving target is sliced by a fresh stroke during the simulation update", () => {
  const mask = createAlphaMask(
    { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) },
    1,
    1,
  );
  const g = new Slash({
    sliceHit: (t, line, old = t) => bladeMaskHit(mask, t, 0, line, old),
    hits: () => false,
  });
  g.next = Infinity;
  g.targets = [{ x: 220, y: 170, vx: 0, vy: 6000, size: 1, rotation: 0 }];
  g.move(200, 200);
  g.press();
  g.move(240, 200);
  assert.equal(g.score, 0);
  g.step(0.01);
  assert.equal(g.score, 1);
  assert.equal(g.fragments.length, 2);
});

test("clicking does not cut and an expired or released trail cannot become a stationary barrier", () => {
  const g = new Slash({ hits: () => false });
  g.next = Infinity;
  tap(g, 220, 200);
  assert.equal(g.score, 0);
  g.move(200, 200);
  g.press();
  g.move(240, 200);
  g.release();
  g.targets = [target(220, 200)];
  g.step(0.01);
  assert.equal(g.score, 0);
  g.press();
  g.step(0.01);
  assert.equal(g.score, 0, "a new click does not reactivate the old stroke");
  g.targets = [];
  g.move(260, 200);
  advance(g, 0.1);
  g.targets = [target(250, 200)];
  g.step(0.01);
  assert.equal(g.score, 0, "holding still does not leave a cutting wall");
});

test("unlimited scribbling always reaches the mouse endpoint without releasing to recharge", () => {
  const g = new Slash();
  g.next = Infinity;
  g.targets = [target(280, 200)];
  g.move(200, 200);
  g.press();
  g.move(300, 200);
  close(g.trail.at(-1).b.x, 300);
  assert.equal(g.score, 1);
  for (let i = 0; i < 25; i++) {
    const x = i % 2 ? 30 : 930;
    g.targets = [{ ...target(480, 200), id: i + 2 }];
    g.move(x, 200);
    close(g.trail.at(-1).b.x, x);
  }
  assert.equal(g.score, 26);
  assert.equal(g.input.down, true);
  assert.equal("cutEnergy" in g, false);
  assert.equal("maxCutEnergy" in g, false);
  assert.match(g.hint, /não se esgota/);
});

test("the visible laser tail cannot cut far from the current mouse, even before it fades", () => {
  const mask = createAlphaMask(
      {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([255, 255, 255, 255]),
      },
      1,
      1,
    ),
    g = new Slash({
      sliceHit: (t, line, old = t) => bladeMaskHit(mask, t, 0, line, old),
      hits: () => false,
    });
  g.next = Infinity;
  g.move(100, 200);
  g.press();
  g.move(800, 200);
  const far = { ...target(700, 200), size: 1 },
    near = { ...target(790, 200), size: 1, id: 2 };
  g.targets = [far, near];
  g.step(1 / 120);
  assert.equal(g.score, 1);
  assert.equal(near.cut, true);
  assert.equal(far.cut, undefined);
  assert.ok(
    g.trail.some((l) => l.a.x <= 700 && l.b.x >= 700),
    "old trail is still visible",
  );
  assert.ok(g.activeCuts.every((l) => l.a.x >= 772));
});

test("local forgiveness expires while the visual laser remains and a new move cuts immediately", () => {
  const g = new Slash({ hits: () => false });
  g.next = Infinity;
  g.move(700, 200);
  g.press();
  g.move(800, 200);
  advance(g, 0.05);
  assert.ok(g.trail.length > 0 && g.activeCuts.length === 0);
  g.targets = [target(800, 200)];
  g.step(1 / 120);
  assert.equal(
    g.score,
    0,
    "holding a stationary mouse does not create a cutting shield",
  );
  g.move(801, 200);
  assert.equal(g.score, 1);
});

test("the broader cursor region cuts close passes without reaching distant elements", () => {
  const mask = createAlphaMask(
      {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([255, 255, 255, 255]),
      },
      1,
      1,
    ),
    g = new Slash({
      sliceHit: (t, line, old = t) => bladeMaskHit(mask, t, 0, line, old),
      hits: () => false,
    });
  g.next = Infinity;
  const closePass = { ...target(250, 206), size: 1 },
    distant = { ...target(300, 212), size: 1, id: 2 };
  g.targets = [closePass, distant];
  g.move(200, 200);
  g.press();
  g.move(350, 200);
  assert.equal(g.score, 1);
  assert.equal(closePass.cut, true);
  assert.equal(distant.cut, undefined);
});

test("the complementary clips preserve all opaque pixels and each fragment starts in the original sprite pose", () => {
  const mask = projectileAlpha;
  const contains = (p, poly) =>
    poly.every((a, i) => {
      const b = poly[(i + 1) % poly.length];
      return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-6;
    });
  for (const rotation of [0, 0.9, 2.7])
    for (const flipY of [false, true]) {
      const b = { ...target(310, 240), rotation, flipY, size: 81 };
      const pieces = sliceSprite(b, rotation, {
        a: { x: 275, y: 215 },
        b: { x: 345, y: 265 },
      });
      close(pieces[0].mass + pieces[1].mass, 1);
      for (const part of pieces) {
        assert.ok(part.mass > 0.11 && part.clip.length >= 3);
        const c = Math.cos(rotation),
          s = Math.sin(rotation),
          flip = flipY ? -1 : 1;
        close(part.x - (c * part.localCx - s * part.localCy), b.x);
        close(part.y - (s * part.localCx + c * part.localCy) * flip, b.y);
      }
      for (let y = 0; y < mask.height; y += 3)
        for (let x = 0; x < mask.width; x += 3)
          if (mask.alpha[y * mask.width + x]) {
            const p = {
              x:
                (((x + 0.5) * mask.worldWidth) / mask.width -
                  mask.worldWidth / 2) *
                1.5,
              y:
                (((y + 0.5) * mask.worldHeight) / mask.height -
                  mask.worldHeight / 2) *
                1.5,
            };
            assert.ok(
              pieces.some((part) => contains(p, part.clip)),
              "no visible material is lost between the two clips",
            );
          }
    }
});

test("a successful cut scores once and the two falling pieces never damage the character", () => {
  const g = new Slash();
  g.next = Infinity;
  g.targets = [target(480, 292)];
  g.move(450, 292);
  g.press();
  g.move(510, 292);
  g.move(450, 292);
  g.release();
  assert.equal(g.score, 1);
  assert.equal(g.fragments.length, 2);
  advance(g, 0.5);
  assert.equal(g.lives, 3);
  assert.equal(g.targets.length, 0);
  assert.ok(g.fragments.every((p) => p.vy > 0 && p.age >= 0.49));
  advance(g, 0.5);
  assert.equal(g.fragments.length, 0);
  assert.equal(g.score, 1);
});

test("mouse-only cuts remain viable through a full round with the real alpha geometry", () => {
  for (const intensity of [0.7, 0.9, 1.5])
    for (let seed = 1; seed <= 6; seed++) {
      const g = new Slash({ random: seeded(seed), intensity, hits: realHit });
      let largestCut = 0;
      while (!g.finished) {
        const before = g.score;
        bots.slash(g);
        largestCut = Math.max(largestCut, g.score - before);
        g.step(1 / 60);
      }
      assert.equal(
        g.reason,
        "survived",
        `seed ${seed}, intensity ${intensity}`,
      );
      assert.ok(g.score > 100 && largestCut >= 1);
      assert.equal(g.score, g.cutCount);
    }
});

test("all four sides and corners start on the actual canvas boundary, including the first update", () => {
  const angles = [
    0,
    Math.PI / 2,
    Math.PI,
    -Math.PI / 2,
    ...[-1, 1].flatMap((x) => [-1, 1].map((y) => Math.atan2(y * 270, x * 480))),
  ];
  for (const angle of angles) {
    const g = new Slash({ hits: realHit });
    g.next = Infinity;
    const b = g.spawnTarget(angle),
      source = { ...b.source };
    assert.equal(b.size, 68);
    assert.ok(
      source.x === 0 || source.x === 960 || source.y === 0 || source.y === 540,
    );
    g.update(0.05);
    close(b.x, source.x);
    close(b.y, source.y);
    close(b.age, 0);
  }
  const g = new Slash();
  g.elapsed = g.next;
  g.update(0.05);
  assert.equal(g.targets.length, 1);
  close(g.targets[0].x, g.targets[0].source.x);
  close(g.targets[0].y, g.targets[0].source.y);
});

test("visible alpha reaches the character at the same deadline from every direction", () => {
  for (const intensity of [0.7, 0.9, 1.5])
    for (const elapsed of [0, 6.25, 12.5, 23]) {
      let deadline = null;
      for (let i = 0; i < 24; i++) {
        const g = new Slash({ intensity, hits: realHit });
        g.next = Infinity;
        g.elapsed = elapsed;
        const b = g.spawnTarget((i * Math.PI) / 12);
        if (deadline !== null) close(b.arrival, deadline);
        else deadline = b.arrival;
        g.elapsed = b.arrival - 0.001;
        g.update(0);
        assert.equal(g.lives, 3, `no early contact from direction ${i}`);
        g.elapsed = b.arrival + 0.001;
        g.update(0);
        assert.equal(
          g.lives,
          2,
          `contact at the equalized deadline from direction ${i}`,
        );
      }
    }
});

test("a projectile preserves its launch deadline and the existing speed curve across later entries", () => {
  const g = new Slash({ hits: () => false });
  g.next = Infinity;
  const first = g.spawnTarget(0),
    speed = first.speed,
    arrival = first.arrival;
  for (const elapsed of [0.5, 1, 1.5]) {
    g.elapsed = elapsed;
    g.update(0);
    close(first.speed, speed);
    close(first.arrival, arrival);
    close(first.x, first.source.x + first.vx * elapsed);
  }
  close(first.travelTime, 2 / Math.sqrt(0.9));
  g.elapsed = 12.5;
  const later = g.spawnTarget(0);
  close(later.travelTime, 1.05 / Math.sqrt(0.9));
  assert.ok(later.travelTime < first.travelTime && later.speed > first.speed);
  const top = g.spawnTarget(-Math.PI / 2);
  close(top.travelTime, later.travelTime);
  assert.ok(top.speed < later.speed);
});

test("one unlimited gesture cuts a long row and the larger fragments keep the sprite size", () => {
  const g = new Slash();
  g.next = Infinity;
  g.targets = Array.from({ length: 6 }, (_, i) => ({
    ...target(170 + i * 80, 200),
    id: i + 1,
  }));
  g.move(145, 200);
  g.press();
  g.move(595, 200);
  g.release();
  assert.equal(g.score, 6);
  assert.equal(g.fragments.length, 12);
  assert.ok(g.fragments.every((p) => p.size === SLASH_TARGET_SIZE));
  assert.equal(g.activeCuts.length, 0);
  assert.ok(g.trail.length > 0);
});

test("independent entries cover all four edges at irregular times instead of grouped fans", () => {
  const side = (b) =>
    b.source.x === 0
      ? "left"
      : b.source.x === 960
        ? "right"
        : b.source.y === 0
          ? "top"
          : "bottom";
  for (let seed = 1; seed <= 8; seed++) {
    const g = new Slash({ random: seeded(seed), hits: () => false });
    const entries = [],
      seen = new Set();
    while (!g.finished) {
      g.step(1 / 60);
      for (const b of g.targets)
        if (!seen.has(b.id)) {
          seen.add(b.id);
          entries.push(b);
        }
    }
    assert.ok(entries.length > 130);
    for (let i = 1; i < entries.length; i++)
      assert.notEqual(
        side(entries[i]),
        side(entries[i - 1]),
        "successive entries come from different fields",
      );
    for (let i = 0; i < entries.length - 8; i += 8)
      assert.equal(new Set(entries.slice(i, i + 8).map(side)).size, 4);
    const early = entries.filter((b) => b.spawnedAt < 5),
      gaps = early.slice(1).map((b, i) => b.spawnedAt - early[i].spawnedAt);
    assert.ok(Math.max(...gaps) > Math.min(...gaps) * 1.7);
    assert.ok(
      new Set(
        entries.map((b) => `${b.source.x.toFixed(2)}:${b.source.y.toFixed(2)}`),
      ).size >
        entries.length * 0.95,
    );
    assert.ok(
      entries.every(
        (b) =>
          b.source.x === 0 ||
          b.source.x === 960 ||
          b.source.y === 0 ||
          b.source.y === 540,
      ),
    );
  }
});

test("a delayed update launches one fresh entry on the edge rather than catching up a hidden wave", () => {
  const g = new Slash({ random: seeded(7), hits: () => false });
  g.elapsed = 18;
  g.update(0.05);
  assert.equal(g.targets.length, 1);
  const b = g.targets[0];
  close(b.x, b.source.x);
  close(b.y, b.source.y);
  close(b.spawnedAt, 18);
  assert.ok(g.next > 18);
  g.update(0.05);
  assert.equal(g.targets.length, 1);
});

test("one gesture can cut independent targets approaching from different fields", () => {
  const g = new Slash({ hits: realHit });
  g.next = Infinity;
  const targets = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((a) =>
    g.spawnTarget(a),
  );
  advance(g, targets[0].travelTime - 0.2);
  g.move(targets[0].x - 14, targets[0].y);
  g.press();
  for (const b of targets) g.move(b.x + 14, b.y);
  g.release();
  assert.equal(g.score, 4);
  assert.equal(g.fragments.length, 8);
  assert.equal(g.lives, 3);
  assert.equal(g.activeCuts.length, 0);
});

test("the late game has many more inbound targets while a slow frame still launches at the boundary", () => {
  for (const hz of [20, 60]) {
    const g = new Slash({ random: seeded(2), hits: () => false });
    let early = 0,
      late = 0;
    while (!g.finished) {
      g.step(1 / hz);
      const n = g.targets.filter((b) => b.age <= b.travelTime).length;
      if (g.elapsed < 4) early = Math.max(early, n);
      if (g.elapsed > 20) late = Math.max(late, n);
    }
    assert.ok(g.serial >= 140 && early >= 3 && late >= 10 && late > early);
  }
});
