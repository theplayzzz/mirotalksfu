import { challenges } from "../src/games/index.js";
import { seeded, clamp, lerp, distance, angleDelta } from "../src/games/kit.js";
import { COLUMN_BOUNDS } from "../src/games/column-layout.js";
import { orientedSpriteHitsCircle } from "../src/collision.js";
import { projectileRotation } from "../src/engine.js";
import { projectileAlpha } from "../src/games/blade-geometry.js";
import {
  climbClockAfter,
  climbPlatformPose,
} from "../src/games/climb-motion.js";
import { climbFootprint } from "../src/games/platform-contact.js";
import webRoutes from "./fixtures/web-mouse-routes.json" with { type: "json" };
import {
  makePlayer,
  playerExtents,
  stepRoofBody,
  roofEquilibrium,
  playerCircles,
} from "../src/games/roof-physics.js";
export const tap = (g, x = g.input.x, y = g.input.y) => {
  g.move(x, y);
  g.press();
  g.release();
};
export function climbAim(g) {
  const p = g.platforms.filter((p) => !p.used).toSorted((a, b) => a.i - b.i)[0];
  if (!p) return g.player.x;
  const discriminant =
      g.vy ** 2 - 2480 * (g.player.y + climbFootprint.bottom - p.y),
    time = Math.max(
      0.02,
      (-g.vy + Math.sqrt(Math.max(0, discriminant))) / 1240,
    ),
    clock = climbClockAfter(
      g.platformClock,
      g.elapsed,
      time,
      g.duration,
      g.intensity,
    ),
    pose = climbPlatformPose(p, (g.elapsed + time) / g.duration, clock),
    center = pose.x + pose.w / 2,
    decay = Math.exp(-time / g.movementLag);
  // Intercept the future landing surface, rather than chasing its old position.
  return clamp((center - g.player.x * decay) / (1 - decay), 32, 928);
}
export function webControl(g, hz = 120) {
  // Recorded mouse gestures for the mixed course. Each fixture is replayed
  // against the live physics, including collisions, floor contacts and timing.
  const route = webRoutes[`${g.duration}:${hz}`];
  if (route) {
    const event = route[g.shotsFired * 2 - (g.input.down ? 1 : 0)];
    if (!event || g.elapsed < event.at - 1e-8) return null;
    return event.release
      ? { release: true }
      : { x: g.player.x + event.ahead - g.cameraX, y: 0 };
  }
  const p = g.player;
  if (g.rope && p.x > g.rope.x + 60 && p.vx > 80 && p.vy < 0)
    return { release: true };
  if (g.input.down || g.rope || g.shot) return null;
  const desired = p.x + 225;
  const target = g.blocks
    .map((b) => ({ b, x: clamp(desired, b.x + 8, b.x + b.w - 8) }))
    .filter((t) => t.x > p.x + 50 && t.x - g.cameraX < 930)
    .sort((a, b) => Math.abs(a.x - desired) - Math.abs(b.x - desired))[0];
  return target
    ? { x: target.x - g.cameraX, y: target.b.y + target.b.h }
    : null;
}
const hold = (g, on) => {
  if (on && !g.input.down) g.press();
  if (!on && g.input.down) g.release();
};
export function gravityDirection(g) {
  // Development snapshots copy fields, so inherited getters are not serialized.
  const speed =
    g.speed ??
    lerp(340, 600, clamp((g.elapsed / g.duration) * 2, 0, 1)) * g.intensity;
  const lead = clamp((speed - 340) / 2500, -0.04, 0.04);
  const gates = g.gates.filter((b) => !b.passed).toSorted((a, b) => a.x - b.x);
  let gate = gates[0];
  if (
    gate?.weaveIndex >= 0 &&
    gate.weaveIndex < gate.weaveCount - 1 &&
    gate.x <= g.player.x - g.spriteBounds.left + g.playerRadius + speed * lead
  ) {
    const next = gates.find(
      (b) => b.pattern === gate.pattern && b.weaveIndex === gate.weaveIndex + 1,
    );
    if (next) gate = next;
  }
  return gate ? (gate.top ? 1 : -1) : g.gravity;
}
export function jetThrust(g) {
  const gate = g.gates
    .filter((b) => b.x + 32 + COLUMN_BOUNDS.right > g.player.x - 19)
    .toSorted((a, b) => a.x - b.x)[0];
  return g.player.y + g.vy * 0.19 > (gate?.gap ?? 270);
}
export function juggleClick(g) {
  const nearest = g.balls.toSorted(
    (a, b) => distance(a, g.player) - distance(b, g.player),
  )[0];
  if (!nearest || distance(nearest, g.player) >= 170) return null;
  const candidates = [
    nearest,
    ...g.balls
      .filter((b) => b !== nearest && distance(b, nearest) < 95)
      .map((b) => ({ x: (b.x + nearest.x) / 2, y: (b.y + nearest.y) / 2 })),
  ];
  let best = nearest,
    bestCount = 0;
  for (const p of candidates) {
    const affected = g.balls.filter((b) =>
      orientedSpriteHitsCircle(
        projectileAlpha,
        b,
        projectileRotation(b, g.player),
        p,
        g.clickRadius,
      ),
    );
    if (!affected.includes(nearest) || affected.length <= bestCount) continue;
    best = p;
    bestCount = affected.length;
  }
  return { x: best.x, y: best.y };
}
export function shelterPlan(g) {
  const r = 132;
  const eta = (b) => (distance(b, g.player) - r - 31) / b.speed;
  const threats = g.drops
    .filter((b) => !b.reflected && !b.gone)
    .toSorted((a, b) => eta(a) - eta(b));
  for (const b of threats) {
    const approach = eta(b);
    if (approach > 0.35) continue;
    const a = Math.atan2(b.y - g.player.y, b.x - g.player.x);
    const mid = {
      x: g.player.x + Math.cos(a) * r,
      y: g.player.y + Math.sin(a) * r,
    };
    if (
      g.lines.some(
        (l) =>
          l.bornAt + g.laserDelay - g.elapsed > approach + 0.05 &&
          distance({ x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }, mid) <
            20,
      )
    )
      continue;
    const points = Array.from({ length: 7 }, (_, i) => ({
      x: g.player.x + Math.cos(a - 0.24 + i * 0.08) * r,
      y: g.player.y + Math.sin(a - 0.24 + i * 0.08) * r,
    }));
    const cost = points
      .slice(1)
      .reduce((sum, p, i) => sum + distance(p, points[i]), 0);
    if (g.ink < cost + 1) continue;
    return { points };
  }
  return null;
}
export function launchPlan(g) {
  const angle = g.anchorAngle ?? 0,
    gainX = g.launchX ?? 5.25,
    gainY = g.launchY ?? 5.7,
    landingY = g.target.y - playerExtents(angle).bottom;
  let best = null,
    bestTime = Infinity;
  for (const vy of [
    -600, -620, -640, -660, -680, -560, -580, -700, -520, -540, -720, -500,
    -480, -740, -760,
  ]) {
    const disc = vy * vy + 1900 * (landingY - g.anchor.y);
    if (disc < 0) continue;
    const time = (-vy + Math.sqrt(disc)) / 950;
    for (const offset of [
      -0.34, -0.42, -0.27, -0.15, -0.48, 0, 0.15, 0.3, -0.6, -0.65,
    ]) {
      const vx =
        (g.target.x + g.target.w / 2 + offset * g.target.w - g.anchor.x) /
        (time - 0.28 / gainX);
      const pull = { x: -vx / gainX, y: -vy / gainY };
      if (
        Math.hypot(pull.x, pull.y) > 139 ||
        g.anchor.x - (g.cameraX || 0) + pull.x < 18 ||
        g.anchor.y + pull.y > 522
      )
        continue;
      const b = makePlayer(g.anchor.x + pull.x * 0.28, g.anchor.y, angle);
      b.vx = vx;
      b.vy = vy;
      let rest = 0;
      for (let t = 0; t < Math.min(6, bestTime); t += 1 / 120) {
        stepRoofBody(b, g.buildings, 1 / 120);
        const roof = roofEquilibrium(b, g.buildings);
        if (
          roof?.id === g.target.id &&
          Math.hypot(b.vx, b.vy) < 18 &&
          Math.abs(b.omega) < 0.5
        )
          rest += 1 / 120;
        else rest = 0;
        if (
          rest > 0.3 &&
          b.cx > g.target.x + 14 &&
          b.cx < g.target.x + g.target.w - 14
        ) {
          if (t < 2.8) return pull;
          best = pull;
          bestTime = t;
          break;
        }
        if (playerCircles(b).some((c) => c.y + c.r >= g.groundY)) break;
      }
    }
  }
  return best;
}
export function slashPlan(g) {
  const remaining = (b) =>
      Number.isFinite(b.arrival)
        ? b.arrival - g.elapsed
        : distance(b, g.player) / Math.max(1, Math.hypot(b.vx || 0, b.vy || 0)),
    live = g.targets
      .filter(
        (b) =>
          !b.cut && !b.gone && b.x > 4 && b.x < 956 && b.y > 4 && b.y < 536,
      )
      .toSorted((a, b) => remaining(a) - remaining(b)),
    first = live[0];
  if (!first || remaining(first) > 0.4) return null;
  const group = live.filter(
      (b) => b === first || (remaining(b) <= 0.55 && distance(b, first) < 220),
    ),
    points = [
      { x: first.x - 14, y: first.y },
      { x: first.x + 14, y: first.y },
    ];
  for (const b of group) {
    if (b === first) continue;
    const p = { x: b.x, y: b.y },
      extra = distance(points.at(-1), p);
    if (extra > 70) continue;
    points.push(p);
  }
  return { points };
}

