import {
  Challenge,
  W,
  H,
  clamp,
  lerp,
  distance,
  angleDelta,
  segmentDistance,
} from "./kit.js";
import {
  TAU,
  pace,
  pressure,
  follow,
  incoming,
  advance,
  outside,
  strokeHit,
} from "./mechanics.js";
import { spacedColumn } from "./column-layout.js";
import { canvasPath } from "./canvas-path.js";
import projectileShape from "./projectile-shape.js";
import { ageLaserInk, eraseInkCircle } from "./laser-ink.js";
import { masksOverlap } from "../mask-overlap.js";
import { playerAlpha } from "./player-alpha.js";
import { projectileAlpha } from "./blade-geometry.js";
const orbitProjectileExtent =
  Math.max(
    ...projectileShape.points.map(([x, y]) =>
      Math.hypot(x + projectileShape.center.x, y + projectileShape.center.y),
    ),
  ) + projectileShape.pixelRadius;

export class Rain extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: 480, y: 458 };
    this.input.x = 480;
    this.rows = [];
    this.next = 0.15;
    this.gap = 480;
    this.lastGaps = [320, 640];
    this.serial = 0;
    this.hint =
      "Movimento com inércia leve. Leia as aberturas antes de chegar.";
  }
  get speed() {
    return lerp(265, 650, pace(this)) * this.intensity;
  }
  spawnRow() {
    const previous = this.lastGaps,
      reach = 220;
    let centers = [...previous];
    for (let attempt = 0; attempt < 160; attempt++) {
      const candidate = [this.rand(90, 870), this.rand(90, 870)].sort(
        (a, b) => a - b,
      );
      if (candidate[1] - candidate[0] < 230) continue;
      if (
        !previous.every((x) => candidate.some((y) => Math.abs(x - y) <= reach))
      )
        continue;
      if (
        !candidate.every((x) => previous.some((y) => Math.abs(x - y) <= reach))
      )
        continue;
      if (
        candidate.some(
          (x) => Math.min(...previous.map((y) => Math.abs(x - y))) < 70,
        )
      )
        continue;
      centers = candidate;
      break;
    }
    const width = lerp(94, 82, pace(this)) - pressure(this) * 4;
    const gaps = centers.map((x) => {
      const w = clamp(width + this.rand(-2, 2), 78, 96);
      return {
        x,
        width: w,
        left: x - w / 2,
        right: x + w / 2,
        safeLeft: x - w / 2 + 32,
        safeRight: x + w / 2 - 32,
      };
    });
    const row = {
      id: ++this.serial,
      y: -54,
      spawnedAt: this.elapsed,
      gap: gaps[0].x,
      width: gaps[0].width,
      gaps,
      parts: [],
    };
    const add = (x, size, boundary = false) => {
      const radius = Math.hypot(size * 0.8, size) / 2;
      if (
        x < 0 ||
        x > W ||
        gaps.some((g) => x + radius > g.left && x - radius < g.right)
      )
        return;
      if (row.parts.some((b) => Math.abs(b.x - x) < 17)) return;
      row.parts.push({ x, y: row.y + this.rand(-16, 16), size, boundary });
    };
    // Full rotated artwork bounds stay outside both corridors, not just their centers.
    const boundaryRadius = Math.hypot(54 * 0.8, 54) / 2;
    for (const g of gaps) {
      add(g.left - boundaryRadius - 2, 54, true);
      add(g.right + boundaryRadius + 2, 54, true);
    }
    for (let x = 23; x < 955; x += 36)
      add(clamp(x + this.rand(-5, 5), 15, 945), this.rand(49, 55));
    this.rows.push(row);
    this.lastGaps = centers;
    this.gap = row.gap;
    return row;
  }
  update(dt) {
    follow(
      this.player,
      { x: clamp(this.axis(850, dt), 32, W - 32), y: 458 },
      dt,
      0.09,
      1100,
    );
    if (this.elapsed >= this.next) {
      this.spawnRow();
      this.next =
        this.elapsed +
        (lerp(1.22, 0.76, pace(this)) * (1 - 0.25 * pressure(this))) /
          this.intensity;
    }
    this.kibes = [];
    for (const row of this.rows) {
      const fall =
        this.speed * Math.max(0, Math.min(dt, this.elapsed - row.spawnedAt));
      row.y += fall;
      for (const b of row.parts) {
        b.y += fall;
        this.kibes.push(b);
        if (this.hits(b, this.player, 20))
          this.fail("A chuva alcançou o emoji.");
      }
    }
    this.rows = this.rows.filter((r) => r.y < 610);
  }
  draw(v) {
    v.rect(20, 492, 920, 3, "#8e7a9e");
    for (const r of this.rows)
      if (r.y < 72) for (const g of r.gaps) v.text("↓", g.x, 22, 22, "#b8edcf");
    this.kibes.forEach((b) => v.enemy(b, this.player, b.size));
    v.player(this.player, 76);
  }
}

