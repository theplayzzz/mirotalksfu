import shape from "./player-shape.js";
import { clamp } from "./kit.js";
export { shape as playerShape };
export const ROOF_GRAVITY = 950;
const cross = (x, y, a, b) => x * b - y * a;

export function syncPlayer(body) {
  const c = Math.cos(body.angle),
    s = Math.sin(body.angle);
  body.x = body.cx - c * shape.center.x + s * shape.center.y;
  body.y = body.cy - s * shape.center.x - c * shape.center.y;
}
export function makePlayer(x, y, angle = 0) {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const body = {
    cx: x + c * shape.center.x - s * shape.center.y,
    cy: y + s * shape.center.x + c * shape.center.y,
    x,
    y,
    angle,
    vx: 0,
    vy: 0,
    omega: 0,
    invMass: 1,
    invInertia: 1 / shape.inertia,
  };
  return body;
}
export function playerCircles(body) {
  const c = Math.cos(body.angle),
    s = Math.sin(body.angle);
  return shape.circles.map((p) => ({
    x: body.cx + c * p.x - s * p.y,
    y: body.cy + s * p.x + c * p.y,
    r: p.r + shape.skin,
  }));
}
export function playerExtents(angle = 0) {
  const body = makePlayer(0, 0, angle),
    parts = playerCircles(body);
  return {
    left: Math.min(...parts.map((p) => p.x - p.r)),
    right: Math.max(...parts.map((p) => p.x + p.r)),
    top: Math.min(...parts.map((p) => p.y - p.r)),
    bottom: Math.max(...parts.map((p) => p.y + p.r)),
  };
}

export function circleRectContact(c, b, tolerance = 0) {
  const x = clamp(c.x, b.x, b.x + b.w),
    y = clamp(c.y, b.y, b.y + b.h),
    dx = c.x - x,
    dy = c.y - y,
    d = Math.hypot(dx, dy);
  if (d > c.r + tolerance) return null;
  if (d > 1e-8) return { x, y, nx: dx / d, ny: dy / d, depth: c.r - d };
  const faces = [
    { d: c.x - b.x, nx: -1, ny: 0, x: b.x, y: c.y },
    { d: b.x + b.w - c.x, nx: 1, ny: 0, x: b.x + b.w, y: c.y },
    { d: c.y - b.y, nx: 0, ny: -1, x: c.x, y: b.y },
    { d: b.y + b.h - c.y, nx: 0, ny: 1, x: c.x, y: b.y + b.h },
  ];
  const p = faces.reduce((a, v) => (v.d < a.d ? v : a));
  return { ...p, depth: c.r + p.d };
}

// Continuous circle cast against the four faces and the four rounded corner arcs.
// An expanded rectangular slab alone would create square, invisible corner contacts.
export function sweepCircleRect(c, dx, dy, b) {
  const overlap = circleRectContact(c, b, 0.0001);
  if (
    overlap &&
    (overlap.depth > 0.001 || dx * overlap.nx + dy * overlap.ny < -1e-8)
  )
    return { ...overlap, time: 0 };
  let best = null;
  const add = (time, nx, ny, x, y) => {
    if (time < -1e-8 || time > 1 || dx * nx + dy * ny >= -1e-9) return;
    time = Math.max(0, time);
    if (!best || time < best.time) best = { time, nx, ny, x, y, depth: 0 };
  };
  if (dx > 1e-9) {
    const t = (b.x - c.r - c.x) / dx,
      y = c.y + dy * t;
    if (y >= b.y && y <= b.y + b.h) add(t, -1, 0, b.x, y);
  }
  if (dx < -1e-9) {
    const t = (b.x + b.w + c.r - c.x) / dx,
      y = c.y + dy * t;
    if (y >= b.y && y <= b.y + b.h) add(t, 1, 0, b.x + b.w, y);
  }
  if (dy > 1e-9) {
    const t = (b.y - c.r - c.y) / dy,
      x = c.x + dx * t;
    if (x >= b.x && x <= b.x + b.w) add(t, 0, -1, x, b.y);
  }
  if (dy < -1e-9) {
    const t = (b.y + b.h + c.r - c.y) / dy,
      x = c.x + dx * t;
    if (x >= b.x && x <= b.x + b.w) add(t, 0, 1, x, b.y + b.h);
  }
  const a = dx * dx + dy * dy;
  if (a > 1e-12)
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const x = sx < 0 ? b.x : b.x + b.w,
          y = sy < 0 ? b.y : b.y + b.h,
          px = c.x - x,
          py = c.y - y;
        const bb = 2 * (px * dx + py * dy),
          cc = px * px + py * py - c.r * c.r,
          disc = bb * bb - 4 * a * cc;
        if (disc < 0) continue;
        const t = (-bb - Math.sqrt(disc)) / (2 * a),
          qx = c.x + dx * t,
          qy = c.y + dy * t;
        if ((qx - x) * sx >= -1e-7 && (qy - y) * sy >= -1e-7)
          add(t, (qx - x) / c.r, (qy - y) / c.r, x, y);
      }
  return best;
}

