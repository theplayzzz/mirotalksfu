// Pure game simulation. No DOM, network, assets or framework; reusable in the room.
import { PLAYFIELD } from "./playfield.js";
export const WIDTH = PLAYFIELD.width;
export const HEIGHT = PLAYFIELD.height;
export const PLAYER_RADIUS = 24;
export const KIBE_RADIUS = 13;
export const MAX_DUPLICATIONS = 8;
export const INITIAL_PROJECTILE_COUNT = 2;
export const MAX_KIBES = INITIAL_PROJECTILE_COUNT * (1 + MAX_DUPLICATIONS);
export const MAX_DURATION = 40;
export const BASE_SPEED = 140;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function inwardVelocity(angle, speed, wallX, wallY) {
  let x = Math.cos(angle),
    y = Math.sin(angle);
  if (wallX) x = wallX * Math.max(0.2, Math.abs(x));
  if (wallY) y = wallY * Math.max(0.2, Math.abs(y));
  const factor = speed / Math.hypot(x, y);
  return { vx: x * factor, vy: y * factor };
}

// The provided artwork's tip points diagonally up-right at its native orientation.
export const projectileRotation = (source, target) =>
  Math.atan2(target.y - source.y, target.x - source.x) + Math.PI / 4;

export class PeachSimulation {
  constructor({
    duration = MAX_DURATION,
    intensity = 0.9,
    random = Math.random,
    hitTest = (projectile, player) =>
      Math.hypot(projectile.x - player.x, projectile.y - player.y) <
      PLAYER_RADIUS + KIBE_RADIUS - 4,
  } = {}) {
    this.duration = clamp(Number(duration) || MAX_DURATION, 8, MAX_DURATION);
    this.intensity = clamp(Number(intensity) || 0.9, 0.7, 1.5);
    this.random = random;
    this.hitTest = hitTest;
    this.elapsed = 0;
    this.bounces = 0;
    this.duplications = 0;
    this.player = { x: WIDTH / 2, y: HEIGHT * 0.65 };
    this.target = { ...this.player };
    this.kibes = Array.from(
      { length: INITIAL_PROJECTILE_COUNT },
      (_, index) => {
        const initialAngle = 0.12 + this.random() * 0.36;
        const direction = index === 0 ? 1 : -1;
        return {
          x: index === 0 ? 110 : WIDTH - 110,
          y: index === 0 ? 95 : HEIGHT - 95,
          vx: direction * Math.cos(initialAngle) * this.speed,
          vy: direction * Math.sin(initialAngle) * this.speed,
          bounces: 0,
          duplicationsLeft: MAX_DUPLICATIONS,
        };
      },
    );
    this.finished = false;
    this.reason = null;
  }

  get progress() {
    return clamp(this.elapsed / this.duration, 0, 1);
  }

  get remaining() {
    return Math.max(0, this.duration - this.elapsed);
  }

  get speed() {
    // Every existing projectile accelerates smoothly, reaching 9x its starting speed.
    return BASE_SPEED * this.intensity * (1 + 8 * this.progress ** 1.65);
  }

  move(x, y) {
    this.target.x = clamp(x, PLAYER_RADIUS, WIDTH - PLAYER_RADIUS);
    this.target.y = clamp(y, PLAYER_RADIUS, HEIGHT - PLAYER_RADIUS);
  }

  step(seconds) {
    // Small physics steps prevent tunnelling through the player on a slow frame.
    let left = clamp(seconds, 0, 0.05);
    while (left > 1e-9 && !this.finished) {
      const dt = Math.min(left, 1 / 120);
      this.advance(dt);
      left -= dt;
    }
  }

  advance(dt) {
    this.elapsed = Math.min(this.duration, this.elapsed + dt);
    const follow = 1 - Math.exp(-dt * 22);
    this.player.x += (this.target.x - this.player.x) * follow;
    this.player.y += (this.target.y - this.player.y) * follow;
    const children = [];
    for (const projectile of this.kibes) {
      const length = Math.hypot(projectile.vx, projectile.vy);
      if (length > 0) {
        projectile.vx = (projectile.vx / length) * this.speed;
        projectile.vy = (projectile.vy / length) * this.speed;
      }
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;
      let wallX = 0,
        wallY = 0;
      if (projectile.x < KIBE_RADIUS || projectile.x > WIDTH - KIBE_RADIUS) {
        wallX = projectile.x < KIBE_RADIUS ? 1 : -1;
        projectile.x = clamp(projectile.x, KIBE_RADIUS, WIDTH - KIBE_RADIUS);
        projectile.vx *= -1;
      }
      if (projectile.y < KIBE_RADIUS || projectile.y > HEIGHT - KIBE_RADIUS) {
        wallY = projectile.y < KIBE_RADIUS ? 1 : -1;
        projectile.y = clamp(projectile.y, KIBE_RADIUS, HEIGHT - KIBE_RADIUS);
        projectile.vy *= -1;
      }
      if (wallX || wallY) {
        this.bounces++;
        projectile.bounces++;
        const outgoing =
          Math.atan2(projectile.vy, projectile.vx) +
          (this.random() - 0.5) * 0.48;
        Object.assign(
          projectile,
          inwardVelocity(outgoing, this.speed, wallX, wallY),
        );
        // Each initial projectile duplicates on its own first eight wall hits; copies never do.
        if (projectile.duplicationsLeft > 0) {
          projectile.duplicationsLeft--;
          this.duplications++;
          const angle =
            Math.atan2(projectile.vy, projectile.vx) +
            (this.random() < 0.5 ? -1 : 1) * (0.25 + this.random() * 0.5);
          children.push({
            x: projectile.x,
            y: projectile.y,
            ...inwardVelocity(angle, this.speed, wallX, wallY),
            bounces: 0,
            duplicationsLeft: 0,
          });
        }
      }
      if (this.elapsed > 2 && this.hitTest(projectile, this.player)) {
        this.finish("impact");
        break;
      }
    }
    this.kibes.push(...children);
    // Surviving the full round is a win; only actual contact can cause a loss.
    if (!this.finished && this.remaining <= 1e-9) {
      this.elapsed = this.duration;
      this.finish("survived");
    }
  }

  finish(reason) {
    this.finished = true;
    this.reason = reason;
  }
}
