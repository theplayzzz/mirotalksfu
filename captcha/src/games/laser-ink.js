import { clamp, distance, lerp } from "./kit.js";
const epsilon = 1e-7;
function piece(line, from, to) {
  const a = {
      x: lerp(line.a.x, line.b.x, from),
      y: lerp(line.a.y, line.b.y, from),
    },
    b = { x: lerp(line.a.x, line.b.x, to), y: lerp(line.a.y, line.b.y, to) };
  return { ...line, a, b, length: distance(a, b) };
}

// Remove only the part inside the impact circle, even for a long unbroken segment.
export function eraseInkCircle(lines, center, radius) {
  return lines.flatMap((line) => {
    const dx = line.b.x - line.a.x,
      dy = line.b.y - line.a.y,
      x = line.a.x - center.x,
      y = line.a.y - center.y,
      a = dx * dx + dy * dy,
      b = 2 * (x * dx + y * dy),
      c = x * x + y * y - radius * radius,
      discriminant = b * b - 4 * a * c;
    if (a < epsilon) return c <= 0 ? [] : [line];
    if (discriminant <= 0) return [line];
    const root = Math.sqrt(discriminant),
      from = clamp((-b - root) / (2 * a), 0, 1),
      to = clamp((-b + root) / (2 * a), 0, 1);
    if (to - from < epsilon) return [line];
    const kept = [];
    if (from > epsilon) kept.push(piece(line, 0, from));
    if (to < 1 - epsilon) kept.push(piece(line, to, 1));
    return kept.filter((l) => l.length > epsilon);
  });
}

// Each gesture has its own eraser. New ink gets the delay; idle time never banks erasing credit.
export function ageLaserInk(
  lines,
  states,
  now,
  { delay = 0.5, speed = 280, activeId = null } = {},
) {
  const queues = new Map(),
    known = new Map(states.map((s) => [s.id, s]));
  for (const line of lines) {
    line.strokeId ??= 0;
    line.bornAt ??= now;
    if (!queues.has(line.strokeId)) queues.set(line.strokeId, []);
    queues.get(line.strokeId).push(line);
    if (!known.has(line.strokeId))
      known.set(line.strokeId, { id: line.strokeId, lastAt: line.bornAt });
  }
  const remaining = [],
    liveStates = [];
  for (const [id, state] of known) {
    const queue = queues.get(id) || [];
    let time = Math.min(state.lastAt, now),
      kept = 0;
    for (let i = 0; i < queue.length; i++) {
      const line = queue[i];
      time = Math.max(time, line.bornAt + delay);
      const removed = Math.max(0, Math.min(line.length, (now - time) * speed));
      if (removed >= line.length - epsilon) {
        time += line.length / speed;
        continue;
      }
      remaining.push(
        removed > epsilon ? piece(line, removed / line.length, 1) : line,
        ...queue.slice(i + 1),
      );
      kept = queue.length - i;
      break;
    }
    state.lastAt = now;
    if (kept || id === activeId) liveStates.push(state);
  }
  return { lines: remaining, states: liveStates };
}
