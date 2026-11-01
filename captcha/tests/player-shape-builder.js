import { shapeFromMask } from "../src/games/bat-physics.js";

// Offline fit: overlapping inscribed circles preserve the curved, concave alpha outline.
// No pixel reads or fitting are performed during a game.
export function fitPlayerShape(mask) {
  const shape = shapeFromMask(mask),
    candidates = [];
  const px = mask.worldWidth / mask.width,
    py = mask.worldHeight / mask.height;
  for (let y = 1; y < mask.height; y += 3)
    for (let x = 1; x < mask.width; x += 3) {
      if (!mask.alpha[y * mask.width + x]) continue;
      const cx = (x + 0.5) * px - mask.worldWidth / 2 - shape.center.x;
      const cy = (y + 0.5) * py - mask.worldHeight / 2 - shape.center.y;
      let r2 = Infinity;
      for (const [bx, by] of shape.points)
        r2 = Math.min(r2, (cx - bx) ** 2 + (cy - by) ** 2);
      const r = Math.sqrt(r2) - shape.pixelRadius;
      if (r > 1.1) candidates.push({ x: cx, y: cy, r });
    }
  const circles = [candidates.reduce((best, c) => (c.r > best.r ? c : best))];
  const gaps = () =>
    shape.points.map(([x, y]) =>
      Math.min(...circles.map((c) => Math.hypot(x - c.x, y - c.y) - c.r)),
    );
  for (let i = 1; i < 32; i++) {
    const distances = gaps(),
      uncovered = shape.points.filter((p, n) => distances[n] > 0.72);
    if (!uncovered.length) break;
    let best = null,
      score = 0;
    for (const c of candidates) {
      let covered = 0;
      for (const [x, y] of uncovered)
        if ((x - c.x) ** 2 + (y - c.y) ** 2 <= (c.r + 0.72) ** 2) covered++;
      const s = covered * (1 + c.r * 0.001);
      if (s > score) {
        score = s;
        best = c;
      }
    }
    if (!best || !score) break;
    circles.push(best);
  }
  const round = (n) => Math.round(n * 1e4) / 1e4;
  return {
    worldHeight: shape.worldHeight,
    center: shape.center,
    inertia: shape.inertia,
    radius: round(
      Math.max(...circles.map((c) => Math.hypot(c.x, c.y) + c.r)) + 0.35,
    ),
    skin: 0.35,
    maxOutlineGap: round(Math.max(...gaps())),
    circles: circles.map((c) => ({
      x: round(c.x),
      y: round(c.y),
      r: round(c.r),
    })),
  };
}
