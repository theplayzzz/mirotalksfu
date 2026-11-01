import { Challenge, W, H, clamp } from "./kit.js";
import { follow, spikeFloor } from "./mechanics.js";
import { platformLanding } from "./platform-contact.js";
import {
  climbMotion,
  climbPlatformPose,
  climbClockAfter,
  roamingPhase,
} from "./climb-motion.js";

export { Stretch } from "./rooftops-game.js";

export class Climb extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: 480, y: 415 };
    this.input.x = 480;
    this.movementLag = 0.115;
    this.maxMoveSpeed = 780;
    this.minLandingOverlap = 0.2;
    this.lastLanding = null;
    this.vy = -570;
    this.camera = 0;
    this.platformClock = 0;
    this.nextRoamingIndex = Math.floor(this.rand(3, 6));
    this.platforms = [
      { x: 424, centerX: 480, y: 450, w: 112, i: 0, used: true },
    ];
    this.highest = 0;
    this.topIndex = 0;
    this.topY = 450;
    this.topX = 480;
    this.floor = spikeFloor();
    this.kibes = this.floor;
    this.metric = "plataformas";
    this.ensurePlatforms();
    this.hint =
      "Mova o mouse para os lados. Salto automático; cada plataforma só serve uma vez.";
  }
  get difficulty() {
    return clamp(this.progress * 3, 0, 1);
  }
  get platformWidth() {
    return climbMotion(this.progress, this.intensity).width;
  }
  get driftAmplitude() {
    return climbMotion(this.progress, this.intensity).localAmplitude;
  }
  get platformTravelSpeed() {
    return climbMotion(this.progress, this.intensity).travelSpeed;
  }
  ensurePlatforms() {
    while (this.topY + this.camera > -500) {
      this.topIndex++;
      this.topY -= this.rand(98, 116);
      this.topX = clamp(this.topX + this.rand(-190, 190), 110, 850);
      const w = this.platformWidth;
      const roaming = this.topIndex === this.nextRoamingIndex,
        rangeScale = roaming ? this.rand(0.94, 1) : this.rand(0.65, 1),
        motionRate = this.rand(0.9, 1.05),
        horizon = (this.topIndex - this.highest) * 0.65,
        arrivalClock = climbClockAfter(
          this.platformClock,
          this.elapsed,
          horizon,
          this.duration,
          this.intensity,
        );
      if (roaming) this.nextRoamingIndex += Math.floor(this.rand(4, 7));
      const p = {
        x: this.topX - w / 2,
        centerX: this.topX,
        y: this.topY,
        w,
        i: this.topIndex,
        motion: roaming ? "roaming" : "local",
        rangeScale,
        motionRate,
        phase: roaming
          ? roamingPhase(
              this.topX,
              (this.elapsed + horizon) / this.duration,
              arrivalClock,
              rangeScale,
              motionRate,
              this.random() < 0.5,
            )
          : this.rand(0, 6),
        used: false,
      };
      p.drawX = climbPlatformPose(p, this.progress, this.platformClock).x;
      this.platforms.push(p);
    }
  }
  update(dt) {
    const target = { x: clamp(this.input.x, 32, W - 32), y: this.player.y };
    const from = { ...this.player };
    // Integrate the changing rate: multiplying elapsed time by it would make
    // existing platforms jump sideways whenever the difficulty changes.
    this.platformClock += dt * this.platformTravelSpeed;
    follow(this.player, target, dt, this.movementLag, this.maxMoveSpeed);
    this.vy += 1240 * dt;
    this.player.y += this.vy * dt;
    let landed = null;
    for (const p of this.platforms) {
      const previous = { x: p.drawX ?? p.x, w: p.w };
      if (!p.used) {
        const pose = climbPlatformPose(
          p,
          this.progress,
          this.platformClock,
          this.platformWidth,
        );
        p.w = pose.w;
        p.x = p.centerX - p.w / 2;
        p.drawX = pose.x;
      }
      const hit =
        !p.used && this.vy > 0
          ? platformLanding(
              from,
              this.player,
              { x: p.drawX, w: p.w, y: p.y },
              previous,
              this.minLandingOverlap,
            )
          : null;
      if (hit && (!landed || hit.t < landed.hit.t)) landed = { p, hit };
    }
    if (landed) {
      const { p, hit } = landed,
        remaining = dt * (1 - hit.t);
      this.vy = -570 + 1240 * remaining;
      this.player.y = hit.y + this.vy * remaining;
      this.lastLanding = {
        platformId: p.i,
        at: this.elapsed - dt + hit.t * dt,
        x: hit.x,
        y: hit.y,
        fraction: hit.fraction,
        platformLeft: hit.left,
        platformRight: hit.right,
      };
      p.used = true;
      p.usedAt = this.elapsed;
      this.highest = p.i;
      this.score++;
      this.notice("Plataforma usada: ela some.");
      for (const lower of this.platforms)
        if (lower.i < p.i) {
          lower.used = true;
          lower.usedAt ??= this.elapsed - 0.3;
        }
    }
    this.camera = Math.max(this.camera, H / 2 - this.player.y);
    this.ensurePlatforms();
    this.platforms = this.platforms.filter(
      (p) =>
        p.y + this.camera < 565 &&
        (!p.used || this.elapsed - (p.usedAt ?? 0) < 0.22),
    );
    const screenPlayer = { x: this.player.x, y: this.player.y + this.camera };
    for (const b of this.floor)
      if (this.hits(b, screenPlayer, 21))
        this.fail("O emoji caiu no chão de projéteis.");
    if (screenPlayer.y > 570) this.fail("Você caiu das plataformas.");
  }
  draw(v) {
    this.platforms.forEach((p) => {
      const y = p.y + this.camera;
      if (y < -8 || y > H) return;
      const a = p.used
        ? clamp(1 - (this.elapsed - (p.usedAt ?? 0)) / 0.22, 0, 1)
        : 1;
      if (!a) return;
      v.ctx.save();
      v.ctx.globalAlpha = a;
      v.rect(
        p.drawX ?? p.x,
        y,
        p.w,
        8,
        p.i === this.highest + 1 ? "#b8edcf" : "#a38ab8",
        3,
      );
      v.ctx.restore();
    });
    this.floor.forEach((b) => v.enemy(b, { x: b.x, y: 0 }, b.size));
    v.player({ x: this.player.x, y: this.player.y + this.camera }, 76);
  }
}
