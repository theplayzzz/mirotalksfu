import packed from "./projectile-mask.js";
import { clamp } from "./kit.js";

const alpha = new Uint8Array(packed.width * packed.height);
for (let y = 0; y < packed.height; y++)
  for (let i = 0; i < packed.rows[y].length; i += 2)
    alpha.fill(
      1,
      y * packed.width + packed.rows[y][i],
      y * packed.width + packed.rows[y][i + 1],
    );
export const projectileAlpha = { ...packed, alpha };
const cross = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

export function spriteLocalPoint(p, source, rotation, mask = projectileAlpha) {
  const scale = (source.size || 54) / mask.worldHeight,
    c = Math.cos(rotation),
    s = Math.sin(rotation);
  const x = (p.x - source.x) / scale,
    y = ((p.y - source.y) / scale) * (source.flipY ? -1 : 1);
  return { x: c * x + s * y, y: -s * x + c * y };
}
export function spriteWorldPoint(p, source, rotation, mask = projectileAlpha) {
  const scale = (source.size || 54) / mask.worldHeight,
    c = Math.cos(rotation),
    s = Math.sin(rotation);
  return {
    x: source.x + (c * p.x - s * p.y) * scale,
    y: source.y + (s * p.x + c * p.y) * scale * (source.flipY ? -1 : 1),
  };
}
function hull(points) {
  const p = points
    .toSorted((a, b) => a.x - b.x || a.y - b.y)
    .filter(
      (v, i, a) => !i || Math.hypot(v.x - a[i - 1].x, v.y - a[i - 1].y) > 1e-9,
    );
  if (p.length < 3) return p;
  const low = [],
    high = [];
  for (const v of p) {
    while (low.length > 1 && cross(low.at(-2), low.at(-1), v) <= 1e-9)
      low.pop();
    low.push(v);
  }
  for (const v of p.toReversed()) {
    while (high.length > 1 && cross(high.at(-2), high.at(-1), v) <= 1e-9)
      high.pop();
    high.push(v);
  }
  return [...low.slice(0, -1), ...high.slice(0, -1)];
}
function pointSegmentDistanceSq(p, a, b) {
  const x = b.x - a.x,
    y = b.y - a.y,
    t = clamp(((p.x - a.x) * x + (p.y - a.y) * y) / (x * x + y * y || 1), 0, 1);
  return (p.x - a.x - t * x) ** 2 + (p.y - a.y - t * y) ** 2;
}
function segmentRectDistanceSq(a, b, box) {
  let enter = 0,
    exit = 1;
  for (const key of ["x", "y"]) {
    const d = b[key] - a[key],
      min = box[key],
      max = box[key] + (key === "x" ? box.w : box.h);
    if (Math.abs(d) < 1e-10) {
      if (a[key] < min || a[key] > max) {
        enter = 2;
        break;
      }
    } else {
      const t1 = (min - a[key]) / d,
        t2 = (max - a[key]) / d;
      enter = Math.max(enter, Math.min(t1, t2));
      exit = Math.min(exit, Math.max(t1, t2));
    }
  }
  if (enter <= exit) return 0;
  const pointRect = (p) =>
    (p.x - clamp(p.x, box.x, box.x + box.w)) ** 2 +
    (p.y - clamp(p.y, box.y, box.y + box.h)) ** 2;
  return Math.min(
    pointRect(a),
    pointRect(b),
    ...[
      { x: box.x, y: box.y },
      { x: box.x + box.w, y: box.y },
      { x: box.x + box.w, y: box.y + box.h },
      { x: box.x, y: box.y + box.h },
    ].map((p) => pointSegmentDistanceSq(p, a, b)),
  );
}
function inside(p, polygon) {
  return (
    polygon.length > 2 &&
    polygon.every(
      (a, i) => cross(a, polygon[(i + 1) % polygon.length], p) >= -1e-9,
    )
  );
}

