import shape from "./projectile-shape.js";
import { UP } from "./mechanics.js";

const scale = 64 / 54,
  ink = shape.points.map(
    ([x, y]) =>
      (Math.cos(UP) * (x + shape.center.x) -
        Math.sin(UP) * (y + shape.center.y)) *
      scale,
  );
export const FLOOR_INK = {
  left: Math.min(...ink) - shape.pixelRadius * scale,
  right: Math.max(...ink) + shape.pixelRadius * scale,
};

// Fit actual visible widths to each gap, including its ends, without entering a facade.
export function gapElements(buildings, groundY) {
  const floor = [],
    inkWidth = FLOOR_INK.right - FLOOR_INK.left,
    midpoint = (FLOOR_INK.left + FLOOR_INK.right) / 2;
  let from = -100;
  for (const b of [
    ...buildings,
    { x: buildings.at(-1).x + buildings.at(-1).w + 1100, w: 0 },
  ]) {
    const width = b.x - from,
      count = Math.max(1, Math.round(width / 37)),
      cell = width / count,
      factor = Math.min(1, (cell - 2) / inkWidth);
    for (let i = 0; i < count; i++)
      floor.push({
        x: from + (i + 0.5) * cell - midpoint * factor,
        y: groundY,
        size: 64 * factor,
        rotation: UP,
      });
    from = b.x + b.w;
  }
  return floor;
}
