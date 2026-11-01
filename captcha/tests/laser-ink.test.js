import test from "node:test";
import assert from "node:assert/strict";
import { Shelter } from "../src/games/dodging.js";
import { distance } from "../src/games/kit.js";
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const used = (g) => g.lines.reduce((s, l) => s + l.length, 0);
const create = () => {
  const g = new Shelter();
  g.next = Infinity;
  return g;
};
function draw(g, a, b, release = true) {
  g.move(a, 120);
  g.press();
  g.move(b, 120);
  if (release) g.release();
}
function age(g, t) {
  g.elapsed = t;
  g.update(0);
  close(g.ink + used(g), g.maxInk);
}

test("laser delay and duration scale with actual stroke length, up to two seconds for the full reserve", () => {
  for (const length of [28, 140, 280, 420]) {
    const g = create();
    draw(g, 100, 100 + length);
    age(g, 0.49);
    close(used(g), length);
    const finish = 0.5 + length / 280;
    age(g, (0.5 + finish) / 2);
    close(used(g), length / 2);
    age(g, finish);
    assert.equal(g.lines.length, 0);
    close(g.ink, 420);
  }
});

test("the front erases from the gesture's beginning, including right-to-left strokes", () => {
  for (const [start, end, expected] of [
    [100, 520, 170],
    [700, 280, 630],
  ]) {
    const g = create();
    draw(g, start, end);
    age(g, 0.75);
    close(g.lines[0].a.x, expected);
    close(g.lines.at(-1).b.x, end);
    close(used(g), 350);
    close(g.ink, 70);
  }
});

test("holding the mouse still cannot keep ink alive or bank erasing time against fresh ink", () => {
  const g = create();
  draw(g, 100, 180, false);
  age(g, 1);
  assert.equal(g.input.down, true);
  assert.equal(g.lines.length, 0);
  close(g.ink, 420);
  g.move(200, 120);
  age(g, 1.49);
  close(used(g), 20);
  age(g, 1.6);
  assert.equal(g.lines.length, 0);
  g.release();
  assert.equal(g.strokes.length, 0);
});

test("an impact only clips its local section and expiry refunds the remaining pieces", () => {
  const g = create();
  draw(g, 200, 600);
  g.drops.push({ x: 400, y: 120, vx: 0, vy: 0 });
  g.update(0);
  assert.equal(g.score, 1);
  close(used(g), 304);
  close(g.ink, 116);
  assert.ok(g.lines.some((l) => l.b.x <= 352));
  assert.ok(g.lines.some((l) => l.a.x >= 448));
  assert.ok(g.lines.every((l) => l.b.x <= 352 + 1e-7 || l.a.x >= 448 - 1e-7));
  assert.ok(
    g.lines.every((l) => Math.abs(l.length - distance(l.a, l.b)) < 1e-7),
  );
  age(g, 2);
  assert.equal(g.lines.length, 0);
  close(g.ink, 420);
});

test("erasure is frame independent and cannot advance when simulation time is paused", () => {
  for (const dt of [1 / 120, 1 / 30, 0.05]) {
    const g = create();
    draw(g, 100, 520);
    while (g.elapsed < 1.25 - 1e-8) {
      g.step(Math.min(dt, 1.25 - g.elapsed));
      close(g.ink + used(g), 420);
    }
    close(used(g), 210);
    const before = JSON.stringify(g.lines);
    for (let i = 0; i < 25; i++) g.update(0);
    assert.equal(JSON.stringify(g.lines), before);
    age(g, 2);
    close(g.ink, 420);
  }
});

test("separate gestures and tiny cut leftovers all expire without manual cleanup", () => {
  const g = create();
  draw(g, 100, 200);
  g.move(150, 120);
  g.secondary();
  close(used(g), 16);
  age(g, 0.2);
  draw(g, 400, 450);
  age(g, 0.7);
  close(used(g), 50);
  assert.ok(g.lines.every((l) => l.strokeId === 2));
  age(g, 1);
  assert.equal(g.lines.length, 0);
  assert.equal(g.strokes.length, 0);
  close(g.ink, 420);
});