// The relative motion of a straight blade and a translating sprite is a convex
// swept strip. Test it against occupied alpha cells, without gaps between samples.
export function bladeMaskHit(mask, source, rotation, line, previous = source) {
  if (!mask) return null;
  const old = { ...source, x: previous.x, y: previous.y };
  const polygon = hull([
    spriteLocalPoint(line.a, source, rotation, mask),
    spriteLocalPoint(line.b, source, rotation, mask),
    spriteLocalPoint(line.a, old, rotation, mask),
    spriteLocalPoint(line.b, old, rotation, mask),
  ]);
  if (!polygon.length) return null;
  const radius = ((line.radius ?? 3) * mask.worldHeight) / (source.size || 54),
    r2 = radius * radius;
  const px = mask.worldWidth / mask.width,
    py = mask.worldHeight / mask.height,
    halfW = mask.worldWidth / 2,
    halfH = mask.worldHeight / 2;
  const left = Math.max(
    0,
    Math.floor((Math.min(...polygon.map((p) => p.x)) - radius + halfW) / px),
  );
  const right = Math.min(
    mask.width - 1,
    Math.floor((Math.max(...polygon.map((p) => p.x)) + radius + halfW) / px),
  );
  const top = Math.max(
    0,
    Math.floor((Math.min(...polygon.map((p) => p.y)) - radius + halfH) / py),
  );
  const bottom = Math.min(
    mask.height - 1,
    Math.floor((Math.max(...polygon.map((p) => p.y)) + radius + halfH) / py),
  );
  for (let y = top; y <= bottom; y++)
    for (let x = left; x <= right; x++) {
      if (!mask.alpha[y * mask.width + x]) continue;
      const box = { x: x * px - halfW, y: y * py - halfH, w: px, h: py },
        p = { x: box.x + px / 2, y: box.y + py / 2 };
      const hit =
        inside(p, polygon) ||
        polygon.some(
          (a, i) =>
            segmentRectDistanceSq(a, polygon[(i + 1) % polygon.length], box) <=
            r2 + 1e-10,
        );
      if (hit)
        return { ...spriteWorldPoint(p, source, rotation, mask), local: p };
    }
  return null;
}

function clipHalf(polygon, n, offset, side) {
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const da = side * (n.x * a.x + n.y * a.y - offset),
      db = side * (n.x * b.x + n.y * b.y - offset);
    if (da >= 0) result.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return result;
}

export function sliceSprite(source, rotation, line, mask = projectileAlpha) {
  const a = spriteLocalPoint(line.a, source, rotation, mask),
    b = spriteLocalPoint(line.b, source, rotation, mask);
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1,
    n = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  let offset = n.x * a.x + n.y * a.y;
  const pixels = [],
    sums = [
      { x: 0, y: 0, n: 0 },
      { x: 0, y: 0, n: 0 },
    ],
    px = mask.worldWidth / mask.width,
    py = mask.worldHeight / mask.height;
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++)
      if (mask.alpha[y * mask.width + x])
        pixels.push({
          x: (x + 0.5) * px - mask.worldWidth / 2,
          y: (y + 0.5) * py - mask.worldHeight / 2,
        });
  const partition = () => {
    sums.forEach((s) => {
      s.x = s.y = s.n = 0;
    });
    for (const p of pixels) {
      const s = sums[n.x * p.x + n.y * p.y >= offset ? 1 : 0];
      s.x += p.x;
      s.y += p.y;
      s.n++;
    }
  };
  partition();
  // A tangential touch still gets readable halves rather than an invisible sliver.
  if (Math.min(sums[0].n, sums[1].n) < pixels.length * 0.12) {
    offset =
      pixels.reduce((s, p) => s + n.x * p.x + n.y * p.y, 0) / pixels.length;
    partition();
  }
  const scale = (source.size || 54) / mask.worldHeight,
    w = mask.worldWidth / 2,
    h = mask.worldHeight / 2;
  const rect = [
    { x: -w, y: -h },
    { x: w, y: -h },
    { x: w, y: h },
    { x: -w, y: h },
  ];
  const c = Math.cos(rotation),
    s = Math.sin(rotation),
    flip = source.flipY ? -1 : 1;
  const worldNormal = { x: c * n.x - s * n.y, y: (s * n.x + c * n.y) * flip };
  return sums.map((sum, i) => {
    const side = i ? 1 : -1,
      local = { x: sum.x / sum.n, y: sum.y / sum.n },
      world = spriteWorldPoint(local, source, rotation, mask);
    const other = sums[1 - i].n / pixels.length;
    return {
      ...world,
      rotation,
      flipY: !!source.flipY,
      size: source.size || 54,
      localCx: local.x * scale,
      localCy: local.y * scale,
      clip: clipHalf(rect, n, offset, side).map((p) => ({
        x: p.x * scale,
        y: p.y * scale,
      })),
      vx: (source.vx || 0) * 0.25 + side * worldNormal.x * 240 * other,
      vy: (source.vy || 0) * 0.25 + side * worldNormal.y * 240 * other - 65,
      omega: side * (3 + ((source.id || 0) % 7) * 0.17),
      age: 0,
      life: 0.95,
      part: i,
      mass: sum.n / pixels.length,
    };
  });
}
