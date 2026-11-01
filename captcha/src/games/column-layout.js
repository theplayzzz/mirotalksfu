import projectileShape from "./projectile-shape.js";

export const COLUMN_SIZE = 54,
  COLUMN_ROTATION = Math.PI * 1.25;
const points = projectileShape.points.map(([x, y]) => {
  x += projectileShape.center.x;
  y += projectileShape.center.y;
  return {
    x: Math.cos(COLUMN_ROTATION) * x - Math.sin(COLUMN_ROTATION) * y,
    y: -(Math.sin(COLUMN_ROTATION) * x + Math.cos(COLUMN_ROTATION) * y),
  };
});
export const COLUMN_BOUNDS = {
  left: Math.min(...points.map((p) => p.x)) - projectileShape.pixelRadius,
  right: Math.max(...points.map((p) => p.x)) + projectileShape.pixelRadius,
  top: Math.min(...points.map((p) => p.y)) - projectileShape.pixelRadius,
  bottom: Math.max(...points.map((p) => p.y)) + projectileShape.pixelRadius,
};

// Anchor the ink nearest the opening, with at most 40 units of empty outer edge.
// Actual alpha bounds keep the opening clear and avoid overlapping drawings.
export function spacedColumn(
  x,
  y,
  h,
  width = 64,
  anchor = "start",
  options = {},
) {
  if (h <= 0) return [];
  const ink = COLUMN_BOUNDS.bottom - COLUMN_BOUNDS.top;
  const size = COLUMN_SIZE * Math.min(1, h / ink),
    scale = size / COLUMN_SIZE;
  const height = ink * scale;
  let step = options.step ?? 58,
    count = Math.max(1, Math.floor((h - height) / step) + 1);
  if (h - (height + (count - 1) * step) > (options.maxOuterGap ?? 40)) {
    count++;
    step = (h - height) / (count - 1);
  }
  const first =
    anchor === "end"
      ? y + h - COLUMN_BOUNDS.bottom * scale - step * (count - 1)
      : y - COLUMN_BOUNDS.top * scale;
  return Array.from({ length: count }, (_, i) => ({
    x: x + width / 2,
    y: first + step * i,
    size,
    rotation: COLUMN_ROTATION,
    flipY: true,
  }));
}
