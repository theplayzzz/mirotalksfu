import { W, H, clamp, lerp, distance, segmentDistance } from "./kit.js";
import { canvasPath } from "./canvas-path.js";
export const TAU = Math.PI * 2;
export const UP = -Math.PI / 4;
export const pace = (g) => clamp(g.progress * 2, 0, 1);
export const pressure = (g) => clamp((g.progress - 0.5) * 2, 0, 1);
export function follow(p, target, dt, tau = 0.09, limit = 1000) {
  const dx = target.x - p.x,
    dy = target.y - p.y,
    d = Math.hypot(dx, dy),
    step = Math.min(1 - Math.exp(-dt / tau), (limit * dt) / (d || 1));
  p.x += dx * step;
  p.y += dy * step;
}
export function edgePoint(g, angle) {
  return canvasPath(g.player ?? { x: W / 2, y: H / 2 }, angle).b;
}
export function incoming(
  g,
  { angle = g.rand(0, TAU), speed = 250, size = 54 } = {},
) {
  const p = edgePoint(g, angle),
    d = distance(p, g.player);
  return {
    ...p,
    vx: ((g.player.x - p.x) / d) * speed,
    vy: ((g.player.y - p.y) / d) * speed,
    size,
    age: 0,
  };
}
export function advance(b, dt) {
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.age = (b.age || 0) + dt;
}
export const outside = (b, pad = 70) =>
  b.x < -pad || b.x > W + pad || b.y < -pad || b.y > H + pad;
export function column(x, y, h, width = 64) {
  if (h <= 0) return [];
  const n = Math.max(1, Math.ceil(h / 28)),
    parts = [];
  for (let i = 0; i < n; i++)
    for (const dx of [-width * 0.23, width * 0.23])
      parts.push({
        x: x + width / 2 + dx,
        y: n === 1 ? y + h / 2 : lerp(y + 19, y + h - 19, i / (n - 1)),
        size: 54,
      });
  return parts;
}
export function spikeFloor(y = 514) {
  const a = [];
  for (let x = 20; x < 960; x += 34) a.push({ x, y, size: 64, rotation: UP });
  return a;
}
export function strokeHit(g, b, line, r = 5) {
  if (segmentDistance(b, line.a, line.b) > 38) return false;
  const n = Math.max(1, Math.ceil(distance(line.a, line.b) / 7));
  for (let i = 0; i <= n; i++)
    if (
      g.hits(
        b,
        {
          x: lerp(line.a.x, line.b.x, i / n),
          y: lerp(line.a.y, line.b.y, i / n),
        },
        r,
      )
    )
      return true;
  return false;
}
export function arc(v, c, r, start, end, color, width = 6) {
  const ctx = v.ctx;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, start, end);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.stroke();
}