export function resolveRoofContact(
  body,
  p,
  {
    restitution = 0.18,
    friction = 0.82,
    rollingResistance = 0.45,
    maxRoofRebound = 65,
  } = {},
) {
  const rx = p.x - body.cx,
    ry = p.y - body.cy;
  const velocity = () => ({
    x: body.vx - body.omega * ry,
    y: body.vy + body.omega * rx,
  });
  const v = velocity(),
    vn = v.x * p.nx + v.y * p.ny;
  let impulse = 0;
  if (vn < -0.05) {
    const rn = cross(rx, ry, p.nx, p.ny),
      e =
        vn < -70
          ? Math.min(
              restitution,
              p.ny < -0.65 ? maxRoofRebound / -vn : Infinity,
            )
          : 0;
    impulse = (-(1 + e) * vn) / (body.invMass + rn * rn * body.invInertia);
    const apply = (x, y) => {
      body.vx += x * body.invMass;
      body.vy += y * body.invMass;
      body.omega += cross(rx, ry, x, y) * body.invInertia;
    };
    apply(p.nx * impulse, p.ny * impulse);
    const next = velocity(),
      tx = -p.ny,
      ty = p.nx,
      rt = cross(rx, ry, tx, ty);
    const tangent = clamp(
      -(next.x * tx + next.y * ty) / (body.invMass + rt * rt * body.invInertia),
      -friction * impulse,
      friction * impulse,
    );
    apply(tx * tangent, ty * tangent);
    // A soft, rounded toy loses rolling energy in persistent roof contact.
    if (Math.abs(vn) < 120) {
      // Viscous damping removes rolling energy without pinning an unbalanced pose.
      // It weakens near rest so gravity can still tip the body back onto its support.
      body.omega *= Math.exp(
        -rollingResistance *
          impulse *
          0.08 *
          Math.min(1, Math.abs(body.omega) / 0.8),
      );
    }
  }
  body.omega = clamp(body.omega, -12, 12);
  return { ...p, impulse, normalSpeed: vn };
}

function moveBody(body, t) {
  body.cx += body.vx * t;
  body.cy += body.vy * t;
  body.angle += body.omega * t;
}
export function stepRoofBody(body, buildings, dt, options = {}) {
  let left = dt;
  const events = [];
  while (left > 1e-9) {
    const h = Math.min(
      left,
      1 / 240,
      1.5 /
        Math.max(
          1,
          Math.hypot(body.vx, body.vy) + Math.abs(body.omega) * shape.radius,
        ),
    );
    body.vy += (options.gravity ?? ROOF_GRAVITY) * h;
    body.vx *= Math.exp(-0.018 * h);
    body.omega *= Math.exp(-0.1 * h);
    let remaining = h;
    for (let iteration = 0; iteration < 8 && remaining > 1e-9; iteration++) {
      const from = playerCircles(body),
        end = { ...body };
      moveBody(end, remaining);
      const to = playerCircles(end);
      let first = null;
      for (const building of buildings) {
        if (
          body.cx + shape.radius + Math.abs(body.vx * remaining) < building.x ||
          body.cx - shape.radius - Math.abs(body.vx * remaining) >
            building.x + building.w
        )
          continue;
        for (let i = 0; i < from.length; i++) {
          const p = sweepCircleRect(
            from[i],
            to[i].x - from[i].x,
            to[i].y - from[i].y,
            building,
          );
          if (p && (!first || p.time < first.time))
            first = { ...p, buildingId: building.id, circle: i };
        }
      }
      if (!first) {
        moveBody(body, remaining);
        remaining = 0;
        break;
      }
      const travel = remaining * first.time;
      moveBody(body, travel);
      body.cx += first.nx * (Math.max(0, first.depth) + 0.015);
      body.cy += first.ny * (Math.max(0, first.depth) + 0.015);
      const event = resolveRoofContact(body, first, options);
      if (event.impulse > 0.5) events.push(event);
      remaining -= travel;
      if (first.time < 1e-7) remaining = Math.max(0, remaining - 1e-6);
    }
    if (roofSupport(body, buildings)) {
      // Contact drag damps rolling/sliding without braking a midair trajectory
      // or freezing a tilted body that gravity still needs to tip into balance.
      const drag = options.surfaceDrag ?? 5;
      body.vx *= Math.exp(-drag * h);
      body.omega *= Math.exp(
        -drag * h * Math.min(1, Math.abs(body.omega) / 0.8),
      );
    }
    left -= h;
  }
  syncPlayer(body);
  return events;
}

export function roofSupport(body, buildings) {
  const parts = playerCircles(body);
  for (const b of buildings) {
    if (body.cx < b.x + 1 || body.cx > b.x + b.w - 1) continue;
    if (
      parts.some(
        (c) =>
          c.x >= b.x && c.x <= b.x + b.w && Math.abs(c.y + c.r - b.y) < 0.6,
      )
    )
      return b;
  }
  return null;
}

// Low velocity alone is not rest: gravity must be supported by the contact span.
// A single tangent at a local maximum of support height is an unstable balance.
export function roofEquilibrium(body, buildings) {
  const roof = roofSupport(body, buildings);
  if (!roof) return null;
  const parts = playerCircles(body),
    contacts = parts.filter(
      (c) =>
        c.x >= roof.x &&
        c.x <= roof.x + roof.w &&
        Math.abs(c.y + c.r - roof.y) < 0.6,
    );
  const left = Math.min(...contacts.map((c) => c.x)),
    right = Math.max(...contacts.map((c) => c.x));
  if (body.cx < left - 0.15 || body.cx > right + 0.15) return null;
  const height = (angle) =>
    Math.max(
      ...shape.circles.map(
        (c) => Math.sin(angle) * c.x + Math.cos(angle) * c.y + c.r + shape.skin,
      ),
    );
  const at = height(body.angle);
  if (
    height(body.angle - 0.06) < at - 0.01 ||
    height(body.angle + 0.06) < at - 0.01
  )
    return null;
  return roof;
}
