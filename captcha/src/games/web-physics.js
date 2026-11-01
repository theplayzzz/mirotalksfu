import { clamp } from "./kit.js";
import { spriteLocalPoint } from "./blade-geometry.js";

export const WEB_GRAVITY = 780;
export const WEB_SWING_GRAVITY = 880;

export function rayRectangle(origin, direction, rect, limit = Infinity) {
  let enter = 0,
    exit = limit;
  for (const key of ["x", "y"]) {
    const d = direction[key],
      min = rect[key],
      max = min + (key === "x" ? rect.w : rect.h);
    if (Math.abs(d) < 1e-10) {
      if (origin[key] < min || origin[key] > max) return null;
    } else {
      const a = (min - origin[key]) / d,
        b = (max - origin[key]) / d;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return null;
    }
  }
  return enter <= limit && exit >= 0
    ? {
        distance: enter,
        x: clamp(origin.x + direction.x * enter, rect.x, rect.x + rect.w),
        y: clamp(origin.y + direction.y * enter, rect.y, rect.y + rect.h),
      }
    : null;
}

// Traverse occupied alpha cells in ray order, matching the sprite's scale,
// rotation and reflection. Transparent corners and gaps are not web anchors.
export function raySprite(origin, direction, sprite, mask, limit = Infinity) {
  const rotation = sprite.rotation ?? 0,
    a = spriteLocalPoint(origin, sprite, rotation, mask),
    b = spriteLocalPoint(
      { x: origin.x + direction.x, y: origin.y + direction.y },
      sprite,
      rotation,
      mask,
    ),
    d = { x: b.x - a.x, y: b.y - a.y },
    halfW = mask.worldWidth / 2,
    halfH = mask.worldHeight / 2,
    hit = rayRectangle(
      a,
      d,
      { x: -halfW, y: -halfH, w: mask.worldWidth, h: mask.worldHeight },
      limit,
    );
  if (!hit) return null;
  const cellW = mask.worldWidth / mask.width,
    cellH = mask.worldHeight / mask.height,
    gx = (a.x + halfW) / cellW,
    gy = (a.y + halfH) / cellH,
    dx = d.x / cellW,
    dy = d.y / cellH,
    sx = Math.sign(dx),
    sy = Math.sign(dy);
  let t = hit.distance,
    x = clamp(Math.floor(gx + dx * (t + 1e-7)), 0, mask.width - 1),
    y = clamp(Math.floor(gy + dy * (t + 1e-7)), 0, mask.height - 1),
    tx = sx ? ((sx > 0 ? x + 1 : x) - gx) / dx : Infinity,
    ty = sy ? ((sy > 0 ? y + 1 : y) - gy) / dy : Infinity;
  while (t <= limit && x >= 0 && x < mask.width && y >= 0 && y < mask.height) {
    if (mask.alpha[y * mask.width + x]) {
      const distance = Math.min(limit, t + 1e-7);
      return {
        distance,
        x: origin.x + direction.x * distance,
        y: origin.y + direction.y * distance,
      };
    }
    const next = Math.min(tx, ty);
    if (!Number.isFinite(next)) break;
    if (tx <= next + 1e-10) {
      x += sx;
      tx += 1 / Math.abs(dx);
    }
    if (ty <= next + 1e-10) {
      y += sy;
      ty += 1 / Math.abs(dy);
    }
    t = next;
  }
  return null;
}

export function attachWeb(body, anchor, { maxLength = 340 } = {}) {
  const length = Math.hypot(body.x - anchor.x, body.y - anchor.y);
  const vertical = Math.max(0.4, (body.y - anchor.y) / (length || 1)),
    lift = anchor.y < body.y - 16 ? clamp(body.y - 285, 35, 130) : 0,
    targetLength = Math.min(
      length,
      lift
        ? Math.max(110, Math.min(length - lift / vertical, maxLength))
        : length,
    ),
    reelAmount = length - targetLength;
  return {
    x: anchor.x,
    y: anchor.y,
    blockId: anchor.blockId,
    kind: anchor.kind ?? "block",
    obstacleId: anchor.obstacleId,
    length,
    startLength: length,
    targetLength,
    reelAmount,
    reelLeft: reelAmount,
    reelDuration: clamp(reelAmount / 500, 0.18, 0.42),
    age: 0,
    taut: false,
  };
}

// A cable pulls but cannot push. The winch changes the supported length without
// injecting inward velocity, which would leave slack and a drop after the lift.
export function stepPendulum(
  body,
  rope,
  dt,
  { gravity = rope ? WEB_SWING_GRAVITY : WEB_GRAVITY, drag = 0.008 } = {},
) {
  body.vy += gravity * dt;
  body.vx *= Math.exp(-drag * dt);
  body.x += body.vx * dt;
  body.y += body.vy * dt;
  if (!rope || !dt) return;
  rope.age += dt;
  if (rope.reelLeft > 0) {
    const t = Math.min(1, rope.age / rope.reelDuration),
      eased = t * t * (3 - 2 * t);
    rope.length = Math.min(
      rope.length,
      rope.startLength - rope.reelAmount * eased,
    );
    rope.reelLeft = Math.max(0, rope.length - rope.targetLength);
  }
  const x = body.x - rope.x,
    y = body.y - rope.y,
    d = Math.hypot(x, y);
  rope.taut = d >= rope.length - 0.001;
  if (d > rope.length) {
    const nx = x / d,
      ny = y / d;
    body.x = rope.x + nx * rope.length;
    body.y = rope.y + ny * rope.length;
    const radial = body.vx * nx + body.vy * ny;
    if (radial > 0) {
      body.vx -= nx * radial;
      body.vy -= ny * radial;
    }
  }
}

export const webLean = (body) => clamp(body.vx * 0.0006, -0.28, 0.28);
