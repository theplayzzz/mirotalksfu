import { playerAlpha } from "./player-alpha.js";
import { clamp, lerp } from "./kit.js";

// Lower visible outline of the unrotated, 76px character, in drawing coordinates.
const feet = [];
for (let x = 0; x < playerAlpha.width; x++) {
  let row = playerAlpha.height - 1;
  while (row >= 0 && !playerAlpha.alpha[row * playerAlpha.width + x]) row--;
  if (row < 0) continue;
  const left = (x / playerAlpha.width - 0.5) * playerAlpha.worldWidth,
    right = ((x + 1) / playerAlpha.width - 0.5) * playerAlpha.worldWidth,
    bottom = ((row + 1) / playerAlpha.height - 0.5) * playerAlpha.worldHeight,
    last = feet.at(-1);
  if (last && last.bottom === bottom && Math.abs(last.right - left) < 1e-7)
    last.right = right;
  else feet.push({ left, right, bottom });
}
export const climbFootprint = {
  left: feet[0].left,
  right: feet.at(-1).right,
  width: feet.at(-1).right - feet[0].left,
  bottom: Math.max(...feet.map((p) => p.bottom)),
  minBottom: Math.min(...feet.map((p) => p.bottom)),
  feet,
};

// One-way top surface: sweep the visible feet and the moving platform together.
export function platformLanding(
  from,
  to,
  platform,
  previous,
  minFraction = 0.2,
) {
  const dy = to.y - from.y;
  if (dy <= 0) return null;
  if (
    from.y + climbFootprint.minBottom > platform.y + 1e-8 ||
    to.y + climbFootprint.bottom < platform.y - 1e-8
  )
    return null;
  if (
    Math.max(from.x, to.x) + climbFootprint.right <
      Math.min(previous.x, platform.x) ||
    Math.min(from.x, to.x) + climbFootprint.left >
      Math.max(previous.x + previous.w, platform.x + platform.w)
  )
    return null;
  let first = null;
  for (const foot of feet) {
    const time = (platform.y - from.y - foot.bottom) / dy;
    if (time < -1e-8 || time > 1 + 1e-8) continue;
    const t = clamp(time, 0, 1),
      x = lerp(from.x, to.x, t),
      left = lerp(previous.x, platform.x, t),
      right = lerp(previous.x + previous.w, platform.x + platform.w, t),
      overlap = Math.max(
        0,
        Math.min(x + climbFootprint.right, right) -
          Math.max(x + climbFootprint.left, left),
      );
    if (overlap + 1e-7 < climbFootprint.width * minFraction) continue;
    if (Math.min(x + foot.right, right) - Math.max(x + foot.left, left) <= 1e-8)
      continue;
    if (!first || t < first.t)
      first = {
        t,
        x,
        y: platform.y - foot.bottom,
        fraction: overlap / climbFootprint.width,
        left,
        right,
      };
  }
  return first;
}
