import { W, H, clamp, distance, segmentDistance } from "./kit.js";
import { isBatStriking } from "./bat-physics.js";

export function exitTime(body) {
  const r = body.radius;
  const tx =
    Math.abs(body.vx) < 1e-6
      ? Infinity
      : (body.vx > 0 ? W + r - body.cx : -r - body.cx) / body.vx;
  const ty =
    Math.abs(body.vy) < 1e-6
      ? Infinity
      : (body.vy > 0 ? H + r - body.cy : -r - body.cy) / body.vy;
  return Math.max(0, Math.min(tx, ty));
}

export function canExpel(body, bat, event) {
  return (
    isBatStriking(bat) &&
    event.striking &&
    event.batNormalSpeed >= 100 &&
    event.batWork >= 24000 &&
    Math.hypot(body.vx, body.vy) >= 360 &&
    exitTime(body) <= 1.6
  );
}

const orient = (a, b, p) =>
  (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
function segmentGap(a, b, c, d) {
  if (
    Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <=
      Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <=
      Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) &&
    orient(a, b, c) * orient(a, b, d) <= 0 &&
    orient(c, d, a) * orient(c, d, b) <= 0
  )
    return 0;
  return Math.min(
    segmentDistance(a, c, d),
    segmentDistance(b, c, d),
    segmentDistance(c, a, b),
    segmentDistance(d, a, b),
  );
}

// Weak contacts retain momentum and spin, then steer around the bat toward the player.
export function guideWeakProjectile(
  body,
  player,
  capsules,
  time,
  dt,
  cruiseSpeed,
) {
  if (body.returnAt === undefined) body.returnAt = time + 0.22;
  if (time < body.returnAt) return;
  const pos = { x: body.cx, y: body.cy },
    speed = clamp(cruiseSpeed, 220, 520);
  let target = player;
  if (
    capsules.some(
      (p) => segmentGap(pos, player, p.a, p.b) < body.radius + p.radius + 8,
    )
  ) {
    const first = capsules[0],
      last = capsules.at(-1),
      a = first.a,
      b = last.b,
      length = distance(a, b),
      ux = (b.x - a.x) / length,
      uy = (b.y - a.y) / length;
    body.bypassSide ??= distance(pos, b) <= distance(pos, a) ? 1 : -1;
    const end = body.bypassSide > 0 ? b : a,
      padding = body.radius + Math.max(first.radius, last.radius) + 24;
    target = {
      x: clamp(end.x + ux * padding * body.bypassSide, 24, W - 24),
      y: clamp(end.y + uy * padding * body.bypassSide, 24, H - 24),
    };
  }
  const dx = target.x - body.cx,
    dy = target.y - body.cy,
    d = Math.hypot(dx, dy) || 1,
    gain = 1 - Math.exp(-dt / 0.65),
    dvx = ((dx / d) * speed - body.vx) * gain,
    dvy = ((dy / d) * speed - body.vy) * gain,
    maxChange = Math.min(760, 240 + speed * 0.8) * dt,
    scale = Math.min(1, maxChange / (Math.hypot(dvx, dvy) || 1));
  body.vx += dvx * scale;
  body.vy += dvy * scale;
  // Soft off-screen bounds return weak deflections without teleporting or deleting them.
  const r = body.radius;
  if (body.cx < -r)
    body.vx += ((-r - body.cx) * 30 - Math.min(0, body.vx) * 5) * dt;
  if (body.cx > W + r)
    body.vx += ((W + r - body.cx) * 30 - Math.max(0, body.vx) * 5) * dt;
  if (body.cy < -r)
    body.vy += ((-r - body.cy) * 30 - Math.min(0, body.vy) * 5) * dt;
  if (body.cy > H + r)
    body.vy += ((H + r - body.cy) * 30 - Math.max(0, body.vy) * 5) * dt;
}

export const fullyOutside = (b) =>
  b.cx + b.radius < 0 ||
  b.cx - b.radius > W ||
  b.cy + b.radius < 0 ||
  b.cy - b.radius > H;