export function orbitDirection(g) {
  const dt = 0.04;
  let beam = [{ angle: g.angle, dir: g.dir, first: g.dir, cost: 0, min: 999 }];
  for (let depth = 0; depth < Math.ceil(1.44 / (dt * 3)); depth++) {
    const nodes = [];
    for (const n of beam)
      for (const dir of [n.dir, -n.dir]) {
        let angle = n.angle,
          cost = n.cost + (dir !== n.dir ? 0.08 : 0),
          min = n.min;
        for (let j = 1; j <= 3; j++) {
          const time = depth * dt * 3 + j * dt;
          angle +=
            dir *
            lerp(
              1.85,
              2.55,
              clamp(((g.elapsed + time - dt / 2) / g.duration) * 2, 0, 1),
            ) *
            dt;
          const p = {
            x: g.center.x + Math.cos(angle) * g.radius,
            y: g.center.y + Math.sin(angle) * g.radius,
          };
          for (const b of g.attacks) {
            if (time < b.wait) continue;
            const age = Math.max(0, time - Math.max(0, b.wait)),
              d = distance(p, { x: b.x + b.vx * age, y: b.y + b.vy * age });
            min = Math.min(min, d);
            if (d < g.contactRadius - g.radius + 1) cost += 1e6;
            cost += Math.max(0, 82 - d) ** 2 * 0.003;
          }
        }
        nodes.push({
          angle,
          dir,
          first: depth === 0 ? dir : n.first,
          cost,
          min,
        });
      }
    beam = nodes.sort((a, b) => a.cost - b.cost || b.min - a.min).slice(0, 48);
  }
  return beam[0].first;
}
export function rhythmControl(g, inputLatency = 0) {
  const threat = (b) => {
    const dx = b.cx - g.player.x,
      dy = b.cy - g.player.y,
      d = Math.hypot(dx, dy) || 1,
      closing = -(b.vx * dx + b.vy * dy) / d;
    if (b.ejected && closing <= 0) return Infinity;
    return !b.free ? b.arrival - g.elapsed : (d - 55) / Math.max(80, closing);
  };
  const b = g.shots
    .filter((b) => !b.gone && Number.isFinite(threat(b)))
    .toSorted((a, b) => threat(a) - threat(b))[0];
  if (!b) return { x: 280, y: g.player.y, click: false };
  // Follow the mass center, not the center of the transparent artwork.
  const lead = !b.free ? b.arrival - g.elapsed : 0.1 + inputLatency,
    p = { x: b.cx + b.vx * lead, y: b.cy + b.vy * lead };
  return {
    x: clamp(p.x - 55, 0, 960),
    // Aim the middle of the barrel at the future contact, accounting for its
    // downward arc during a click. Rapid cursor motion alone no longer saves it.
    y: clamp(p.y - 25, 0, 540),
    click:
      !g.queuedSwing &&
      g.elapsed + inputLatency >= g.cooldownUntil &&
      (!b.free
        ? b.arrival - g.elapsed <= 0.16 + inputLatency
        : distance({ x: b.cx, y: b.cy }, g.player) < 320),
  };
}
export const bots = {
  rain(g) {
    const r = g.rows.filter((r) => r.y < 497).toSorted((a, b) => b.y - a.y)[0];
    if (r) g.move(r.gap, 458);
  },
  orbit(g) {
    if (g.elapsed < (g.nextDecision || 0)) return;
    g.nextDecision = g.elapsed + 0.018;
    if (orbitDirection(g) !== g.dir) tap(g);
  },
  paddle(g) {
    const b = g.attacks
      .filter((b) => !b.checked && !b.reflected)
      .toSorted((a, b) => a.arrival - b.arrival)[0];
    if (b)
      g.move(
        g.player.x + Math.cos(b.angle) * 190,
        g.player.y + Math.sin(b.angle) * 190,
      );
  },
  rhythm(g) {
    const p = rhythmControl(g);
    g.move(p.x, p.y);
    if (p.click) tap(g, p.x, p.y);
  },
  gravity(g) {
    if (g.gravity !== gravityDirection(g)) tap(g, g.player.x, g.player.y);
  },
  jet(g) {
    hold(g, jetThrust(g));
  },
  shelter(g) {
    let p = shelterPlan(g);
    if (p?.erase) {
      g.move(p.erase.x, p.erase.y);
      g.secondary();
      p = shelterPlan(g);
    }
    if (!p || p.erase) return;
    g.move(p.points[0].x, p.points[0].y);
    g.press();
    for (const point of p.points.slice(1)) g.move(point.x, point.y);
    g.release();
  },
  stretch(g) {
    if (g.phase !== "aim") return;
    const p = launchPlan(g);
    if (!p) return;
    g.move(g.anchor.x - g.cameraX, g.anchor.y);
    g.press();
    g.move(g.anchor.x - g.cameraX + p.x, g.anchor.y + p.y);
    g.release();
  },
  slash(g) {
    const plan = slashPlan(g);
    if (!plan) return;
    g.move(plan.points[0].x, plan.points[0].y);
    g.press();
    for (const p of plan.points.slice(1)) g.move(p.x, p.y);
    g.release();
  },
  thunder(g) {
    if (g.safePocket) g.move(g.safePocket.x, g.safePocket.y);
  },
  juggle(g) {
    const b = g.balls.toSorted(
      (a, b) => distance(a, g.player) - distance(b, g.player),
    )[0];
    if (
      b &&
      distance(b, g.player) < 155 &&
      g.elapsed - (g.lastAction || -1) > 0.12
    ) {
      tap(g, b.x, b.y);
      g.lastAction = g.elapsed;
    }
  },
  climb(g) {
    g.move(climbAim(g), 300);
  },
  web(g, hz = 120) {
    const action = webControl(g, hz);
    if (action?.release) g.release();
    else if (action) {
      g.move(action.x, action.y);
      g.press();
    }
  },
};
export function play(id, { seed = 3, duration = 25, intensity = 0.9 } = {}) {
  const g = new challenges[id]({ random: seeded(seed), duration, intensity });
  for (let i = 0; i < duration * 120 + 5 && !g.finished; i++) {
    bots[id](g);
    g.step(1 / 120);
  }
  return g;
}