export class Orbit extends Challenge {
  constructor(o) {
    super(o);
    this.center = { x: W / 2, y: H / 2 };
    this.radius = 164;
    this.projectileSize = 52;
    this.playerCollisionRadius = 20;
    this.contactRadius =
      this.radius +
      this.playerCollisionRadius +
      (orbitProjectileExtent * this.projectileSize) /
        projectileShape.worldHeight;
    this.angle = -Math.PI / 2;
    this.dir = 1;
    this.attacks = [];
    this.next = 0.32;
    this.salvos = 0;
    this.place();
    this.hint =
      "Clique para inverter. Ataques vêm das paredes laterais e atravessam a órbita.";
  }
  get speed() {
    // Reference horizontal speed. Every ray has its own distance-adjusted velocity.
    return (W / 2 - this.contactRadius) / this.flightTime;
  }
  get flightTime() {
    return lerp(1.1, 0.55, pace(this)) / Math.sqrt(this.intensity);
  }
  attackSource() {
    return { x: this.random() < 0.5 ? 0 : W, y: this.rand(1, H - 1) };
  }
  spawnAttack(
    origin = this.attackSource(),
    targetAngle = this.rand(0, TAU),
    delay = 0,
  ) {
    const source = {
        x: origin.x < W / 2 ? 0 : W,
        y: clamp(origin.y, 1, H - 1),
      },
      target = {
        x: this.center.x + Math.cos(targetAngle) * this.radius,
        y: this.center.y + Math.sin(targetAngle) * this.radius,
      },
      d = distance(source, target),
      dx = (target.x - source.x) / d,
      dy = (target.y - source.y) / d,
      ox = source.x - this.center.x,
      oy = source.y - this.center.y,
      along = -(ox * dx + oy * dy),
      cross = ox * dy - oy * dx,
      travelDistance =
        along - Math.sqrt(Math.max(0, this.contactRadius ** 2 - cross ** 2)),
      travelTime = this.flightTime,
      speed = travelDistance / travelTime,
      exit = canvasPath(source, Math.atan2(dy, dx)).b;
    const b = {
      ...source,
      source,
      aim: target,
      exit,
      contact: {
        x: source.x + dx * travelDistance,
        y: source.y + dy * travelDistance,
      },
      travelDistance,
      travelTime,
      speed,
      vx: dx * speed,
      vy: dy * speed,
      rotation: Math.atan2(dy, dx) + Math.PI / 4,
      spawnedAt: this.elapsed,
      launchAt: this.elapsed + delay,
      launchedAt: null,
      arrival: this.elapsed + delay + travelTime,
      wait: delay,
      age: 0,
      size: this.projectileSize,
    };
    this.attacks.push(b);
    return b;
  }
  place() {
    this.player = {
      x: this.center.x + Math.cos(this.angle) * this.radius,
      y: this.center.y + Math.sin(this.angle) * this.radius,
    };
  }
  press() {
    super.press();
    this.dir *= -1;
  }
  update(dt) {
    this.angularSpeed = lerp(1.85, 2.55, pace(this));
    this.angle += this.dir * this.angularSpeed * dt;
    this.place();
    if (this.elapsed >= this.next) {
      // Keep one nearby arc free of the new salvo. Existing trajectories determine
      // which candidate is safest; the player still has to read and reach it.
      let best = -Infinity;
      for (let n = -6; n <= 6; n++) {
        const a = this.angle + n * 0.1,
          p = {
            x: this.center.x + Math.cos(a) * this.radius,
            y: this.center.y + Math.sin(a) * this.radius,
          };
        let clearance = 300;
        for (const b of this.attacks)
          for (let t = 0.2; t <= 1.1; t += 0.15) {
            if (t < b.wait) continue;
            const age = Math.max(0, t - Math.max(0, b.wait));
            clearance = Math.min(
              clearance,
              distance(p, { x: b.x + b.vx * age, y: b.y + b.vy * age }),
            );
          }
        clearance -= Math.abs(n) * 0.2;
        if (clearance > best) {
          best = clearance;
          this.escapeAngle = a;
        }
      }
      const escape = {
        x: this.center.x + Math.cos(this.escapeAngle) * this.radius,
        y: this.center.y + Math.sin(this.escapeAngle) * this.radius,
      };
      const count =
        2 + Math.floor(pace(this) * 2) + Math.floor(pressure(this) * 2);
      for (let i = 0; i < count; i++) {
        let source,
          targetAngle,
          accepted = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          source = this.attackSource();
          targetAngle =
            i < 2 && attempt < 20
              ? this.angle +
                this.dir * this.rand(0.1, 0.8) +
                this.rand(-0.65, 0.65)
              : this.rand(0, TAU);
          const target = {
              x: this.center.x + Math.cos(targetAngle) * this.radius,
              y: this.center.y + Math.sin(targetAngle) * this.radius,
            },
            end = canvasPath(
              source,
              Math.atan2(target.y - source.y, target.x - source.x),
            ).b;
          if (segmentDistance(escape, source, end) > 60) {
            accepted = true;
            break;
          }
        }
        if (accepted)
          this.spawnAttack(
            source,
            targetAngle,
            lerp(0.48, 0.22, pace(this)) + i * 0.045,
          );
      }
      this.salvos++;
      this.next =
        this.elapsed +
        (lerp(1.04, 0.54, pace(this)) * (1 - 0.32 * pressure(this))) /
          this.intensity;
    }
    for (const b of this.attacks) {
      b.wait = Math.max(0, b.launchAt - this.elapsed);
      if (b.wait > 0) continue;
      if (b.launchedAt === null) {
        b.launchedAt = this.elapsed;
        b.arrival = b.launchedAt + b.travelTime;
      }
      b.age = this.elapsed - b.launchedAt;
      b.x = b.source.x + b.vx * b.age;
      b.y = b.source.y + b.vy * b.age;
      if (this.hits(b, this.player, this.playerCollisionRadius))
        this.fail("Um dos ataques cruzou sua órbita.");
    }
    this.attacks = this.attacks.filter((b) => b.wait > 0 || !outside(b));
    this.kibes = this.attacks;
  }
  draw(v) {
    v.circle(this.center.x, this.center.y, this.radius, null, "#877296");
    v.circle(this.center.x, this.center.y, 76, "#b19ac80b");
    v.text(
      this.dir > 0 ? "↻" : "↺",
      this.center.x,
      this.center.y + 17,
      62,
      "#b19ac8",
    );
    this.attacks.forEach((b) => {
      if (b.wait > 0) v.line(b.source, b.exit, "#ffad8c35", 1.5);
      else v.enemy(b, b.aim, b.size);
    });
    v.player(this.player, 76);
  }
}

