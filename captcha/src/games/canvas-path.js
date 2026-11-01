import { W, H } from "./kit.js";

// Intersect the entire line with the real canvas, rather than an inset arena.
export function canvasPath(point, angle) {
  const dx = Math.cos(angle),
    dy = Math.sin(angle);
  const xs =
    Math.abs(dx) < 1e-10
      ? [-Infinity, Infinity]
      : [-point.x / dx, (W - point.x) / dx].sort((a, b) => a - b);
  const ys =
    Math.abs(dy) < 1e-10
      ? [-Infinity, Infinity]
      : [-point.y / dy, (H - point.y) / dy].sort((a, b) => a - b);
  const start = Math.max(xs[0], ys[0]),
    end = Math.min(xs[1], ys[1]);
  const snap = (v, max) =>
    Math.abs(v) < 1e-8 ? 0 : Math.abs(v - max) < 1e-8 ? max : v;
  const at = (t) => ({
    x: snap(point.x + dx * t, W),
    y: snap(point.y + dy * t, H),
  });
  return { a: at(start), b: at(end), dx, dy, length: end - start };
}
