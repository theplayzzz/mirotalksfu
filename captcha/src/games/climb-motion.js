import { W, clamp, lerp } from "./kit.js";

const edgeMargin = 48;
const localReference = 92;
const roamingReference = W / 2 - edgeMargin - 58 / 2;

export function climbMotion(progress, intensity = 1) {
  const early = clamp(progress * 3, 0, 1),
    late = clamp((progress - 1 / 3) / (2 / 3), 0, 1),
    width = lerp(100, 66, early) - clamp((progress - 0.5) * 2, 0, 1) * 8;
  return {
    width,
    localAmplitude: lerp(18, 58, early) + 34 * late ** 1.1,
    roamingAmplitude:
      lerp(150, 310, early) + (roamingReference - 310) * late ** 1.1,
    travelSpeed: (lerp(95, 230, early) + 400 * late ** 1.35) * intensity,
  };
}

export function climbPlatformPose(p, progress, clock, width) {
  const motion = climbMotion(progress),
    w = width ?? motion.width;
  if (p.i <= 1) return { x: p.centerX - w / 2, w, amplitude: 0, phase: 0 };
  const roaming = p.motion === "roaming",
    amplitude =
      (roaming ? motion.roamingAmplitude : motion.localAmplitude) *
      (p.rangeScale ?? 1),
    margin = edgeMargin + w / 2,
    center = roaming
      ? W / 2
      : clamp(p.centerX, margin + amplitude, W - margin - amplitude),
    phase =
      (p.phase ?? 0) +
      (clock * (p.motionRate ?? 1)) /
        (roaming ? roamingReference : localReference);
  return {
    x: center - w / 2 + Math.sin(phase) * amplitude,
    w,
    amplitude,
    phase,
  };
}

// Forecast the same integrated travel clock for course generation and aiming.
export function climbClockAfter(clock, elapsed, seconds, duration, intensity) {
  const steps = Math.max(1, Math.ceil(seconds / 0.04)),
    dt = seconds / steps;
  for (let i = 0; i < steps; i++)
    clock +=
      dt *
      climbMotion((elapsed + (i + 0.5) * dt) / duration, intensity).travelSpeed;
  return clock;
}

export function roamingPhase(
  center,
  progress,
  clock,
  rangeScale,
  rate,
  reverse,
) {
  const amplitude = climbMotion(progress).roamingAmplitude * rangeScale,
    angle = Math.asin(clamp((center - W / 2) / amplitude, -0.9, 0.9));
  return (
    (reverse ? Math.PI - angle : angle) - (clock * rate) / roamingReference
  );
}
