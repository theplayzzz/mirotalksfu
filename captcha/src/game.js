import {
  PeachSimulation,
  WIDTH,
  HEIGHT,
  MAX_DURATION,
  PLAYER_RADIUS,
  projectileRotation,
} from "./engine.js";
import {
  PROJECTILE_HEIGHT,
  maskFromSprite,
  alphaMaskHitsCircle,
} from "./collision.js";
import projectileUrl from "./assets/projectile-emoji-transparent.png";
import { drawPlayer, playerSpritesReady } from "./player.js";

const projectileSprite = new Image();
projectileSprite.src = projectileUrl;

function projectile(ctx, source, target, size = PROJECTILE_HEIGHT) {
  if (!projectileSprite.complete || !projectileSprite.naturalWidth) return;
  ctx.save();
  ctx.translate(source.x, source.y);
  ctx.rotate(projectileRotation(source, target));
  const width =
    (size * projectileSprite.naturalWidth) / projectileSprite.naturalHeight;
  ctx.drawImage(projectileSprite, -width / 2, -size / 2, width, size);
  ctx.restore();
}

export class PeachGame {
  constructor(
    canvas,
    {
      onState = () => {},
      onTick = () => {},
      onFinish = () => {},
      onImpact = () => {},
    } = {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.callbacks = { onState, onTick, onFinish, onImpact };
    this.options = { duration: MAX_DURATION, intensity: 0.9 };
    this.state = "ready";
    this.keys = new Set();
    this.frame = 0;
    this.countdown = 0;
    this.clock = 0;
    this.last = 0;
    this.abort = new AbortController();
    this.projectileMask = null;
    this.playerSpritesLoaded = false;
    playerSpritesReady
      .then(() => {
        if (!this.abort.signal.aborted) {
          this.playerSpritesLoaded = true;
          this.render();
        }
      })
      .catch(() => {});
    projectileSprite
      .decode()
      .then(() => {
        if (!this.abort.signal.aborted) {
          this.projectileMask = maskFromSprite(projectileSprite);
          this.render();
        }
      })
      .catch(() => {});
    const signal = this.abort.signal;
    canvas.addEventListener("pointermove", (event) => this.pointer(event), {
      signal,
    });
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (this.state !== "playing") return;
        canvas.setPointerCapture(event.pointerId);
        this.pointer(event);
      },
      { signal },
    );
    canvas.addEventListener(
      "keydown",
      (event) => {
        const key = event.key.toLowerCase();
        if (
          [
            "arrowup",
            "arrowdown",
            "arrowleft",
            "arrowright",
            "w",
            "a",
            "s",
            "d",
          ].includes(key)
        ) {
          event.preventDefault();
          this.keys.add(key);
        }
      },
      { signal },
    );
    window.addEventListener(
      "keyup",
      (event) => this.keys.delete(event.key.toLowerCase()),
      { signal },
    );
    window.addEventListener(
      "blur",
      () => {
        this.keys.clear();
        this.pause();
      },
      { signal },
    );
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) this.pause();
      },
      { signal },
    );
    this.resize = new ResizeObserver(() => this.render());
    this.resize.observe(canvas);
    this.loop = this.loop.bind(this);
    this.reset();
  }

  pointer(event) {
    if (this.state !== "playing") return;
    const rect = this.canvas.getBoundingClientRect();
    this.sim.move(
      ((event.clientX - rect.left) * WIDTH) / rect.width,
      ((event.clientY - rect.top) * HEIGHT) / rect.height,
    );
  }

  changeState(state) {
    this.state = state;
    this.callbacks.onState(state);
  }

  reset() {
    cancelAnimationFrame(this.frame);
    this.keys.clear();
    this.sim = new PeachSimulation({
      ...this.options,
      hitTest: (source, player) =>
        alphaMaskHitsCircle(
          this.projectileMask,
          source,
          projectileRotation(source, player),
          player,
          PLAYER_RADIUS,
        ),
    });
    this.clock = 0;
    this.changeState("ready");
    this.render();
  }

  start(options = {}) {
    this.options = { ...this.options, ...options };
    this.reset();
    this.countdown = 2.4;
    this.last = 0;
    this.changeState("countdown");
    this.canvas.focus({ preventScroll: true });
    this.frame = requestAnimationFrame(this.loop);
  }

  pause() {
    if (!["playing", "countdown"].includes(this.state)) return;
    this.previousState = this.state;
    this.keys.clear();
    cancelAnimationFrame(this.frame);
    this.changeState("paused");
  }

  resume() {
    if (this.state !== "paused") return;
    this.last = 0;
    this.changeState(this.previousState);
    this.canvas.focus({ preventScroll: true });
    this.frame = requestAnimationFrame(this.loop);
  }

  loop(now) {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0;
    this.last = now;
    this.clock += dt;
    if (this.state === "countdown") {
      this.countdown -= dt;
      if (this.countdown <= 0) this.changeState("playing");
    } else if (this.state === "playing") {
      let dx = 0,
        dy = 0;
      if (this.keys.has("arrowleft") || this.keys.has("a")) dx--;
      if (this.keys.has("arrowright") || this.keys.has("d")) dx++;
      if (this.keys.has("arrowup") || this.keys.has("w")) dy--;
      if (this.keys.has("arrowdown") || this.keys.has("s")) dy++;
      if (dx || dy) {
        const length = Math.hypot(dx, dy);
        this.sim.move(
          this.sim.target.x + (dx / length) * 550 * dt,
          this.sim.target.y + (dy / length) * 550 * dt,
        );
      }
      this.sim.step(dt);
      if (this.sim.finished) {
        if (this.sim.reason === "impact") {
          this.impactAt = this.clock;
          this.changeState("impact");
          this.callbacks.onImpact();
        } else {
          this.completeRound();
        }
      }
    } else if (this.state === "impact" && this.clock - this.impactAt > 0.6) {
      this.completeRound();
    }
    this.render();
    this.callbacks.onTick({
      elapsed: this.sim.elapsed,
      count: this.sim.kibes.length,
      countdown: this.countdown,
      remaining: this.sim.remaining,
      progress: this.sim.progress,
      duplications: this.sim.duplications,
      speed: this.sim.speed,
    });
    if (["countdown", "playing", "impact"].includes(this.state))
      this.frame = requestAnimationFrame(this.loop);
  }

  completeRound() {
    this.changeState("finished");
    this.callbacks.onFinish({
      elapsed: this.sim.elapsed,
      duration: this.sim.duration,
      count: this.sim.kibes.length,
      reason: this.sim.reason,
    });
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.sim) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.round(rect.width * ratio),
      height = Math.round(rect.height * ratio);
    if (!width || !height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    ctx.setTransform(width / WIDTH, 0, 0, height / HEIGHT, 0, 0);
    const gradient = ctx.createRadialGradient(480, 290, 0, 480, 290, 620);
    gradient.addColorStop(0, "#332a43");
    gradient.addColorStop(1, "#211b2c");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = "#cfb4f009";
    ctx.lineWidth = 1;
    for (let x = 0; x < WIDTH; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y < HEIGHT; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WIDTH, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "#cfb4f01a";
    ctx.strokeRect(20, 20, WIDTH - 40, HEIGHT - 40);
    if (this.state === "ready") {
      drawPlayer(ctx, 155, 345, { size: 170 });
      projectile(ctx, { x: 155, y: 110 }, { x: 155, y: 345 }, 94);
      projectile(ctx, { x: 798, y: 150 }, { x: 155, y: 345 }, 118);
      ctx.setLineDash([5, 7]);
      ctx.strokeStyle = "#b49cc03a";
      ctx.beginPath();
      ctx.moveTo(790, 185);
      ctx.bezierCurveTo(720, 320, 842, 400, 715, 431);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    for (const item of this.sim.kibes) {
      projectile(ctx, item, this.sim.player);
    }
    const hit = this.state === "impact";
    const hitAge = hit ? this.clock - this.impactAt : 0;
    drawPlayer(ctx, this.sim.player.x, this.sim.player.y, {
      size: hit ? 76 + Math.sin(hitAge * 45) * 4 : 76,
      angle: Math.max(
        -0.25,
        Math.min(0.25, (this.sim.target.x - this.sim.player.x) * 0.002),
      ),
      impacted:
        hit || (this.state === "finished" && this.sim.reason === "impact"),
    });
    if (hit) {
      ctx.fillStyle = `rgba(255,168,139,${Math.max(0, 0.4 - hitAge)})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.strokeStyle = "#ffd0ac";
      ctx.lineWidth = 3;
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const inner = 40 + hitAge * 70;
        ctx.beginPath();
        ctx.moveTo(
          this.sim.player.x + Math.cos(angle) * inner,
          this.sim.player.y + Math.sin(angle) * inner,
        );
        ctx.lineTo(
          this.sim.player.x + Math.cos(angle) * (inner + 12),
          this.sim.player.y + Math.sin(angle) * (inner + 12),
        );
        ctx.stroke();
      }
    }
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.abort.abort();
    this.resize.disconnect();
  }
}

export function createSqueak() {
  let context;
  return async () => {
    try {
      context ||= new AudioContext();
      await context.resume();
      const t = context.currentTime;
      const voice = context.createOscillator();
      const vibrato = context.createOscillator();
      const depth = context.createGain();
      const volume = context.createGain();
      voice.type = "triangle";
      voice.frequency.setValueAtTime(520, t);
      voice.frequency.exponentialRampToValueAtTime(1170, t + 0.08);
      voice.frequency.exponentialRampToValueAtTime(680, t + 0.3);
      voice.frequency.exponentialRampToValueAtTime(350, t + 0.42);
      vibrato.frequency.value = 27;
      depth.gain.value = 44;
      vibrato.connect(depth).connect(voice.frequency);
      volume.gain.setValueAtTime(0, t);
      volume.gain.linearRampToValueAtTime(0.085, t + 0.015);
      volume.gain.exponentialRampToValueAtTime(0.001, t + 0.44);
      voice.connect(volume).connect(context.destination);
      voice.start(t);
      vibrato.start(t);
      voice.stop(t + 0.46);
      vibrato.stop(t + 0.46);
      voice.onended = () => {
        voice.disconnect();
        vibrato.disconnect();
        depth.disconnect();
        volume.disconnect();
      };
    } catch {
      /* Audio is optional; it must never prevent the game from ending. */
    }
  };
}