export { Gravity } from "./gravity-game.js";

export class Jet extends Challenge {
  constructor(o = {}) {
    super(o);
    this.track = { top: 0, bottom: H };
    this.limits = { top: 36, bottom: H - 36 };
    this.player = { x: 220, y: H / 2 };
    this.vy = 0;
    this.bodyHit =
      o.bodyHit || ((b, p) => masksOverlap(projectileAlpha, b, playerAlpha, p));
    this.serial = 0;
    this.gates = [this.createGate(640, 270), this.createGate(1110, 330)];
    this.hint = "Segure para subir; solte para cair. Teto e chão são seguros.";
    this.refreshColumns();
  }
  get speed() {
    return lerp(400, 720, pace(this)) * this.intensity;
  }
  get opening() {
    return lerp(150, 112, pace(this)) - pressure(this) * 20;
  }
  createGate(x, gap) {
    const gapSize = this.opening,
      top = gap - gapSize / 2,
      bottom = gap + gapSize / 2;
    return {
      id: ++this.serial,
      x,
      gap,
      gapSize,
      parts: [
        ...spacedColumn(0, this.track.top, top - this.track.top, 64, "end", {
          step: 44,
          maxOuterGap: 32,
        }).map((p) => ({
          ...p,
          side: "top",
        })),
        ...spacedColumn(0, bottom, this.track.bottom - bottom, 64, "start", {
          step: 44,
          maxOuterGap: 32,
        }).map((p) => ({
          ...p,
          side: "bottom",
        })),
      ],
    };
  }
  nextGap(previous) {
    let delta = this.rand(44, 96) * (this.random() < 0.5 ? -1 : 1);
    if (previous + delta < H / 2 - 93 || previous + delta > H / 2 + 93)
      delta = -delta;
    return clamp(previous + delta, H / 2 - 93, H / 2 + 93);
  }
  refreshColumns() {
    this.gapSize = this.opening;
    this.kibes = this.gates.flatMap((g) =>
      g.parts.map((p) => ({ ...p, x: g.x + p.x, gateId: g.id })),
    );
  }
  update(dt) {
    this.vy = clamp(this.vy + (this.input.down ? -1130 : 900) * dt, -365, 365);
    this.player.y = clamp(
      this.player.y + this.vy * dt,
      this.limits.top,
      this.limits.bottom,
    );
    if (
      this.player.y === this.limits.top ||
      this.player.y === this.limits.bottom
    )
      this.vy = 0;
    for (const g of this.gates) g.x -= this.speed * dt;
    const last = this.gates.at(-1),
      spacing =
        (this.speed *
          lerp(1.12, 0.84, pace(this)) *
          (1 - 0.16 * pressure(this))) /
        this.intensity;
    if (last.x < 1000)
      this.gates.push(
        this.createGate(
          Math.max(1010, last.x + Math.max(spacing, this.speed * 0.74)),
          this.nextGap(last.gap),
        ),
      );
    this.gates = this.gates.filter((g) => g.x > -100);
    this.refreshColumns();
    for (const b of this.kibes)
      if (
        this.bodyHit(b, { ...this.player, size: 76, angle: this.vy * 0.0006 })
      )
        this.fail("O emoji tocou em uma coluna de projéteis.");
  }
  draw(v) {
    v.line(
      { x: 0, y: this.track.top },
      { x: W, y: this.track.top },
      "#8e7a9e",
      3,
    );
    v.line(
      { x: 0, y: this.track.bottom },
      { x: W, y: this.track.bottom },
      "#8e7a9e",
      3,
    );
    this.kibes.forEach((b) => v.enemy(b, this.player));
    if (this.input.down) v.text("↑", 220, this.player.y + 62, 23, "#b8edcf");
    v.player(this.player, 76, this.vy * 0.0006);
  }
}

