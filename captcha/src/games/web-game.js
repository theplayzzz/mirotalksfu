import { Challenge, W, H, clamp, distance, lerp } from "./kit.js";
import { buildWebCourse } from "./web-course.js";
import {
  playerCircles,
  makePlayer,
  circleRectContact,
  sweepCircleRect,
  playerShape,
} from "./roof-physics.js";
import { masksOverlap } from "../mask-overlap.js";
import { projectileAlpha } from "./blade-geometry.js";
import { playerAlpha } from "./player-alpha.js";
import {
  rayRectangle,
  raySprite,
  attachWeb,
  stepPendulum,
  webLean,
} from "./web-physics.js";

export class Web extends Challenge {
  constructor(o = {}) {
    super(o);
    this.goal = 1;
    this.metric = "chegada";
    this.player = { x: 130, y: 335, vx: 0, vy: 0 };
    this.input = { ...this.input, x: 280, y: 72 };
    this.cameraX = 0;
    this.groundY = 514;
    this.range = 560;
    this.threadSpeed = 3200;
    this.rope = null;
    this.shot = null;
    this.attachments = 0;
    this.releases = 0;
    this.releaseAt = -1;
    this.attachLog = [];
    this.shotsFired = 0;
    const course = buildWebCourse(this.duration, this.groundY, this.intensity);
    this.start = { id: 1, x: 60, y: 365, w: 110, h: this.groundY - 365 };
    this.finish = { ...course.finish, id: 2 };
    this.ceiling = course.ceiling;
    this.ground = course.ground;
    this.blocks = [this.ceiling, this.start, this.finish];
    this.gates = course.gates;
    this.floor = [];
    this.solids = [
      this.start,
      this.finish,
      this.ground,
      { ...this.ceiling, y: -200, h: 212 },
    ];
    this.bodyHit =
      o.bodyHit || ((b, p) => masksOverlap(projectileAlpha, b, playerAlpha, p));
    this.hint =
      "Mire no teto ou nos obstáculos. Segure para prender; solte para saltar.";
    this.refreshVisible();
  }
  get courseProgress() {
    return clamp((this.player.x - 130) / (this.finish.lineX - 130), 0, 1);
  }
  get speed() {
    return Math.hypot(this.player.vx, this.player.vy);
  }
  move(x, y) {
    this.input.x = clamp(x, 0, W);
    this.input.y = clamp(y, 0, H);
    this.input.moved = true;
  }
  aim() {
    const target = { x: this.input.x + this.cameraX, y: this.input.y },
      d = distance(target, this.player);
    if (d < 1) return null;
    const direction = {
      x: (target.x - this.player.x) / d,
      y: (target.y - this.player.y) / d,
    };
    let hit = null;
    for (const block of this.blocks) {
      const p = rayRectangle(this.player, direction, block, this.range);
      if (p && (!hit || p.distance < hit.distance))
        hit = {
          ...p,
          blockId: block.id,
          kind: block.id === 0 ? "ceiling" : "platform",
        };
    }
    for (const obstacle of this.kibes) {
      if (Math.abs(obstacle.x - this.player.x) > this.range + 40) continue;
      const p = raySprite(
        this.player,
        direction,
        obstacle,
        projectileAlpha,
        hit?.distance ?? this.range,
      );
      if (p && (!hit || p.distance < hit.distance))
        hit = { ...p, obstacleId: obstacle.id, kind: "obstacle" };
    }
    return { direction, hit };
  }
  press() {
    if (this.input.down || this.finished) return;
    super.press();
    const aim = this.aim();
    if (!aim) return;
    this.shot = {
      id: ++this.shotsFired,
      source: { x: this.player.x, y: this.player.y },
      direction: aim.direction,
      hit: aim.hit,
      x: this.player.x,
      y: this.player.y,
      travelled: 0,
    };
  }
  release({ kick = true } = {}) {
    if (this.rope) {
      this.releases++;
      if (kick && this.input.down && !this.finished) {
        // A small voluntary jump adds to the pendulum's existing momentum.
        this.player.vx += 30;
        this.player.vy -= 110;
      }
    }
    this.rope = null;
    this.shot = null;
    this.releaseAt = this.elapsed;
    super.release();
  }
  refreshVisible() {
    const inside = (b) =>
      b.x > this.cameraX - 80 && b.x < this.cameraX + W + 80;
    this.kibes = this.gates.flatMap((g) => g.parts).filter(inside);
  }
  collideSolids(from) {
    const p = this.player,
      angle = webLean(p),
      oldParts = playerCircles(makePlayer(from.x, from.y, from.angle ?? angle));
    let first = null;
    for (const rect of this.solids) {
      if (
        Math.max(from.x, p.x) + 40 < rect.x ||
        Math.min(from.x, p.x) - 40 > rect.x + rect.w
      )
        continue;
      for (const c of oldParts) {
        c.r -= playerShape.skin;
        const hit = sweepCircleRect(c, p.x - from.x, p.y - from.y, rect);
        // A resting/tilting contact must not cancel a lift away from the roof.
        // Remaining overlap is resolved at the new pose below.
        if (
          hit?.time === 0 &&
          (p.x - from.x) * hit.nx + (p.y - from.y) * hit.ny >= -1e-9
        )
          continue;
        if (hit && (!first || hit.time < first.time)) first = hit;
      }
    }
    if (first) {
      p.x =
        lerp(from.x, p.x, first.time) +
        first.nx * (Math.max(0, first.depth) + 0.008);
      p.y =
        lerp(from.y, p.y, first.time) +
        first.ny * (Math.max(0, first.depth) + 0.008);
      const vn = p.vx * first.nx + p.vy * first.ny;
      if (vn < 0) {
        const e = vn < -90 ? 0.12 : 0;
        p.vx -= (1 + e) * vn * first.nx;
        p.vy -= (1 + e) * vn * first.ny;
      }
      if (first.ny < -0.7) p.vx *= this.rope ? 0.998 : 0.985;
    }
    // Correct overlaps from the changing lean, without adding a sprite-sized box.
    for (let i = 0; i < 2; i++)
      for (const rect of this.solids) {
        if (p.x + 40 < rect.x || p.x - 40 > rect.x + rect.w) continue;
        for (const c of playerCircles(makePlayer(p.x, p.y, webLean(p)))) {
          c.r -= playerShape.skin;
          const hit = circleRectContact(c, rect);
          if (!hit || hit.depth <= 0.001) continue;
          p.x += hit.nx * (hit.depth + 0.008);
          p.y += hit.ny * (hit.depth + 0.008);
          const vn = p.vx * hit.nx + p.vy * hit.ny;
          if (vn < 0) {
            p.vx -= vn * hit.nx;
            p.vy -= vn * hit.ny;
          }
        }
      }
  }
  update(dt) {
    let left = dt;
    while (left > 1e-9 && !this.finished) {
      const reelSpeed =
          this.rope?.reelLeft > 0
            ? (1.5 * this.rope.reelAmount) / this.rope.reelDuration
            : 0,
        h = Math.min(left, 1 / 240, 2 / (this.speed + reelSpeed + 110)),
        from = {
          x: this.player.x,
          y: this.player.y,
          angle: webLean(this.player),
        };
      stepPendulum(this.player, this.rope, h);
      this.collideSolids(from);
      if (this.shot) {
        const s = this.shot;
        s.travelled += this.threadSpeed * h;
        s.x = s.source.x + s.direction.x * s.travelled;
        s.y = s.source.y + s.direction.y * s.travelled;
        if (s.hit && s.travelled >= s.hit.distance) {
          if (distance(this.player, s.hit) >= 8) {
            this.rope = attachWeb(this.player, s.hit, {
              maxLength: this.groundY - s.hit.y - 104,
            });
            this.attachments++;
            this.attachLog.push({
              x: s.hit.x,
              y: s.hit.y,
              blockId: s.hit.blockId,
              obstacleId: s.hit.obstacleId,
              kind: s.hit.kind,
              shotId: s.id,
              at: this.elapsed,
              length: this.rope.length,
            });
            this.attachLog = this.attachLog.slice(-30);
          }
          this.shot = null;
        } else if (s.travelled >= this.range) {
          this.shot = null;
          this.notice("A teia passou. Mire no teto ou em um obstáculo.", "bad");
        }
      }
      const pose = { ...this.player, size: 76, angle: webLean(this.player) };
      for (const b of this.kibes)
        if (
          Math.abs(b.x - pose.x) < 80 &&
          Math.abs(b.y - pose.y) < 85 &&
          this.bodyHit(b, pose)
        ) {
          this.fail("O emoji encostou nos elementos do percurso.");
          break;
        }
      if (this.player.y > H + 100 || this.player.x < -80)
        this.fail("O emoji saiu do percurso.");
      if (!this.finished && this.player.x >= this.finish.lineX) {
        this.score = 1;
        this.win("Você cruzou a chegada pendurado na própria coragem.");
      }
      left -= h;
    }
    const target = clamp(
      this.player.x - 280,
      0,
      this.finish.x + this.finish.w + 100 - W,
    );
    this.cameraX += (target - this.cameraX) * (1 - Math.exp(-dt / 0.12));
    this.refreshVisible();
    this.hint = this.rope
      ? "Segure para balançar. Solte para saltar até o próximo apoio."
      : this.shot
        ? "Segure até a teia prender na superfície."
        : "Mire no teto ou nos obstáculos. Segure para prender; solte para saltar.";
  }
  draw(v) {
    const c = v.ctx,
      sx = (x) => x - this.cameraX,
      p = this.player;
    v.rect(0, this.groundY, W, H - this.groundY, "#15121e", 0);
    for (const b of [this.start, this.finish]) {
      v.rect(sx(b.x), b.y, b.w, b.h, "#4c405b", 0);
      v.rect(sx(b.x), b.y, b.w, 6, "#b8edcf", 0);
      for (let x = b.x + 14; x < b.x + b.w - 14; x += 25)
        for (let y = b.y + 22; y < this.groundY - 12; y += 30)
          v.rect(sx(x), y, 11, 14, "#b19ac842", 1);
    }
    v.rect(0, 0, W, 12, "#655275", 0);
    v.rect(0, 10, W, 2, "#b8edcf", 0);
    for (
      let x = Math.floor(this.cameraX / 60) * 60;
      x < this.cameraX + W;
      x += 60
    )
      v.circle(sx(x), 5, 1.5, "#c7b7d455");
    v.line({ x: 0, y: this.groundY }, { x: W, y: this.groundY }, "#8e7a9e", 2);
    this.kibes.forEach((b) =>
      v.enemy({ ...b, x: sx(b.x) }, { x: sx(b.x), y: 0 }, b.size),
    );
    const anchor = this.rope || this.shot;
    if (anchor) {
      v.line(
        { x: sx(p.x), y: p.y },
        { x: sx(anchor.x), y: anchor.y },
        "#f1f5ff20",
        6,
      );
      v.line(
        { x: sx(p.x), y: p.y },
        { x: sx(anchor.x), y: anchor.y },
        "#f4f5ff",
        1.8,
      );
      v.circle(sx(anchor.x), anchor.y, this.rope ? 4 : 2, "#b8edcf");
    } else {
      const aim = this.aim();
      if (aim?.hit) {
        c.save();
        c.setLineDash([3, 7]);
        v.line(
          { x: sx(p.x), y: p.y },
          { x: sx(aim.hit.x), y: aim.hit.y },
          "#b8edcf55",
          1,
        );
        c.restore();
        v.circle(sx(aim.hit.x), aim.hit.y, 7, null, "#b8edcf");
      }
    }
    v.player({ x: sx(p.x), y: p.y }, 76, webLean(p));
    const flagX = sx(this.finish.lineX),
      flagTop = this.finish.y - 112;
    v.line(
      { x: flagX, y: flagTop },
      { x: flagX, y: this.finish.y },
      "#edfff5",
      3,
    );
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 4; col++)
        v.rect(
          flagX + col * 9,
          flagTop + row * 9,
          9,
          9,
          (row + col) % 2 ? "#332a43" : "#b8edcf",
          0,
        );
    v.text("CHEGADA", flagX + 18, flagTop - 16, 12, "#b8edcf");
    if (this.attachments === 0 && !this.shot)
      v.text("TETO E OBSTÁCULOS PRENDEM A TEIA", sx(310), 40, 11, "#b8edcf");
  }
}
