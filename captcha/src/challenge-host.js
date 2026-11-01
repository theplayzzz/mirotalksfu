import { challenges } from "./games/index.js";
import { W, H } from "./games/kit.js";
import { projectileRotation } from "./engine.js";
import {
  PROJECTILE_HEIGHT,
  maskFromSprite,
  orientedSpriteHitsCircle,
} from "./collision.js";
import { bladeMaskHit } from "./games/blade-geometry.js";
import projectileUrl from "./assets/projectile-emoji-transparent.png";
import {
  drawPlayer,
  playerSpritesReady,
  playerCollisionMask,
} from "./player.js";
import { masksOverlap } from "./mask-overlap.js";

const sprite = new Image();
sprite.src = projectileUrl;
let mask;
export const artworkReady = sprite.decode().then(() => {
  mask = maskFromSprite(sprite);
});
artworkReady.catch(() => {});
const holdGames = new Set([
  "shelter",
  "stretch",
  "slash",
  "jet",
  "web",
  "jump",
  "energy",
]);

class Painter {
  constructor(ctx, host) {
    this.ctx = ctx;
    this.host = host;
  }
  rect(x, y, w, h, color, r = 8) {
    if (w <= 0 || h <= 0) return;
    const c = this.ctx;
    c.fillStyle = color;
    c.beginPath();
    c.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
    c.fill();
  }
  circle(x, y, r, fill, stroke) {
    const c = this.ctx;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = 2;
      c.stroke();
    }
  }
  line(a, b, color, width = 2) {
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
  }
  text(text, x, y, size = 16, color = "#c7b7d4", align = "center") {
    const c = this.ctx;
    c.font = `600 ${size}px "Segoe UI",sans-serif`;
    c.fillStyle = color;
    c.textAlign = align;
    c.fillText(text, x, y);
  }
  bar(x, y, w, ratio, color, label) {
    this.rect(x, y, w, 7, "#c5a6e01c", 3);
    this.rect(x, y, w * Math.max(0, Math.min(1, ratio)), 7, color, 3);
    if (label) this.text(label, x, y - 13, 12, "#c7b7d4", "left");
  }
  player(p, size = 68, angle = 0) {
    drawPlayer(this.ctx, p.x, p.y, {
      size,
      angle,
      impacted:
        this.host.sim.elapsed < this.host.sim.hitUntil ||
        this.host.state === "impact" ||
        (this.host.state === "finished" && this.host.sim.reason !== "survived"),
    });
  }
  enemy(p, target = this.host.sim.player, size = p.size || 54) {
    if (!sprite.naturalWidth) return;
    const c = this.ctx;
    c.save();
    c.translate(p.x, p.y);
    if (p.flipY) c.scale(1, -1);
    c.rotate(
      Number.isFinite(p.rotation) ? p.rotation : projectileRotation(p, target),
    );
    c.drawImage(sprite, -size * 0.4, -size / 2, size * 0.8, size);
    c.restore();
  }
  enemyPiece(p) {
    if (!sprite.naturalWidth || !p.clip.length) return;
    const c = this.ctx;
    c.save();
    c.globalAlpha = Math.min(1, (p.life - p.age) / 0.22);
    c.translate(p.x, p.y);
    if (p.flipY) c.scale(1, -1);
    c.rotate(p.rotation);
    c.translate(-p.localCx, -p.localCy);
    c.beginPath();
    p.clip.forEach((v, i) => (i ? c.lineTo(v.x, v.y) : c.moveTo(v.x, v.y)));
    c.closePath();
    c.clip();
    c.drawImage(sprite, -p.size * 0.4, -p.size / 2, p.size * 0.8, p.size);
    c.restore();
  }
}