export class Shelter extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: W / 2, y: H / 2 };
    this.maxLives = this.lives = 3;
    // Keep the existing approach speeds; this reference does not limit drawing.
    this.contactRadius = 133;
    this.maxInk = 420;
    this.ink = this.maxInk;
    this.laserDelay = 0.5;
    this.laserSpeed = 280;
    this.strokes = [];
    this.strokeSerial = 0;
    this.activeStrokeId = null;
    this.lines = [];
    this.drops = [];
    this.dropSerial = 0;
    this.volleySerial = 0;
    this.lastPoint = null;
    this.next = 0.45;
    this.hint =
      "Desenhe onde quiser. O laser apaga na ordem do traço e devolve a tinta.";
  }
  get speed() {
    return (W / 2 - this.contactRadius) / this.flightTime;
  }
  get flightTime() {
    return lerp(1.8, 0.85, pace(this)) / Math.sqrt(this.intensity);
  }
  get volleySize() {
    return this.progress < 0.2 ? 2 : this.progress < 0.5 ? 4 : 8;
  }
  get spawnInterval() {
    return (
      (lerp(0.9, 0.6, pace(this)) * (1 - 0.15 * pressure(this))) /
      this.intensity
    );
  }
  spawnVolley() {
    this.volleySerial++;
    // Independent directions keep the original distribution. Density depends
    // only on time and intensity, never on ink or the player's drawing.
    return Array.from({ length: this.volleySize }, () => this.spawnDrop());
  }
  spawnDrop(angle = this.rand(0, TAU)) {
    const dx = Math.cos(angle),
      dy = Math.sin(angle),
      p = this.player;
    const tx = Math.abs(dx) < 1e-10 ? Infinity : (dx > 0 ? W - p.x : -p.x) / dx;
    const ty = Math.abs(dy) < 1e-10 ? Infinity : (dy > 0 ? H - p.y : -p.y) / dy;
    const d = Math.min(tx, ty);
    const source = {
      x: tx <= ty ? (dx > 0 ? W : 0) : clamp(p.x + dx * d, 0, W),
      y: ty <= tx ? (dy > 0 ? H : 0) : clamp(p.y + dy * d, 0, H),
    };
    const startRadius = distance(source, p),
      travelTime = this.flightTime;
    const speed = (startRadius - this.contactRadius) / travelTime;
    const b = {
      id: ++this.dropSerial,
      volleyId: this.volleySerial,
      ...source,
      source,
      angle,
      startRadius,
      radius: startRadius,
      speed,
      travelTime,
      spawnedAt: this.elapsed,
      arrival: this.elapsed + travelTime,
      vx: -dx * speed,
      vy: -dy * speed,
      size: 54,
      age: 0,
    };
    this.drops.push(b);
    this.next = this.elapsed + this.spawnInterval;
    return b;
  }
  move(x, y) {
    super.move(x, y);
    if (!this.input.down) return;
    const p = { x: this.input.x, y: this.input.y };
    if (!this.lastPoint) {
      this.lastPoint = p;
      return;
    }
    const a = this.lastPoint,
      d = distance(a, p);
    if (d < 0.5) return;
    this.lastPoint = p;
    const length = Math.min(d, this.ink),
      n = Math.ceil(length / 10);
    if (length < 0.5) return;
    for (let i = 0; i < n; i++) {
      const aa = {
          x: lerp(a.x, p.x, ((i / n) * length) / d),
          y: lerp(a.y, p.y, ((i / n) * length) / d),
        },
        b = {
          x: lerp(a.x, p.x, (((i + 1) / n) * length) / d),
          y: lerp(a.y, p.y, (((i + 1) / n) * length) / d),
        };
      this.lines.push({
        a: aa,
        b,
        length: distance(aa, b),
        strokeId: this.activeStrokeId,
        bornAt: this.elapsed,
      });
    }
    this.syncInk();
  }
  syncInk() {
    this.lines = this.lines.filter((l) => l.length > 1e-7);
    this.ink = clamp(
      this.maxInk - this.lines.reduce((s, l) => s + l.length, 0),
      0,
      this.maxInk,
    );
    const ids = new Set(this.lines.map((l) => l.strokeId ?? 0));
    this.strokes = this.strokes.filter(
      (s) => ids.has(s.id) || s.id === this.activeStrokeId,
    );
  }
  press() {
    super.press();
    this.activeStrokeId = ++this.strokeSerial;
    this.strokes.push({ id: this.activeStrokeId, lastAt: this.elapsed });
    this.lastPoint = null;
    this.move(this.input.x, this.input.y);
  }
  release() {
    super.release();
    this.activeStrokeId = null;
    this.lastPoint = null;
    this.syncInk();
  }
  secondary() {
    const p = { x: this.input.x, y: this.input.y };
    this.lines = eraseInkCircle(this.lines, p, 42);
    this.syncInk();
  }
  update(dt) {
    const aged = ageLaserInk(this.lines, this.strokes, this.elapsed, {
      delay: this.laserDelay,
      speed: this.laserSpeed,
      activeId: this.activeStrokeId,
    });
    this.lines = aged.lines;
    this.strokes = aged.states;
    this.syncInk();
    if (this.elapsed >= this.next) {
      this.spawnVolley();
    }
    for (const b of this.drops) {
      if (b.gone) continue;
      if (b.reflected || !Number.isFinite(b.spawnedAt)) advance(b, dt);
      else {
        b.age = this.elapsed - b.spawnedAt;
        b.radius = b.startRadius - b.speed * b.age;
        b.x = this.player.x + Math.cos(b.angle) * b.radius;
        b.y = this.player.y + Math.sin(b.angle) * b.radius;
      }
      if (b.reflected) continue;
      const line = this.lines.find((l) => strokeHit(this, b, l));
      if (line) {
        this.lines = eraseInkCircle(this.lines, b, 48);
        this.syncInk();
        const a = Math.atan2(b.y - this.player.y, b.x - this.player.x);
        b.vx = Math.cos(a) * 430;
        b.vy = Math.sin(a) * 430;
        b.reflected = true;
        this.score++;
        this.notice("Barreira gasta · tinta devolvida");
        continue;
      }
      if (this.hits(b, this.player, 22)) {
        b.gone = true;
        this.hurt("Um projétil atravessou o abrigo.", 0);
      }
    }
    this.drops = this.drops.filter((b) => !b.gone && !outside(b));
    this.kibes = this.drops;
  }
  draw(v) {
    this.lines.forEach((l) => {
      v.line(l.a, l.b, "#b8edcf18", 14);
      v.line(l.a, l.b, "#b8edcf", 8);
      v.line(l.a, l.b, "#edfff5", 2);
    });
    this.drops.forEach((b) => v.enemy(b, this.player));
    v.player(this.player, 76);
  }
}

