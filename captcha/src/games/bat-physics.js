import { W, H, clamp, angleDelta } from "./kit.js";

// These same capsules are painted and collided. Coordinates run from grip to tip.
export const BAT_COM = 70;
export const BAT_AIM = 84;
export const BAT_PARTS = [
  { from: 4, to: 29, radius: 4.5, material: "grip" },
  { from: 29, to: 48, radius: 6, material: "neck" },
  { from: 48, to: 114, radius: 11.5, material: "barrel" },
];
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const smooth = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

// Uniform alpha-pixel mass, inertia and concave contour, including transparent gaps.
// Run once per asset, never read pixels during gameplay.
export function shapeFromMask(mask) {
  const { width, height, worldWidth, worldHeight, alpha } = mask,
    px = worldWidth / width,
    py = worldHeight / height;
  const inside = (x, y) =>
    x >= 0 && x < width && y >= 0 && y < height && alpha[y * width + x];
  let count = 0,
    sx = 0,
    sy = 0;
  const opaque = [],
    points = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (inside(x, y)) {
        const p = {
          x: (x + 0.5) * px - worldWidth / 2,
          y: (y + 0.5) * py - worldHeight / 2,
        };
        opaque.push(p);
        count++;
        sx += p.x;
        sy += p.y;
        if (
          !inside(x - 1, y) ||
          !inside(x + 1, y) ||
          !inside(x, y - 1) ||
          !inside(x, y + 1)
        )
          points.push(p);
      }
  if (!count) throw new Error("Empty projectile alpha shape");
  const center = { x: sx / count, y: sy / count };
  let inertia = 0,
    radius = 0;
  for (const p of opaque) {
    const d = (p.x - center.x) ** 2 + (p.y - center.y) ** 2;
    inertia += d;
    radius = Math.max(radius, Math.sqrt(d));
  }
  const round = (n) => Math.round(n * 1e5) / 1e5;
  return {
    worldHeight,
    center: { x: round(center.x), y: round(center.y) },
    inertia: round(inertia / count + (px * px + py * py) / 12),
    radius: round(radius),
    pixelRadius: round(Math.hypot(px, py) / 2),
    points: points.map((p) => [round(p.x - center.x), round(p.y - center.y)]),
  };
}

export function syncArtwork(body, shape) {
  const s = body.size / shape.worldHeight,
    c = Math.cos(body.rotation),
    sn = Math.sin(body.rotation),
    flip = body.flipY ? -1 : 1;
  body.x = body.cx - (c * shape.center.x - sn * shape.center.y) * s;
  body.y = body.cy - (sn * shape.center.x + c * shape.center.y) * s * flip;
}
export function makeProjectile(
  shape,
  {
    x,
    y,
    vx,
    vy,
    size = 62,
    rotation = Math.PI * 1.25,
    flipY = true,
    id = 0,
    mass = 1,
  } = {},
) {
  const s = size / shape.worldHeight,
    c = Math.cos(rotation),
    sn = Math.sin(rotation),
    flip = flipY ? -1 : 1;
  return {
    id,
    x,
    y,
    cx: x + (c * shape.center.x - sn * shape.center.y) * s,
    cy: y + (sn * shape.center.x + c * shape.center.y) * s * flip,
    vx,
    vy,
    rotation,
    flipY,
    size,
    omega: 0,
    invMass: 1 / mass,
    invInertia: 1 / (mass * shape.inertia * s * s),
    radius: shape.radius * s,
    free: false,
    contacts: 0,
    lastContactAt: -10,
    credited: false,
  };
}
export function integrateProjectile(body, shape, dt) {
  body.cx += body.vx * dt;
  body.cy += body.vy * dt;
  body.rotation += body.omega * dt * (body.flipY ? -1 : 1);
  if (body.free) {
    body.vy += (body.gravity ?? 105) * dt;
    body.omega *= Math.exp(-dt * 0.45);
    const drag = Math.exp(-dt * (body.airDrag ?? 0.018));
    body.vx *= drag;
    body.vy *= drag;
  }
  syncArtwork(body, shape);
}
export function createBat(x = 245, y = 365) {
  return {
    x,
    y: y + BAT_AIM - BAT_COM,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    omega: 0,
    gripX: x,
    gripY: y + BAT_AIM,
    // Mouse guides the grip; impacts can rotate the bat about that wrist joint.
    invMass: 0,
    invInertia: 1 / 11000,
    aimX: x,
    aimY: y,
    aimVX: 0,
    aimVY: 0,
    restAngle: -Math.PI / 2,
    swingAge: 99,
  };
}
export const SWING_DURATION = 0.56;
export const SWING_CONTACT_START = 0.045;
export const SWING_CONTACT_END = 0.295;
export const isBatStriking = (bat) =>
  bat.swingAge >= SWING_CONTACT_START && bat.swingAge < SWING_CONTACT_END;
