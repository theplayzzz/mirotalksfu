import { Challenge, W, H, clamp, lerp, distance, angleDelta } from "./kit.js";
import { TAU, pace, pressure, advance, outside, arc } from "./mechanics.js";
import { canvasPath } from "./canvas-path.js";
import { shieldGeometry, shieldBlockContact } from "./shield-geometry.js";

export class Paddle extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: W / 2, y: H / 2 };
    this.input = { ...this.input, x: this.player.x + 220, y: this.player.y };
    this.maxLives = this.lives = 3;
    this.shieldRadius = shieldGeometry.radius;
    this.shieldThickness = shieldGeometry.thickness;
    this.contactRadius = shieldGeometry.contactRadius;
    this.blockLimitRadius = shieldGeometry.cutoffRadius;
    this.maxPassedFraction = shieldGeometry.maxPassedFraction;
    this.minContactGap = 0.215;
    this.shieldSpan = shieldGeometry.span;
    this.shieldAngle = 0;
    this.attacks = [];
    this.next = 0.15;
    this.lastArrival = 0;
    this.arrivalLog = [];
    this.lastAngle = null;
    this.chainDirection = 1;
    this.hint = "Mova o mouse ao redor do emoji para girar a barreira.";
  }
  get speed() {
    return (W / 2 - this.contactRadius) / this.flightTime;
  }
  get flightTime() {
    return lerp(1.6, 0.72, pace(this)) / Math.sqrt(this.intensity);
  }
  spawnAttack(angle) {
    if (angle === undefined && this.lastAngle !== null && this.random() < 0.6)
      angle = this.lastAngle + this.chainDirection * this.rand(0.25, 0.8);
    else if (angle === undefined) {
      angle = this.rand(0, TAU);
      this.chainDirection = this.random() < 0.5 ? -1 : 1;
    }
    const source = canvasPath(this.player, angle).b,
      radius = distance(source, this.player);
    const arrival = Math.max(
      this.elapsed + this.flightTime,
      this.lastArrival + this.minContactGap,
    );
    const travelTime = arrival - this.elapsed;
    const attack = {
      ...source,
      source,
      angle,
      radius,
      startRadius: radius,
      speed: (radius - this.contactRadius) / travelTime,
      spawnedAt: this.elapsed,
      travelTime,
      arrival,
      checked: false,
      reflected: false,
      age: 0,
      size: 54,
      rotation: angle + Math.PI * 1.25,
    };
    attack.vx = -Math.cos(angle) * attack.speed;
    attack.vy = -Math.sin(angle) * attack.speed;
    this.attacks.push(attack);
    this.arrivalLog.push(arrival);
    this.lastArrival = arrival;
    this.lastAngle = angle;
    const interval = Math.max(
      this.minContactGap,
      (lerp(0.55, 0.31, pace(this)) * (1 - 0.23 * pressure(this))) /
        this.intensity,
    );
    this.next = this.elapsed + interval;
    return attack;
  }
  update(dt) {
    const a = Math.atan2(
        this.input.y - this.player.y,
        this.input.x - this.player.x,
      ),
      oldAngle = this.shieldAngle;
    this.shieldAngle +=
      angleDelta(a, this.shieldAngle) * (1 - Math.exp(-dt / 0.018));
    if (this.elapsed >= this.next) {
      this.spawnAttack();
    }
    for (const b of this.attacks) {
      if (b.reflected) {
        advance(b, dt);
        continue;
      }
      const oldRadius = b.radius;
      b.age = this.elapsed - b.spawnedAt;
      b.radius = b.startRadius - b.age * b.speed;
      b.x = b.source.x + b.vx * b.age;
      b.y = b.source.y + b.vy * b.age;
      if (!b.checked) {
        const contact = shieldBlockContact(
          oldRadius,
          b.radius,
          b.angle,
          oldAngle,
          this.shieldAngle,
        );
        if (contact) {
          b.checked = true;
          b.reflected = true;
          b.blockedFraction = contact.passedFraction;
          b.x = this.player.x + Math.cos(b.angle) * contact.radius;
          b.y = this.player.y + Math.sin(b.angle) * contact.radius;
          const out = b.angle + this.rand(-0.22, 0.22);
          b.vx = Math.cos(out) * b.speed * 1.2;
          b.vy = Math.sin(out) * b.speed * 1.2;
          this.score++;
          this.notice("Rebatido!");
          const remaining = dt * (1 - contact.t);
          b.x += b.vx * remaining;
          b.y += b.vy * remaining;
          b.radius = distance(b, this.player);
        } else if (b.radius < this.blockLimitRadius) b.checked = true;
      }
      if (b.checked && !b.reflected && this.hits(b, this.player, 22)) {
        b.gone = true;
        this.hurt("O projétil passou pela barreira.", 0);
      }
    }
    this.attacks = this.attacks.filter((b) => !b.gone && !outside(b));
    this.kibes = this.attacks;
  }
  draw(v) {
    v.circle(
      this.player.x,
      this.player.y,
      this.shieldRadius,
      null,
      "#b19ac824",
    );
    arc(
      v,
      this.player,
      this.shieldRadius,
      this.shieldAngle - this.shieldSpan / 2,
      this.shieldAngle + this.shieldSpan / 2,
      "#b8edcf",
      this.shieldThickness,
    );
    this.attacks.forEach((b) => v.enemy(b, this.player));
    v.player(this.player, 76);
  }
}

