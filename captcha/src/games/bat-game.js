import { Challenge, W, H, clamp, lerp } from "./kit.js";
import { pace, pressure } from "./mechanics.js";
import projectileShape from "./projectile-shape.js";
import {
  canExpel,
  exitTime,
  fullyOutside,
  guideWeakProjectile,
} from "./bat-guidance.js";
import {
  BAT_COM,
  SWING_DURATION,
  isBatStriking,
  createBat,
  driveBat,
  batCapsules,
  makeProjectile,
  integrateProjectile,
  syncArtwork,
  batContact,
  resolveBatContact,
} from "./bat-physics.js";

export class Rhythm extends Challenge {
  constructor(o = {}) {
    super(o);
    this.player = { x: 105, y: H / 2 };
    this.maxLives = this.lives = 3;
    this.input.x = 245;
    this.input.y = this.player.y + 71;
    this.bat = createBat(this.input.x, this.input.y);
    this.shape = o.projectileShape || projectileShape;
    this.cooldown = SWING_DURATION;
    this.cooldownUntil = 0;
    this.swing = null;
    this.queuedSwing = false;
    this.shots = [];
    this.contacts = [];
    this.serial = 0;
    this.groupSerial = 0;
    this.defenseRadius = 230;
    this.lastArrival = 0;
    this.lastSide = null;
    this.sideRun = 0;
    this.next = 0.75;
    this.metric = "expulsos";
    this.maxSubstepTravel = 2.2;
    this.addGroup({ side: "right", y: this.player.y });
    this.hint =
      "Mova e clique para bater forte. Desvios fracos voltam; o ponto vem ao expulsar da tela.";
  }
  get speed() {
    return lerp(280, 650, pace(this)) * this.intensity;
  }
  get flightTime() {
    return lerp(1.85, 0.88, pace(this)) / Math.sqrt(this.intensity);
  }
  addShot({
    x,
    y,
    side,
    arrival: scheduledArrival,
    groupId,
    groupIndex = 0,
    groupSize = 1,
  } = {}) {
    if (x === undefined || y === undefined) {
      if (!side) {
        const roll = this.random();
        side = roll < 0.5 ? "right" : roll < 0.75 ? "top" : "bottom";
        if (side === this.lastSide && this.sideRun >= 2) {
          const others = ["right", "top", "bottom"].filter((s) => s !== side);
          side = others[Math.floor(this.random() * others.length)];
        }
      }
      if (side === "right") {
        x = W;
        y ??= this.rand(24, H - 24);
      } else {
        x ??= this.rand(460, W - 24);
        y = side === "top" ? 0 : H;
      }
    }
    this.sideRun = side === this.lastSide ? this.sideRun + 1 : 1;
    this.lastSide = side;
    const targetY = this.player.y,
      dx = this.player.x - x,
      dy = targetY - y,
      d = Math.hypot(dx, dy),
      arrival =
        scheduledArrival ??
        Math.max(
          this.elapsed + this.flightTime,
          this.lastArrival + this.cooldown + 0.09,
        ),
      travelTime = arrival - this.elapsed,
      approachSpeed = (d - this.defenseRadius) / travelTime,
      vx = (dx / d) * approachSpeed,
      vy = (dy / d) * approachSpeed;
    const b = makeProjectile(this.shape, {
      id: ++this.serial,
      x,
      y,
      vx,
      vy,
      size: 62,
      rotation: Math.PI / 4 - Math.atan2(vy, vx),
      flipY: true,
    });
    b.dirX = dx / d;
    b.dirY = dy / d;
    b.source = { x, y };
    b.side = side;
    b.approachSpeed = approachSpeed;
    b.defensePoint = {
      x: this.player.x - (dx / d) * this.defenseRadius,
      y: this.player.y - (dy / d) * this.defenseRadius,
    };
    b.arrival = arrival;
    b.travelTime = travelTime;
    b.spawnedAt = this.elapsed;
    b.groupId = groupId;
    b.groupIndex = groupIndex;
    b.groupSize = groupSize;
    b.chaseSpeed = Math.min(this.speed, approachSpeed * 1.15);
    b.ejected = false;
    b.gravity = 32;
    b.airDrag = 0.03;
    this.lastArrival = arrival;
    this.shots.push(b);
    return b;
  }
  addGroup(options = {}) {
    const count =
        this.progress < 0.2
          ? 1
          : this.progress >= 0.8 && this.intensity >= 1.2
            ? 3
            : 2,
      groupId = ++this.groupSerial,
      first = this.addShot({ ...options, groupId, groupSize: count }),
      group = [first],
      gap = count === 3 ? 0.05 : 0.06;
    for (let i = 1; i < count; i++) {
      const offset = (i % 2 ? 1 : -1) * this.rand(42, 58),
        position =
          first.side === "right"
            ? { x: W, y: clamp(first.source.y + offset, 24, H - 24) }
            : {
                x: clamp(first.source.x + offset, 460, W - 24),
                y: first.source.y,
              };
      group.push(
        this.addShot({
          ...position,
          side: first.side,
          arrival: first.arrival + gap * i,
          groupId,
          groupIndex: i,
          groupSize: count,
        }),
      );
    }
    return group;
  }
  startSwing(at = this.elapsed) {
    this.swing = { at };
    this.cooldownUntil = at + this.cooldown;
    this.queuedSwing = false;
  }
  press() {
    super.press();
    if (this.finished) return;
    if (this.elapsed >= this.cooldownUntil) this.startSwing();
    else if (this.cooldownUntil - this.elapsed <= 0.085)
      this.queuedSwing = true;
  }
  update(dt) {
    this.axis(760, dt);
    const k = this.input.keys;
    if (k.has("arrowup") || k.has("w")) this.input.y -= 760 * dt;
    if (k.has("arrowdown") || k.has("s")) this.input.y += 760 * dt;
    this.input.y = clamp(this.input.y, 0, H);
    if (this.elapsed >= this.next) {
      const group = this.addGroup(),
        tail = group.at(-1).arrival - group[0].arrival;
      this.next =
        this.elapsed +
        Math.max(
          this.cooldown + 0.09 + tail,
          (lerp(0.98, 0.65, pace(this)) * (1 - 0.06 * pressure(this))) /
            Math.sqrt(this.intensity),
        );
    }
    let remaining = dt,
      time = this.elapsed - dt;
    while (remaining > 1e-9 && !this.finished) {
      let projectileVelocity = this.speed;
      for (const b of this.shots)
        projectileVelocity = Math.max(
          projectileVelocity,
          Math.hypot(b.vx, b.vy) + Math.abs(b.omega) * b.radius,
        );
      const batVelocity =
        Math.hypot(this.bat.vx, this.bat.vy) + Math.abs(this.bat.omega) * 127;
      const h = Math.min(
        remaining,
        1 / 240,
        this.maxSubstepTravel / Math.max(600, projectileVelocity + batVelocity),
      );
      time += h;
      driveBat(this.bat, this.input, this.swing ? time - this.swing.at : 99, h);
      const capsules = batCapsules(this.bat);
      for (const b of this.shots) {
        if (b.gone) continue;
        if (b.free && !b.ejected)
          guideWeakProjectile(
            b,
            this.player,
            capsules,
            time,
            h,
            b.chaseSpeed || this.speed,
          );
        integrateProjectile(b, this.shape, h);
        const contact = batContact(b, this.shape, this.bat, capsules);
        if (contact) {
          const wasEjected = b.ejected;
          const before = { vx: b.vx, vy: b.vy, omega: b.omega };
          const event = resolveBatContact(b, this.bat, contact, {
            striking: isBatStriking(this.bat),
          });
          syncArtwork(b, this.shape);
          b.free = true;
          b.returnAt ??= time + 0.22;
          if (event.impulse > 0) {
            if (canExpel(b, this.bat, event)) {
              b.ejected = true;
              b.gravity = 105;
              b.airDrag = 0.018;
            } else if (
              b.ejected &&
              (Math.hypot(b.vx, b.vy) < 260 || exitTime(b) > 2.2)
            ) {
              b.ejected = false;
              b.gravity = 32;
              b.airDrag = 0.03;
              b.returnAt = time + 0.22;
            }
          }
          if (
            (event.impulse > 8 && time - b.lastContactAt > 0.08) ||
            (!wasEjected && b.ejected)
          ) {
            b.lastContactAt = time;
            b.contacts++;
            this.contacts.push({
              ...event,
              at: time,
              id: b.id,
              before,
              after: { vx: b.vx, vy: b.vy, omega: b.omega },
              ejected: b.ejected,
              part: contact.part,
            });
            this.contacts = this.contacts.slice(-64);
            this.notice(
              b.ejected
                ? "Tacada forte!"
                : Math.abs(b.omega) > 7
                  ? "Raspou · vai voltar"
                  : "Desvio fraco · ele volta",
            );
          }
        }
        // Touching the bat never grants immunity: a weak hit may still reach the player.
        if (this.hits(b, this.player, 21)) {
          b.gone = true;
          this.hurt("O elemento chegou ao personagem.", 0);
        }
      }
      this.shots = this.shots.filter((b) => {
        if (b.gone) return false;
        const escaped = b.ejected && fullyOutside(b);
        if (escaped && !b.credited) {
          b.credited = true;
          this.score++;
          this.notice("Expulso da tela!");
        }
        return !escaped;
      });
      // Finish the previous return before accepting a buffered click. Starting
      // it before integration would skip the last part of the recovery pose.
      if (this.queuedSwing && time >= this.cooldownUntil) this.startSwing(time);
      remaining -= h;
    }
    this.kibes = this.shots;
  }
  drawBat(v) {
    const parts = batCapsules(this.bat);
    for (const p of parts) {
      v.line(p.a, p.b, "#674350", p.radius * 2);
      v.line(
        p.a,
        p.b,
        p.material === "grip" ? "#a66b51" : "#edc7a1",
        p.radius * 2 - 2,
      );
    }
    const c = Math.cos(this.bat.angle),
      s = Math.sin(this.bat.angle),
      base = { x: this.bat.x - c * BAT_COM, y: this.bat.y - s * BAT_COM };
    for (const l of [8, 15, 22]) {
      const p = { x: base.x + c * l, y: base.y + s * l };
      v.line(
        { x: p.x - s * 3.5, y: p.y + c * 3.5 },
        { x: p.x + s * 3.5, y: p.y - c * 3.5 },
        "#d5ab91",
        1.5,
      );
    }
    if (this.swing && this.elapsed - this.swing.at < 0.27) {
      const last = this.contacts.at(-1);
      if (last && this.elapsed - last.at < 0.09) {
        v.circle(last.x, last.y, 3, "#fff0c9");
        v.line(
          { x: last.x - 7, y: last.y - 6 },
          { x: last.x - 12, y: last.y - 11 },
          "#ffad8c",
          2,
        );
      }
    }
  }
  draw(v) {
    this.shots.forEach((b) => v.enemy(b, this.player, b.size));
    this.drawBat(v);
    v.player(this.player, 76);
  }
}
