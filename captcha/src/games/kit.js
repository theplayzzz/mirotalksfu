import { PLAYFIELD } from "../playfield.js";
export const W = PLAYFIELD.width,
  H = PLAYFIELD.height;
export const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export const lerp = (a, b, t) => a + (b - a) * t;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const angleDelta = (a, b) =>
  Math.atan2(Math.sin(a - b), Math.cos(a - b));
export const circleRect = (p, r, box) =>
  Math.hypot(
    p.x - clamp(p.x, box.x, box.x + box.w),
    p.y - clamp(p.y, box.y, box.y + box.h),
  ) < r;
export function segmentDistance(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = clamp(
    ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
    0,
    1,
  );
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function shuffle(items, random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function seeded(seed = 1) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Challenge {
  constructor({
    duration = 25,
    intensity = 0.9,
    random = Math.random,
    hits,
  } = {}) {
    this.duration = clamp(Number(duration) || 25, 8, 40);
    this.intensity = clamp(Number(intensity) || 0.9, 0.7, 1.5);
    this.random = random;
    this.hits = hits || ((a, b, r = 22) => distance(a, b) < r + 14);
    this.elapsed = 0;
    this.finished = false;
    this.reason = null;
    this.player = { x: 480, y: 400 };
    this.input = { x: 480, y: 400, down: false, keys: new Set(), moved: false };
    this.kibes = [];
    this.score = 0;
    this.goal = 0;
    this.lives = 1;
    this.maxLives = 1;
    this.hitCount = 0;
    this.hitUntil = 0;
    this.lastHurt = -10;
    this.hint = "";
    this.feedback = null;
    this.duplications = 0;
    this.metric = "acertos";
  }
  get progress() {
    return clamp(this.elapsed / this.duration, 0, 1);
  }
  get remaining() {
    return Math.max(0, this.duration - this.elapsed);
  }
  get speed() {
    return 100 * (1 + 4 * this.progress) * this.intensity;
  }
  rand(a, b) {
    return a + (b - a) * this.random();
  }
  move(x, y) {
    this.input.x = clamp(x, 0, W);
    this.input.y = clamp(y, 0, H);
    this.input.moved = true;
  }
  press() {
    this.input.down = true;
  }
  release() {
    this.input.down = false;
  }
  secondary() {}
  key(key) {
    if (!this.grid) return;
    const d = {
      arrowleft: -1,
      arrowright: 1,
      arrowup: -this.grid.cols,
      arrowdown: this.grid.cols,
    }[key];
    if (d !== undefined)
      this.cursor = clamp(
        (this.cursor || 0) + d,
        0,
        this.grid.cols * this.grid.rows - 1,
      );
  }
  chooseCursor() {
    if (!this.grid) return;
    const b = this.cell(this.cursor || 0);
    this.move(b.x + b.w / 2, b.y + b.h / 2);
    this.press();
    this.release();
  }
  cell(i) {
    const g = this.grid;
    return {
      x: g.x + (i % g.cols) * g.gap,
      y: g.y + Math.floor(i / g.cols) * g.gap,
      w: g.size,
      h: g.size,
    };
  }
  cellAt() {
    if (!this.grid) return -1;
    for (let i = 0; i < this.grid.cols * this.grid.rows; i++) {
      const b = this.cell(i);
      if (
        this.input.x >= b.x &&
        this.input.x <= b.x + b.w &&
        this.input.y >= b.y &&
        this.input.y <= b.y + b.h
      )
        return i;
    }
    return -1;
  }
  notice(text, kind = "good") {
    this.feedback = { text, kind, until: this.elapsed + 1 };
  }
  point(n = 1) {
    if (this.finished) return;
    this.score += n;
    this.notice(`+${n}`);
    if (this.goal && this.score >= this.goal) this.win();
  }
  hurt(text = "Você foi atingido.", immunity = 0.38) {
    if (this.finished || this.elapsed - this.lastHurt < immunity) return false;
    this.lastHurt = this.elapsed;
    this.hitCount++;
    this.hitUntil = this.elapsed + 0.48;
    this.lives--;
    this.notice(text, "bad");
    if (this.lives <= 0) this.fail(text);
    return true;
  }
  fail(text = "Você foi atingido.", reason = "impact") {
    if (this.finished) return;
    this.finished = true;
    this.reason = reason;
    this.detail = text;
  }
  win(text = "Objetivo concluído!") {
    if (this.finished) return;
    this.finished = true;
    this.reason = "survived";
    this.detail = text;
  }
  step(seconds) {
    let left = clamp(seconds, 0, 0.05);
    while (left > 1e-9 && !this.finished) {
      const dt = Math.min(left, 1 / 120);
      this.elapsed = Math.min(this.duration, this.elapsed + dt);
      this.update(dt);
      if (!this.finished && this.remaining < 1e-9) {
        this.elapsed = this.duration;
        this.goal
          ? this.fail("O tempo acabou antes do objetivo.", "timeout")
          : this.win("Você sobreviveu até o fim!");
      }
      left -= dt;
    }
  }
  update() {}
  draw(v) {
    v.player(this.player);
  }
  axis(speed = 600, dt = 1 / 120) {
    const k = this.input.keys;
    const dir =
      Number(k.has("arrowright") || k.has("d")) -
      Number(k.has("arrowleft") || k.has("a"));
    if (dir) {
      this.input.x = clamp(this.input.x + dir * speed * dt, 0, W);
      this.input.moved = true;
    }
    return this.input.x;
  }
}