export { Rhythm } from "./bat-game.js";

export { Slash } from "./slash-game.js";

export class Juggle extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: W / 2, y: H / 2 };
    this.maxLives = this.lives = 3;
    this.initialCount = 4;
    this.maxCount = 13;
    this.ballSize = 60 * 1.25;
    this.clickRadius = 12 * 1.25;
    // Slower recoil decay adds 25% retreat, rather than over-amplifying the impulse.
    this.knockbackDecay = 3.4 / 1.25;
    this.balls = [];
    for (const angle of [0, Math.PI, Math.PI / 2, -Math.PI / 2])
      this.addBall(angle);
    this.kibes = this.balls;
    this.hint =
      "Clique sem limite para afastar todos os projéteis que alcançar. De 4 a 13 ao mesmo tempo.";
  }
  get wanted() {
    return Math.min(
      this.maxCount,
      this.initialCount +
        Math.floor(this.progress * (this.maxCount - this.initialCount + 1)),
    );
  }
  get speed() {
    // Keep the previous approach speeds; difficulty now grows through population.
    const stage = Math.min(6, 2 + Math.floor(this.progress * 5));
    const factor =
      stage === 4 ? 0.72 : stage === 5 ? 0.82 : stage === 6 ? 0.9 : 1;
    return lerp(70, 120, pace(this)) * factor * this.intensity;
  }
  addBall(angle = this.rand(0, TAU)) {
    const border = canvasPath(this.player, angle).b,
      dx = Math.cos(angle),
      dy = Math.sin(angle),
      normal = border.x === 0 || border.x === 960 ? Math.abs(dx) : Math.abs(dy),
      padding = (this.ballSize * 0.55) / normal,
      source = { x: border.x + dx * padding, y: border.y + dy * padding };
    this.balls.push({
      ...source,
      source,
      entry: border,
      ix: 0,
      iy: 0,
      size: this.ballSize,
    });
  }
  press() {
    super.press();
    // Every press acts immediately, including several clicks between frames.
    const p = { x: this.input.x, y: this.input.y },
      affected = this.balls.filter(
        (b) => !b.gone && this.hits(b, p, this.clickRadius),
      );
    if (!affected.length) return;
    for (const b of affected) {
      const a =
        Math.atan2(b.y - this.player.y, b.x - this.player.x) +
        this.rand(-0.67, 0.67);
      b.ix = Math.cos(a) * 580;
      b.iy = Math.sin(a) * 580;
      b.pushes = (b.pushes || 0) + 1;
    }
    this.score += affected.length;
    this.notice(
      affected.length === 1
        ? "Para longe!"
        : `${affected.length} afastados de uma vez!`,
    );
  }
  update(dt) {
    while (this.balls.length < this.wanted) this.addBall();
    const decay = Math.exp(-dt * this.knockbackDecay),
      impulseStep = (1 - decay) / this.knockbackDecay,
      speed = this.speed;
    for (const b of this.balls) {
      const dx = this.player.x - b.x,
        dy = this.player.y - b.y,
        d = Math.hypot(dx, dy) || 1;
      b.x += (dx / d) * speed * dt + b.ix * impulseStep;
      b.y += (dy / d) * speed * dt + b.iy * impulseStep;
      b.ix *= decay;
      b.iy *= decay;
      if (this.hits(b, this.player, 22)) {
        b.gone = true;
        this.hurt("Um projétil chegou ao centro.", 0);
      }
    }
    this.balls = this.balls.filter((b) => !b.gone);
    this.kibes = this.balls;
  }
  draw(v) {
    this.balls.forEach((b) => v.enemy(b, this.player, b.size));
    v.player(this.player, 76);
    v.circle(this.input.x, this.input.y, this.clickRadius, null, "#b8edcf60");
  }
}
