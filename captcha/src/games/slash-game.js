import { Challenge, W, H, clamp, lerp, distance, shuffle } from "./kit.js";
import { pace, pressure, advance, outside } from "./mechanics.js";
import { canvasPath } from "./canvas-path.js";
import { projectileRotation } from "../engine.js";
import { orientedSpriteHitsCircle } from "../collision.js";
import {
  projectileAlpha,
  bladeMaskHit,
  sliceSprite,
} from "./blade-geometry.js";

// First visible-pixel contact with the character, independent of the incoming side.
const playerRadius = 22;
export const SLASH_TARGET_SIZE = 68;
let near = 0,
  far = 80;
for (let i = 0; i < 36; i++) {
  const radius = (near + far) / 2;
  if (
    orientedSpriteHitsCircle(
      projectileAlpha,
      { x: radius, y: 0, size: SLASH_TARGET_SIZE },
      Math.PI * 1.25,
      { x: 0, y: 0 },
      playerRadius,
    )
  )
    near = radius;
  else far = radius;
}
export const SLASH_CONTACT_RADIUS = (near + far) / 2;

function strokeTail(segments, maxLength, now, maxAge) {
  const kept = [];
  let remaining = maxLength;
  for (let i = segments.length - 1; i >= 0 && remaining > 1e-7; i--) {
    const line = segments[i];
    if (now - line.at >= maxAge) continue;
    const length = distance(line.a, line.b),
      take = Math.min(length, remaining);
    if (length < 1e-7) continue;
    kept.push(
      take >= length
        ? line
        : {
            ...line,
            a: {
              x: lerp(line.b.x, line.a.x, take / length),
              y: lerp(line.b.y, line.a.y, take / length),
            },
          },
    );
    remaining -= take;
  }
  return kept.reverse();
}