export function swingOffset(age) {
  if (age < 0) return 0;
  if (age < 0.045) return -0.36 * smooth(age / 0.045);
  if (age < 0.205) return -0.36 + 1.21 * smooth((age - 0.045) / 0.16);
  if (age < 0.295) return 0.85 + 0.23 * smooth((age - 0.205) / 0.09);
  if (age < SWING_DURATION)
    return 1.08 * (1 - smooth((age - 0.295) / (SWING_DURATION - 0.295)));
  return 0;
}
export function driveBat(bat, pointer, swingAge, dt) {
  const aimX = clamp(pointer.x, 0, W),
    aimY = clamp(pointer.y, 0, H),
    before = bat.aimX,
    beforeY = bat.aimY;
  const deltaX = aimX - bat.aimX,
    deltaY = aimY - bat.aimY,
    d = Math.hypot(deltaX, deltaY),
    f = Math.min(1 - Math.exp(-dt / 0.025), (1000 * dt) / (d || 1));
  bat.aimX += deltaX * f;
  bat.aimY += deltaY * f;
  bat.aimVX +=
    (clamp((bat.aimX - before) / dt, -1000, 1000) - bat.aimVX) *
    (1 - Math.exp(-dt / 0.055));
  bat.aimVY +=
    (clamp((bat.aimY - beforeY) / dt, -1000, 1000) - bat.aimVY) *
    (1 - Math.exp(-dt / 0.055));
  bat.restAngle = -Math.PI / 2 + clamp(bat.aimVX * 0.0003, -0.3, 0.3);
  const targetAngle = bat.restAngle + swingOffset(swingAge),
    active = swingAge < SWING_DURATION;
  const targetX = bat.aimX - Math.cos(bat.restAngle) * BAT_AIM,
    targetY = bat.aimY - Math.sin(bat.restAngle) * BAT_AIM;
  const gx = targetX - bat.gripX,
    gy = targetY - bat.gripY,
    gd = Math.hypot(gx, gy),
    gf = Math.min(1 - Math.exp(-dt / 0.018), (1200 * dt) / (gd || 1));
  bat.vx = (gx * gf) / dt;
  bat.vy = (gy * gf) / dt;
  bat.gripX += gx * gf;
  bat.gripY += gy * gf;
  if (swingAge >= SWING_CONTACT_END && swingAge - dt < SWING_DURATION) {
    // Replan a cubic return from the actual pose and recoil to rest at the
    // cooldown deadline. This preserves continuity after an impact, while the
    // final pose and angular velocity agree with the ready indicator.
    const timeLeft =
        SWING_DURATION - Math.max(SWING_CONTACT_END, swingAge - dt),
      u = clamp(dt / timeLeft, 0, 1),
      offset = angleDelta(bat.angle, bat.restAngle),
      tangent = bat.omega * timeLeft,
      angle =
        offset * (2 * u ** 3 - 3 * u ** 2 + 1) +
        tangent * (u ** 3 - 2 * u ** 2 + u);
    bat.angle = bat.restAngle + angle;
    bat.omega =
      (offset * (6 * u ** 2 - 6 * u) + tangent * (3 * u ** 2 - 4 * u + 1)) /
      timeLeft;
  } else {
    const angularFrequency = active ? 34 : 1.5;
    bat.omega +=
      clamp(
        angleDelta(targetAngle, bat.angle) * angularFrequency ** 2 -
          bat.omega * angularFrequency * 1.8,
        -700,
        700,
      ) * dt;
    bat.omega = clamp(bat.omega, -18, 18);
    bat.angle += bat.omega * dt;
  }
  bat.x = bat.gripX + Math.cos(bat.angle) * BAT_COM;
  bat.y = bat.gripY + Math.sin(bat.angle) * BAT_COM;
  bat.swingAge = swingAge;
}
export function batCapsules(bat) {
  const c = Math.cos(bat.angle),
    s = Math.sin(bat.angle);
  return BAT_PARTS.map((part) => ({
    ...part,
    a: {
      x: bat.x + c * (part.from - BAT_COM),
      y: bat.y + s * (part.from - BAT_COM),
    },
    b: {
      x: bat.x + c * (part.to - BAT_COM),
      y: bat.y + s * (part.to - BAT_COM),
    },
  }));
}