// Every prototype shares the same lifecycle and can be mounted inside a stream tile.
export class ChallengeHost {
  constructor(canvas, id, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.id = id;
    this.callbacks = {
      onState() {},
      onTick() {},
      onFinish() {},
      onImpact() {},
      onCut() {},
      ...callbacks,
    };
    this.options = { duration: 25, intensity: 0.9 };
    this.state = "ready";
    this.frame = 0;
    this.last = 0;
    this.clock = 0;
    this.countdown = 0;
    this.abort = new AbortController();
    this.playerSpritesLoaded = false;
    this.painter = new Painter(this.ctx, this);
    const signal = this.abort.signal;
    const position = (e) => {
      const r = canvas.getBoundingClientRect();
      this.sim.move(
        ((e.clientX - r.left) * W) / r.width,
        ((e.clientY - r.top) * H) / r.height,
      );
    };
    canvas.addEventListener(
      "pointermove",
      (e) => {
        if (["playing", "countdown"].includes(this.state)) {
          const points =
            this.id === "slash" && e.getCoalescedEvents
              ? e.getCoalescedEvents()
              : [];
          if (points.length) for (const p of points) position(p);
          else position(e);
        }
      },
      { signal },
    );
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (
          this.state === "countdown" &&
          holdGames.has(this.id) &&
          e.button === 0
        ) {
          e.preventDefault();
          canvas.setPointerCapture(e.pointerId);
          position(e);
          this.pendingHold = true;
          return;
        }
        if (this.state !== "playing") return;
        e.preventDefault();
        canvas.focus({ preventScroll: true });
        canvas.setPointerCapture(e.pointerId);
        position(e);
        if (e.button === 2) this.sim.secondary();
        else this.sim.press();
      },
      { signal },
    );
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), {
      signal,
    });
    window.addEventListener(
      "pointerup",
      (e) => {
        if (e.button !== 2) this.pendingHold = false;
        if (this.state === "playing" && e.button !== 2) {
          if (this.id === "slash" && this.sim.input.down) position(e);
          this.sim.release();
        }
      },
      { signal },
    );
    canvas.addEventListener("pointercancel", () => this.clearInput(), {
      signal,
    });
    canvas.addEventListener(
      "keydown",
      (e) => {
        if (this.id === "climb") return;
        const key = e.key.toLowerCase();
        if (
          ![
            " ",
            "enter",
            "arrowleft",
            "arrowright",
            "arrowup",
            "arrowdown",
            "a",
            "d",
            "w",
            "s",
          ].includes(key)
        )
          return;
        e.preventDefault();
        if (this.state !== "playing") return;
        this.sim.input.keys.add(key);
        if (e.repeat) return;
        if (key === " " || key === "enter") {
          if (this.sim.grid) this.sim.chooseCursor();
          else this.sim.press();
        } else this.sim.key(key);
      },
      { signal },
    );
    window.addEventListener(
      "keyup",
      (e) => {
        const key = e.key.toLowerCase();
        this.sim.input.keys.delete(key);
        if ((key === " " || key === "enter") && this.state === "playing")
          this.sim.release();
      },
      { signal },
    );
    window.addEventListener("blur", () => this.pause(), { signal });
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
    Promise.all([artworkReady, playerSpritesReady])
      .then(() => {
        if (!signal.aborted) {
          this.projectileMask = mask;
          this.playerSpritesLoaded = true;
          this.render();
        }
      })
      .catch(() => {});
  }
  clearInput() {
    if (this.id === "web") this.sim?.release({ kick: false });
    this.pendingHold = false;
    this.sim.input.keys.clear();
    this.sim.input.down = false;
    this.sim.lastPoint = null;
  }
  changeState(state) {
    this.state = state;
    this.callbacks.onState(state);
  }
  reset() {
    cancelAnimationFrame(this.frame);
    this.last = 0;
    this.clock = 0;
    this.countdown = 0;
    this.pendingHold = false;
    this.lastCutScore = 0;
    this.sim = new challenges[this.id]({
      ...this.options,
      bodyHit: (source, player) =>
        masksOverlap(mask, source, playerCollisionMask, player),
      hits: (source, circle, r = 21) => {
        if (!mask) return false;
        return orientedSpriteHitsCircle(
          mask,
          source,
          Number.isFinite(source.rotation)
            ? source.rotation
            : projectileRotation(source, source.aim || this.sim.player),
          circle,
          r,
        );
      },
      sliceHit: (source, line, previous) =>
        bladeMaskHit(
          mask,
          source,
          Number.isFinite(source.rotation)
            ? source.rotation
            : projectileRotation(source, this.sim.player),
          line,
          previous,
        ),
    });
    this.changeState("ready");
    this.render();
  }
  start(options = {}) {
    this.options = { ...this.options, ...options };
    this.reset();
    this.countdown = this.id === "stretch" ? 0 : 2.4;
    this.changeState(this.id === "stretch" ? "playing" : "countdown");
    this.canvas.focus({ preventScroll: true });
    this.frame = requestAnimationFrame(this.loop);
  }
  pause() {
    if (!["playing", "countdown"].includes(this.state)) return;
    this.previousState = this.state;
    this.clearInput();
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
  action() {
    if (this.state !== "playing") return;
    this.sim.press();
    this.sim.release();
  }
  loop(now) {
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0;
    this.last = now;
    this.clock += dt;
    if (this.state === "countdown") {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        const held = this.pendingHold;
        this.pendingHold = false;
        this.changeState("playing");
        if (held) this.sim.press();
      }
    } else if (this.state === "playing") {
      const hitBefore = this.sim.hitCount;
      this.sim.step(dt);
      if (this.id === "slash" && this.sim.cutCount > this.lastCutScore) {
        this.callbacks.onCut(this.sim.cutCount - this.lastCutScore);
        this.lastCutScore = this.sim.cutCount;
      }
      const hitNow = this.sim.hitCount > hitBefore;
      if (hitNow) this.callbacks.onImpact();
      if (this.sim.finished) {
        this.clearInput();
        if (this.sim.reason === "survived") this.completeRound();
        else {
          this.impactAt = this.clock;
          this.changeState("impact");
          if (!hitNow) this.callbacks.onImpact();
        }
      }
    } else if (this.state === "impact" && this.clock - this.impactAt > 0.6)
      this.completeRound();
    this.render();
    this.callbacks.onTick({
      elapsed: this.sim.elapsed,
      count: this.sim.kibes.length,
      countdown: this.countdown,
      remaining: this.sim.remaining,
      progress: this.sim.progress,
      hint: this.sim.hint,
      score: this.sim.score,
      goal: this.sim.goal,
      lives: this.sim.lives,
      ink: this.sim.ink,
      maxInk: this.sim.maxInk,
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
      detail: this.sim.detail,
      score: this.sim.score,
      goal: this.sim.goal,
    });
  }
  render() {
    if (!this.sim) return;
    const cursor = this.sim.pointerCursor ?? "";
    if (this.canvas.style.cursor !== cursor) this.canvas.style.cursor = cursor;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const d = Math.min(window.devicePixelRatio || 1, 2),
      w = Math.round(r.width * d),
      h = Math.round(r.height * d);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const c = this.ctx;
    c.setTransform(w / W, 0, 0, h / H, 0, 0);
    const gradient = c.createRadialGradient(480, 290, 0, 480, 290, 620);
    gradient.addColorStop(0, "#332a43");
    gradient.addColorStop(1, "#211b2c");
    c.fillStyle = gradient;
    c.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 48)
      this.painter.line({ x, y: 0 }, { x, y: H }, "#cfb4f007", 1);
    for (let y = 0; y < H; y += 48)
      this.painter.line({ x: 0, y }, { x: W, y }, "#cfb4f007", 1);
    this.sim.draw(this.painter);
    if (this.state === "impact") {
      c.fillStyle = `rgba(255,168,139,${Math.max(0, 0.25 - (this.clock - this.impactAt) * 0.4)})`;
      c.fillRect(0, 0, W, H);
    }
  }
  destroy() {
    cancelAnimationFrame(this.frame);
    this.abort.abort();
    this.resize.disconnect();
    this.canvas.style.cursor = "";
  }
}
