// Intersect opaque pixel cells in the same size/rotation/reflection as the renderer.
// The broad phase only limits the scan; transparent cells never cause a collision.
function world(mask, pose, x, y) {
  const scale = (pose.size || mask.worldHeight) / mask.worldHeight,
    angle = pose.rotation ?? pose.angle ?? 0,
    c = Math.cos(angle),
    s = Math.sin(angle),
    lx = (x / mask.width - 0.5) * mask.worldWidth,
    ly = (y / mask.height - 0.5) * mask.worldHeight;
  return {
    x: pose.x + scale * (c * lx - s * ly),
    y: pose.y + scale * (s * lx + c * ly) * (pose.flipY ? -1 : 1),
  };
}
function grid(mask, pose, p) {
  const scale = (pose.size || mask.worldHeight) / mask.worldHeight,
    angle = pose.rotation ?? pose.angle ?? 0,
    c = Math.cos(angle),
    s = Math.sin(angle),
    x = (p.x - pose.x) / scale,
    y = ((p.y - pose.y) / scale) * (pose.flipY ? -1 : 1);
  return {
    x: ((c * x + s * y) / mask.worldWidth + 0.5) * mask.width,
    y: ((-s * x + c * y) / mask.worldHeight + 0.5) * mask.height,
  };
}
export function masksOverlap(a, pa, b, pb) {
  if (!a?.alpha || !b?.alpha) return false;
  const corners = [
      [0, 0],
      [b.width, 0],
      [0, b.height],
      [b.width, b.height],
    ].map(([x, y]) => grid(a, pa, world(b, pb, x, y))),
    left = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x)))),
    right = Math.min(
      a.width - 1,
      Math.ceil(Math.max(...corners.map((p) => p.x))) - 1,
    ),
    top = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y)))),
    bottom = Math.min(
      a.height - 1,
      Math.ceil(Math.max(...corners.map((p) => p.y))) - 1,
    );
  if (left > right || top > bottom) return false;
  const origin = grid(b, pb, world(a, pa, 0, 0)),
    oneX = grid(b, pb, world(a, pa, 1, 0)),
    oneY = grid(b, pb, world(a, pa, 0, 1)),
    ux = oneX.x - origin.x,
    uy = oneX.y - origin.y,
    vx = oneY.x - origin.x,
    vy = oneY.y - origin.y,
    hx = (ux + vx) / 2,
    hy = (uy + vy) / 2,
    halfX = (Math.abs(ux) + Math.abs(vx)) / 2,
    halfY = (Math.abs(uy) + Math.abs(vy)) / 2,
    axes = [
      [-uy, ux],
      [-vy, vx],
    ].map(([x, y]) => ({
      x,
      y,
      r:
        (Math.abs(ux * x + uy * y) +
          Math.abs(vx * x + vy * y) +
          Math.abs(x) +
          Math.abs(y)) /
        2,
    }));
  for (let y = top; y <= bottom; y++)
    for (let x = left; x <= right; x++) {
      if (!a.alpha[y * a.width + x]) continue;
      const cx = origin.x + ux * x + vx * y + hx,
        cy = origin.y + uy * x + vy * y + hy,
        x0 = Math.max(0, Math.floor(cx - halfX)),
        x1 = Math.min(b.width - 1, Math.ceil(cx + halfX) - 1),
        y0 = Math.max(0, Math.floor(cy - halfY)),
        y1 = Math.min(b.height - 1, Math.ceil(cy + halfY) - 1);
      for (let yy = y0; yy <= y1; yy++)
        for (let xx = x0; xx <= x1; xx++) {
          if (!b.alpha[yy * b.width + xx]) continue;
          const dx = xx + 0.5 - cx,
            dy = yy + 0.5 - cy;
          if (axes.every((n) => Math.abs(dx * n.x + dy * n.y) < n.r - 1e-10))
            return true;
        }
    }
  return false;
}
