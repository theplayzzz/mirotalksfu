import { projectileAlpha } from "./blade-geometry.js";
import { clamp, angleDelta } from "./kit.js";

export function createShieldGeometry(
  mask = projectileAlpha,
  {
    radius = 94,
    thickness = 10,
    span = 0.79,
    maxPassedFraction = 0.4,
    size = 54,
  } = {},
) {
  // Rotate opaque pixel centers into outward/tangential axes for an incoming ray.
  const points = [],
    inner = radius - thickness / 2,
    outer = radius + thickness / 2;
  const scale = size / mask.worldHeight,
    c = Math.cos(Math.PI * 1.25),
    s = Math.sin(Math.PI * 1.25);
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++) {
      if (!mask.alpha[y * mask.width + x]) continue;
      const px =
          (((x + 0.5) * mask.worldWidth) / mask.width - mask.worldWidth / 2) *
          scale,
        py =
          (((y + 0.5) * mask.worldHeight) / mask.height -
            mask.worldHeight / 2) *
          scale;
      points.push([c * px - s * py, s * px + c * py]);
    }
  const thresholds = points
    .map(([u, v]) => Math.sqrt(inner ** 2 - v ** 2) - u)
    .sort((a, b) => b - a);
  const contactRadius = Math.max(
    ...points.map(([u, v]) => Math.sqrt(outer ** 2 - v ** 2) - u),
  );
  const cutoffRadius =
    thresholds[Math.floor(points.length * maxPassedFraction)];
  function passedFraction(r) {
    let lo = 0,
      hi = thresholds.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (thresholds[mid] > r) lo = mid + 1;
      else hi = mid;
    }
    return lo / thresholds.length;
  }
  function overlaps(r, relativeAngle) {
    const ca = Math.cos(relativeAngle),
      sa = Math.sin(relativeAngle),
      arcCos = Math.cos(span / 2),
      endX = radius * arcCos,
      endY = radius * Math.sin(span / 2),
      half = thickness / 2;
    for (const [u, v] of points) {
      const q = r + u,
        d2 = q * q + v * v;
      if (d2 < inner * inner - 1e-8 || d2 > outer * outer + 1e-8) continue;
      const x = ca * q - sa * v,
        y = sa * q + ca * v;
      if (x >= 0 && x * x >= arcCos * arcCos * d2 - 1e-8) return true;
      if ((x - endX) ** 2 + (Math.abs(y) - endY) ** 2 <= half * half + 1e-8)
        return true;
    }
    return false;
  }
  return {
    radius,
    thickness,
    span,
    maxPassedFraction,
    size,
    contactRadius,
    cutoffRadius,
    passedFraction,
    overlaps,
  };
}

export const shieldGeometry = createShieldGeometry();

// Sweep both the projectile and the mouse-driven arc through a physics step.
export function shieldBlockContact(
  fromRadius,
  toRadius,
  projectileAngle,
  fromAngle,
  toAngle,
  profile = shieldGeometry,
) {
  if (
    toRadius > profile.contactRadius + 1e-8 ||
    fromRadius < profile.cutoffRadius - 1e-8
  )
    return null;
  const dr = fromRadius - toRadius,
    turn = angleDelta(toAngle, fromAngle);
  const start =
      dr > 1e-9 ? clamp((fromRadius - profile.contactRadius) / dr, 0, 1) : 0,
    end = dr > 1e-9 ? clamp((fromRadius - profile.cutoffRadius) / dr, 0, 1) : 1;
  if (start > end) return null;
  const steps = Math.max(
    1,
    Math.ceil(
      (Math.max(Math.abs(dr), profile.radius * Math.abs(turn)) *
        (end - start)) /
        1.5,
    ),
  );
  for (let i = 0; i <= steps; i++) {
    const t = start + ((end - start) * i) / steps,
      r = fromRadius - dr * t;
    if (profile.overlaps(r, projectileAngle - fromAngle - turn * t)) {
      const passedFraction = profile.passedFraction(r);
      if (passedFraction <= profile.maxPassedFraction)
        return { t, radius: r, passedFraction };
    }
  }
  return null;
}