export function batContact(body, shape, bat, capsules = batCapsules(bat)) {
  if (Math.hypot(body.cx - bat.x, body.cy - bat.y) > body.radius + 87)
    return null;
  const scale = body.size / shape.worldHeight,
    c = Math.cos(body.rotation) * scale,
    s = Math.sin(body.rotation) * scale,
    flip = body.flipY ? -1 : 1,
    skin = shape.pixelRadius * scale;
  let best = null;
  for (const part of capsules) {
    const dx = part.b.x - part.a.x,
      dy = part.b.y - part.a.y,
      l2 = dx * dx + dy * dy;
    const centerT = clamp(
      ((body.cx - part.a.x) * dx + (body.cy - part.a.y) * dy) / (l2 || 1),
      0,
      1,
    );
    if (
      Math.hypot(
        body.cx - part.a.x - dx * centerT,
        body.cy - part.a.y - dy * centerT,
      ) >
      body.radius + part.radius + skin
    )
      continue;
    for (const [lx, ly] of shape.points) {
      const x = body.cx + c * lx - s * ly,
        y = body.cy + (s * lx + c * ly) * flip,
        t = clamp(
          ((x - part.a.x) * dx + (y - part.a.y) * dy) / (l2 || 1),
          0,
          1,
        ),
        qx = part.a.x + dx * t,
        qy = part.a.y + dy * t,
        ex = x - qx,
        ey = y - qy,
        d = Math.hypot(ex, ey),
        depth = part.radius + skin - d;
      if (depth <= 0 || (best && best.depth >= depth)) continue;
      const n = d > 1e-7 ? { x: ex / d, y: ey / d } : { x: 1, y: 0 };
      best = {
        x: x - n.x * skin,
        y: y - n.y * skin,
        nx: n.x,
        ny: n.y,
        depth,
        batFraction: (part.from + (part.to - part.from) * t) / 125.5,
        part: part.material,
      };
    }
  }
  return best;
}

function applyImpulse(body, bat, p, jx, jy) {
  const ax = p.x - body.cx,
    ay = p.y - body.cy,
    bx = p.x - (bat.gripX ?? bat.x),
    by = p.y - (bat.gripY ?? bat.y);
  body.vx += jx * body.invMass;
  body.vy += jy * body.invMass;
  body.omega += cross(ax, ay, jx, jy) * body.invInertia;
  bat.vx -= jx * bat.invMass;
  bat.vy -= jy * bat.invMass;
  bat.omega -= cross(bx, by, jx, jy) * bat.invInertia;
}
export function resolveBatContact(
  body,
  bat,
  p,
  { restitution = 0.42, friction = 0.25, striking = true } = {},
) {
  const ax = p.x - body.cx,
    ay = p.y - body.cy,
    bx = p.x - (bat.gripX ?? bat.x),
    by = p.y - (bat.gripY ?? bat.y);
  const surface = () => {
    const x = bat.vx - bat.omega * by,
      y = bat.vy + bat.omega * bx,
      rawSpeed = Math.hypot(x, y),
      scale = striking ? 1 : Math.min(0.12, 90 / (rawSpeed || 1));
    return { x: x * scale, y: y * scale, rawSpeed };
  };
  const relative = () => {
    const v = surface();
    return {
      x: body.vx - body.omega * ay - v.x,
      y: body.vy + body.omega * ax - v.y,
    };
  };
  if (!striking) {
    restitution = Math.min(restitution, 0.06);
    friction = Math.min(friction, 0.12);
  }
  const denom = (nx, ny) =>
    body.invMass +
    bat.invMass +
    cross(ax, ay, nx, ny) ** 2 * body.invInertia +
    cross(bx, by, nx, ny) ** 2 * bat.invInertia;
  const rv = relative(),
    pointVelocity = surface(),
    normalSpeed = rv.x * p.nx + rv.y * p.ny,
    batPointVX = pointVelocity.x,
    batPointVY = pointVelocity.y,
    batNormalSpeed = batPointVX * p.nx + batPointVY * p.ny;
  let impulse = 0,
    batWork = 0;
  if (normalSpeed < -0.2) {
    impulse = (-(1 + restitution) * normalSpeed) / denom(p.nx, p.ny);
    applyImpulse(body, bat, p, p.nx * impulse, p.ny * impulse);
    const after = relative(),
      tx = -p.ny,
      ty = p.nx,
      jt = clamp(
        -(after.x * tx + after.y * ty) / denom(tx, ty),
        -friction * impulse,
        friction * impulse,
      );
    applyImpulse(body, bat, p, tx * jt, ty * jt);
    batWork =
      impulse * batNormalSpeed + jt * (batPointVX * tx + batPointVY * ty);
    body.free = true;
  }
  const correction =
    Math.min(3, Math.max(0, p.depth - 0.08) * 0.65) /
    (body.invMass + bat.invMass);
  body.cx += p.nx * correction * body.invMass;
  body.cy += p.ny * correction * body.invMass;
  bat.x -= p.nx * correction * bat.invMass;
  bat.y -= p.ny * correction * bat.invMass;
  body.omega = clamp(body.omega, -48, 48);
  const v = Math.hypot(body.vx, body.vy);
  if (v > 1600) {
    body.vx *= 1600 / v;
    body.vy *= 1600 / v;
  }
  return {
    striking,
    impulse,
    normalSpeed,
    batNormalSpeed,
    batPointSpeed: Math.hypot(batPointVX, batPointVY),
    batRawPointSpeed: pointVelocity.rawSpeed,
    batWork,
    offset: Math.hypot(ax, ay),
    batFraction: p.batFraction,
    x: p.x,
    y: p.y,
    nx: p.nx,
    ny: p.ny,
  };
}