export class Slash extends Challenge {
  constructor(o = {}) {
    super(o);
    this.player = { x: W / 2, y: H / 2 };
    this.contactRadius = SLASH_CONTACT_RADIUS;
    this.maxLives = this.lives = 3;
    this.targets = [];
    this.next = 0.3;
    this.serial = 0;
    this.spawnSides = [];
    this.lastSide = -1;
    this.lastPoint = null;
    this.trail = [];
    this.activeCuts = [];
    this.fragments = [];
    this.flashes = [];
    this.session = 0;
    this.cutCount = 0;
    this.bladeRadius = 8;
    this.bladeLife = 0.04;
    this.bladeTailLength = 28;
    this.trailLife = 0.14;
    this.trailLength = 160;
    this.bladeAngle = 0;
    this.sliceHit =
      o.sliceHit ||
      ((t, line, previous = t) =>
        bladeMaskHit(projectileAlpha, t, this.rotation(t), line, previous));
    this.hint = "Segure e rabisque para cortar. A lâmina não se esgota.";
    this.metric = "cortes";
  }
  get speed() {
    return (W / 2 - this.contactRadius) / this.flightTime;
  }
  get flightTime() {
    return lerp(2, 1.05, pace(this)) / Math.sqrt(this.intensity);
  }
  rotation(t) {
    return Number.isFinite(t.rotation)
      ? t.rotation
      : projectileRotation(t, this.player);
  }
  entryAngle() {
    // Shuffle coverage of all four edges; do not send a train from one field.
    if (!this.spawnSides.length) {
      this.spawnSides = shuffle([0, 1, 2, 3], this.random);
      if (this.spawnSides.at(-1) === this.lastSide)
        [this.spawnSides[0], this.spawnSides[3]] = [
          this.spawnSides[3],
          this.spawnSides[0],
        ];
    }
    const side = this.spawnSides.pop(),
      along = this.rand(0.08, 0.92),
      point = [
        { x: W * along, y: 0 },
        { x: W, y: H * along },
        { x: W * along, y: H },
        { x: 0, y: H * along },
      ][side];
    this.lastSide = side;
    return Math.atan2(point.y - this.player.y, point.x - this.player.x);
  }
  spawnTarget(angle = this.entryAngle(), travelTime = this.flightTime) {
    const source = canvasPath(this.player, angle).b,
      startRadius = distance(source, this.player),
      speed = (startRadius - this.contactRadius) / travelTime;
    const t = {
      ...source,
      source,
      startRadius,
      radius: startRadius,
      angle,
      speed,
      travelTime,
      spawnedAt: this.elapsed,
      arrival: this.elapsed + travelTime,
      vx: -Math.cos(angle) * speed,
      vy: -Math.sin(angle) * speed,
      age: 0,
      size: SLASH_TARGET_SIZE,
      id: ++this.serial,
    };
    t.rotation = projectileRotation(t, this.player);
    this.targets.push(t);
    return t;
  }
  press() {
    super.press();
    this.session++;
    this.activeCuts = [];
    this.lastPoint = { x: this.input.x, y: this.input.y };
  }
  release() {
    super.release();
    this.lastPoint = null;
    this.activeCuts = [];
  }
  cut(t, line, hit) {
    if (t.cut || t.gone || this.finished) return;
    t.cut = true;
    this.score++;
    this.cutCount++;
    this.fragments.push(...sliceSprite(t, this.rotation(t), line));
    this.flashes.push({
      x: hit.x,
      y: hit.y,
      angle: Math.atan2(line.b.y - line.a.y, line.b.x - line.a.x),
      at: this.elapsed,
    });
    this.notice("Cortado!");
  }
  rememberCut(line) {
    this.activeCuts = strokeTail(
      [...this.activeCuts, line],
      this.bladeTailLength,
      this.elapsed,
      this.bladeLife,
    );
    this.trail = strokeTail(
      [...this.trail, line],
      this.trailLength,
      this.elapsed,
      this.trailLife,
    );
  }
  move(x, y) {
    super.move(x, y);
    if (!this.input.down || this.finished) {
      this.lastPoint = null;
      return;
    }
    const p = { x: this.input.x, y: this.input.y };
    if (!this.lastPoint) {
      this.lastPoint = p;
      return;
    }
    const a = this.lastPoint,
      d = distance(a, p);
    // Keep the previous point until enough subpixel movement accumulates.
    if (d < 0.25) return;
    this.lastPoint = p;
    const b = p;
    const line = {
      a: { ...a },
      b,
      radius: this.bladeRadius,
      at: this.elapsed,
      session: this.session,
    };
    this.bladeAngle = Math.atan2(b.y - a.y, b.x - a.x);
    this.rememberCut(line);
    for (const t of this.targets)
      if (!t.cut && !t.gone) {
        const hit = this.sliceHit(t, line);
        if (hit) this.cut(t, line, hit);
      }
  }
  update(dt) {
    if (this.elapsed >= this.next) {
      this.spawnTarget();
      // Preserve average pressure, with independent, irregular launch times.
      const density = Math.round(lerp(3, 6, pace(this)) + 2 * pressure(this)),
        interval =
          (lerp(1.25, 0.9, pace(this)) - 0.18 * pressure(this)) /
          (density * Math.sqrt(this.intensity));
      this.next = this.elapsed + interval * this.rand(0.45, 1.55);
    }
    for (const t of this.targets) {
      if (t.cut || t.gone) continue;
      const previous = { x: t.x, y: t.y };
      if (Number.isFinite(t.spawnedAt)) {
        t.age = this.elapsed - t.spawnedAt;
        t.radius = t.startRadius - t.speed * t.age;
        t.x = t.source.x + t.vx * t.age;
        t.y = t.source.y + t.vy * t.age;
      } else advance(t, dt);
      if (this.input.down)
        for (const line of this.activeCuts) {
          if (
            line.session !== this.session ||
            this.elapsed - line.at > this.bladeLife
          )
            continue;
          const hit = this.sliceHit(t, line, previous);
          if (hit) {
            this.cut(t, line, hit);
            break;
          }
        }
      if (!t.cut && this.hits(t, this.player, playerRadius)) {
        t.gone = true;
        this.hurt("Um projétil passou pela lâmina.", 0);
      }
    }
    this.targets = this.targets.filter((t) => !t.cut && !t.gone && !outside(t));
    this.kibes = this.targets;
    for (const p of this.fragments) {
      p.age += dt;
      p.vy += 900 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.omega * dt * (p.flipY ? -1 : 1);
      p.omega *= Math.exp(-dt * 0.5);
    }
    this.fragments = this.fragments.filter((p) => p.age < p.life && p.y < 650);
    this.trail = this.trail.filter((p) => this.elapsed - p.at < this.trailLife);
    this.activeCuts = this.activeCuts.filter(
      (p) => this.elapsed - p.at < this.bladeLife,
    );
    this.flashes = this.flashes.filter((p) => this.elapsed - p.at < 0.13);
  }
  draw(v) {
    this.targets
      .filter((t) => !t.cut && !t.gone)
      .forEach((t) => v.enemy(t, this.player));
    this.fragments.forEach((p) => v.enemyPiece(p));
    const c = v.ctx;
    for (const l of this.trail) {
      const fade = clamp(1 - (this.elapsed - l.at) / this.trailLife, 0, 1);
      c.save();
      c.globalAlpha = fade * 0.6;
      v.line(l.a, l.b, "#9bcfff30", 9 * fade);
      v.line(l.a, l.b, "#d9edff", 2 * fade);
      c.restore();
    }
    if (this.input.down)
      for (const l of this.activeCuts) {
        if (this.elapsed - l.at >= this.bladeLife) continue;
        v.line(l.a, l.b, "#9bcfff30", this.bladeRadius * 2);
        v.line(l.a, l.b, "#ffffff", 2.5);
      }
    for (const p of this.flashes) {
      const f = 1 - (this.elapsed - p.at) / 0.13;
      for (const off of [-0.8, 0.8]) {
        const a = p.angle + off;
        v.line(
          { x: p.x + Math.cos(a) * 4, y: p.y + Math.sin(a) * 4 },
          {
            x: p.x + Math.cos(a) * (4 + 12 * f),
            y: p.y + Math.sin(a) * (4 + 12 * f),
          },
          "#fff2cd",
          1.5 * f,
        );
      }
    }
    v.player(this.player, 76);
    const color = this.input.down ? "#f4f8ff" : "#c5d8ee",
      a = this.bladeAngle + Math.PI / 2;
    v.circle(
      this.input.x,
      this.input.y,
      this.bladeRadius,
      null,
      this.input.down ? "#e2f2ff99" : "#c5d8ee55",
    );
    v.line(
      { x: this.input.x - Math.cos(a) * 3, y: this.input.y - Math.sin(a) * 3 },
      { x: this.input.x + Math.cos(a) * 3, y: this.input.y + Math.sin(a) * 3 },
      color,
      1.5,
    );
  }
}
