import { Challenge, W, H, clamp, lerp } from "./kit.js";
import { pace, pressure } from "./mechanics.js";
import {
  COLUMN_BOUNDS,
  COLUMN_ROTATION,
  COLUMN_SIZE,
} from "./column-layout.js";
const SIZE = COLUMN_SIZE,
  ROTATION = COLUMN_ROTATION;
export const GRAVITY_SPRITE_BOUNDS = COLUMN_BOUNDS;

export class Gravity extends Challenge {
  constructor(o) {
    super(o);
    this.track = { top: 0, bottom: H };
    this.limits = { top: 30, bottom: H - 30 };
    this.playerRadius = 20;
    this.player = { x: 220, y: this.limits.bottom };
    this.acceleration = 8200;
    this.maxVerticalSpeed = 1200;
    this.spriteBounds = GRAVITY_SPRITE_BOUNDS;
    this.vy = 0;
    this.gravity = 1;
    this.gates = [];
    this.serial = 0;
    this.patternSerial = 0;
    this.lastTop = false;
    this.sideRun = 0;
    this.metric = "colunas";
    this.addGate(640, true);
    this.addGate(1110, false);
    this.refreshColumns();
    this.hint =
      "Clique na pista ou no personagem para inverter, inclusive no meio do voo.";
  }
  get speed() {
    return lerp(340, 600, pace(this)) * this.intensity;
  }
  get approachSpeed() {
    // Spacing considers the acceleration while the pattern approaches the player.
    const ahead = (1050 - this.player.x) / Math.max(200, this.speed) + 0.8;
    return (
      lerp(
        340,
        600,
        clamp(((this.elapsed + ahead) / this.duration) * 2, 0, 1),
      ) * this.intensity
    );
  }
  addGate(
    x,
    top,
    { count = 5, step = 55, pattern = 0, weaveIndex = -1, weaveCount = 0 } = {},
  ) {
    const b = this.spriteBounds;
    const height = b.bottom - b.top + (count - 1) * step;
    const gate = {
      id: ++this.serial,
      x,
      top,
      count,
      step,
      height,
      pattern,
      weaveIndex,
      weaveCount,
      y: top
        ? this.track.top - b.top
        : this.track.bottom - b.bottom - (count - 1) * step,
      safeMin: top
        ? this.track.top + height + this.playerRadius + 5
        : this.limits.top,
      safeMax: top
        ? this.limits.bottom
        : this.track.bottom - height - this.playerRadius - 5,
      passed: false,
    };
    this.gates.push(gate);
    this.sideRun = top === this.lastTop ? this.sideRun + 1 : 1;
    this.lastTop = top;
    return gate;
  }
  nextSide() {
    return this.sideRun >= 2 || this.random() < 0.8
      ? !this.lastTop
      : this.lastTop;
  }
  spawnPattern() {
    const last = this.gates.at(-1);
    const pattern = ++this.patternSerial;
    const weave = pattern % 3 === 1;
    const spacing = Math.max(
      lerp(470, 365, pace(this)) - 22 * pressure(this),
      this.approachSpeed * (weave || last.weaveCount ? 0.72 : 0.6),
    );
    const x = Math.max(1000, last.x + spacing),
      top = this.nextSide();
    if (weave) {
      const count = pace(this) > 0.7 && this.random() < 0.6 ? 3 : 2;
      const offset = Math.max(126, this.approachSpeed * 0.32);
      for (let i = 0; i < count; i++)
        this.addGate(x + offset * i, i % 2 ? !top : top, {
          count: 3,
          step: 62,
          pattern,
          weaveIndex: i,
          weaveCount: count,
        });
    } else
      this.addGate(x, top, {
        count: pace(this) > 0.55 && this.random() < 0.3 ? 6 : 5,
        step: this.rand(53, 56),
        pattern,
      });
  }
  columnParts(gate) {
    return Array.from({ length: gate.count }, (_, i) => ({
      gateId: gate.id,
      x: gate.x,
      y: gate.y + gate.step * i,
      size: SIZE,
      rotation: ROTATION,
      flipY: true,
    }));
  }
  refreshColumns() {
    this.kibes = this.gates.flatMap((g) => this.columnParts(g));
  }
  press() {
    super.press();
    this.gravity *= -1;
  }
  update(dt) {
    this.vy = clamp(
      this.vy + this.gravity * this.acceleration * dt,
      -this.maxVerticalSpeed,
      this.maxVerticalSpeed,
    );
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
    for (const gate of this.gates) {
      gate.x -= this.speed * dt;
      if (
        !gate.passed &&
        gate.x + this.spriteBounds.right < this.player.x - this.playerRadius
      ) {
        gate.passed = true;
        this.score++;
      }
    }
    if (this.gates.at(-1).x < 990) this.spawnPattern();
    this.gates = this.gates.filter((g) => g.x > -100);
    this.refreshColumns();
    for (const b of this.kibes)
      if (this.hits(b, this.player, this.playerRadius)) {
        this.fail("Você encostou em uma coluna de projéteis.");
        break;
      }
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
    v.text(this.gravity > 0 ? "↓" : "↑", 168, this.player.y + 8, 25, "#b8edcf");
    v.player(this.player, 76);
  }
}