export class Thunder extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: W / 2, y: H / 2 };
    this.input = { ...this.input, ...this.player };
    this.wave = null;
    this.drops = [];
    this.next = 0.18;
    this.turn = 0;
    this.hint = "Algumas linhas miram sua posição. Mova-se antes do disparo.";
  }
  get speed() {
    return lerp(410, 870, pace(this)) * this.intensity;
  }
  get safeRadius() {
    return lerp(72, 56, this.progress);
  }
  escapePocket() {
    const min = lerp(100, 140, this.progress),
      max = lerp(145, 185, this.progress),
      base = this.rand(0, TAU),
      padding = this.safeRadius + 8;
    for (let i = 0; i < 64; i++) {
      const angle = base + i * 2.3999632297,
        d = this.rand(min, max),
        p = {
          x: clamp(this.player.x + Math.cos(angle) * d, padding, W - padding),
          y: clamp(this.player.y + Math.sin(angle) * d, padding, H - padding),
        };
      if (distance(p, this.player) >= min) return p;
    }
    const angle = Math.atan2(H / 2 - this.player.y, W / 2 - this.player.x);
    return {
      x: clamp(this.player.x + Math.cos(angle) * max, padding, W - padding),
      y: clamp(this.player.y + Math.sin(angle) * max, padding, H - padding),
    };
  }
  newWave() {
    const origin = { ...this.player },
      safe = this.escapePocket(),
      radius = this.safeRadius,
      count = this.progress < 0.25 ? 6 : this.progress < 0.7 ? 12 : 18,
      aimedCount = count === 6 ? 1 : count === 12 ? 3 : 5,
      paths = [];
    const add = (line, kind) =>
      paths.push({
        ...line,
        kind,
        vx: line.dx * this.speed,
        vy: line.dy * this.speed,
      });
    const escapeAngle = Math.atan2(safe.y - origin.y, safe.x - origin.x),
      fan = Math.acos(Math.min(1, (radius + 8) / distance(safe, origin))) * 0.9;
    for (let i = 0; i < aimedCount; i++) {
      const offset =
          aimedCount === 1 ? 0 : lerp(-fan, fan, i / (aimedCount - 1)),
        angle = escapeAngle + Math.PI / 2 + offset;
      add(canvasPath(origin, angle), "aimed");
    }
    for (let i = aimedCount; i < count; i++) {
      let accepted = false;
      for (let k = 0; k < 160; k++) {
        const target = { x: this.rand(0, W), y: this.rand(0, H) },
          { a, b, dx, dy, length } = canvasPath(target, this.rand(0, TAU));
        if (length < 360) continue;
        if (segmentDistance(safe, a, b) < radius) continue;
        add({ a, b, dx, dy, length }, "random");
        accepted = true;
        break;
      }
      if (!accepted) {
        const y = safe.y + (safe.y < 270 ? 1 : -1) * (radius + 8);
        add(canvasPath({ x: safe.x, y }, 0), "random");
      }
    }
    this.safePocket = safe;
    this.wave = {
      paths,
      origin,
      safeRadius: radius,
      aimedCount,
      fireAt:
        this.elapsed +
        Math.max(
          0.32,
          lerp(0.66, 0.31, pace(this)) * (1 - 0.18 * pressure(this)),
        ),
      fired: false,
    };
    this.turn++;
  }
  update(dt) {
    this.axis(780, dt);
    const k = this.input.keys;
    if (k.has("arrowup") || k.has("w")) this.input.y -= 780 * dt;
    if (k.has("arrowdown") || k.has("s")) this.input.y += 780 * dt;
    this.input.x = clamp(this.input.x, 36, W - 36);
    this.input.y = clamp(this.input.y, 36, H - 36);
    follow(this.player, { x: this.input.x, y: this.input.y }, dt, 0.09, 1000);
    if (!this.wave && this.elapsed >= this.next) this.newWave();
    if (this.wave && !this.wave.fired && this.elapsed >= this.wave.fireAt) {
      this.wave.fired = true;
      this.drops = this.wave.paths.map((p) => ({
        ...p.a,
        source: { ...p.a },
        spawnedAt: this.elapsed,
        vx: p.vx,
        vy: p.vy,
        aim: p.b,
        rotation: Math.atan2(p.vy, p.vx) + Math.PI / 4,
        age: 0,
        size: 52,
      }));
    }
    for (const b of this.drops) {
      // Each spawn starts on the true border; subsequent substeps follow the ray.
      b.age = this.elapsed - b.spawnedAt;
      b.x = b.source.x + b.vx * b.age;
      b.y = b.source.y + b.vy * b.age;
      if (this.hits(b, this.player, 20))
        this.fail("Você cruzou a trajetória de um projétil.");
    }
    this.drops = this.drops.filter((b) => !outside(b, 52));
    if (this.wave?.fired && !this.drops.length) {
      this.wave = null;
      this.next = this.elapsed + 0.06;
    }
    this.kibes = this.drops;
  }
  draw(v) {
    if (this.wave && !this.wave.fired) {
      this.wave.paths.forEach((p) =>
        v.line(
          p.a,
          p.b,
          p.kind === "aimed" ? "#ff927fa6" : "#ffad8c85",
          p.kind === "aimed" ? 1.9 : 1.6,
        ),
      );
    }
    this.drops.forEach((b) => v.enemy(b, b.aim, b.size));
    v.player(this.player, 76);
  }
}
