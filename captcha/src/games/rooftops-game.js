import { Challenge, clamp, distance } from "./kit.js";
import { gapElements } from "./roof-course.js";
import {
  makePlayer,
  playerCircles,
  playerExtents,
  stepRoofBody,
  roofEquilibrium,
  ROOF_GRAVITY,
} from "./roof-physics.js";

export class Stretch extends Challenge {
  constructor(o = {}) {
    super(o);
    this.goal = clamp(Math.floor(this.duration / 5), 2, 5);
    this.metric = "telhados";
    this.launchX = 5.25;
    this.launchY = 5.7;
    this.previewDescendingDots = 2;
    this.groundY = 514;
    this.gapHazards = o.gapHazards ?? true;
    this.cameraX = 0;
    this.buildings = [{ id: 0, x: 90, y: 434, w: 120, h: this.groundY - 434 }];
    this.support = this.buildings[0];
    let heightDelta = -104;
    for (let i = 1; i <= this.goal; i++) {
      const previous = this.buildings.at(-1),
        final = i === this.goal,
        w = (final ? 172 : Math.max(104, 136 - i * 10)) * (1 - (this.intensity - 0.9) * 0.24),
        center =
          previous.x +
          previous.w / 2 +
          (final ? this.rand(440, 470) : this.rand(345, 380)),
        y =
          i === 1
            ? 330
            : clamp(
                previous.y +
                  (heightDelta < 0 ? this.rand(35, 75) : this.rand(-105, -65)),
                190,
                410,
              );
      heightDelta = y - previous.y;
      this.buildings.push({
        id: i,
        x: center - w / 2,
        y,
        w,
        h: this.groundY - y,
        final,
      });
    }
    this.finish = this.buildings.at(-1);
    this.courseLength = this.finish.x + this.finish.w / 2 - 150;
    this.allFloor = this.gapHazards
      ? gapElements(this.buildings, this.groundY)
      : [];
    this.body = makePlayer(150, this.support.y - playerExtents().bottom - 0.02);
    this.player = { x: this.body.x, y: this.body.y };
    this.anchor = { ...this.player };
    this.anchorAngle = 0;
    this.phase = "aim";
    this.clockStarted = false;
    this.pull = { x: 0, y: 0 };
    this.bounces = 0;
    this.lastBounce = -10;
    this.restTime = 0;
    this.contacts = [];
    this.preview = [];
    this.newTarget();
  }
  get vx() {
    return this.body.vx;
  }
  get vy() {
    return this.body.vy;
  }
  canGrab(point) {
    return this.phase === "aim" && distance(point, this.player) <= 55;
  }
  get pointerCursor() {
    if (this.finished || this.phase !== "aim") return "default";
    if (this.input.down) return "grabbing";
    return this.canGrab({ x: this.input.x + this.cameraX, y: this.input.y })
      ? "grab"
      : "default";
  }
  newTarget() {
    this.target = this.buildings[Math.min(this.score + 1, this.goal)];
    this.pull = { x: 0, y: 0 };
    this.bounces = 0;
    this.preview = [];
    this.hint =
      "Segure o emoji, puxe para trás e para baixo. Solte para saltar.";
    this.refreshFloor();
  }
  refreshFloor() {
    this.floor = this.allFloor.filter(
      (b) => b.x > this.cameraX - 70 && b.x < this.cameraX + 1030,
    );
    this.kibes = this.floor;
  }
  launchBody() {
    const body = makePlayer(
      this.anchor.x + this.pull.x * 0.28,
      this.anchor.y + Math.min(0, this.pull.y * 0.28),
      this.anchorAngle,
    );
    body.vx = -this.pull.x * this.launchX;
    body.vy = -this.pull.y * this.launchY;
    return body;
  }
  refreshPreview() {
    this.preview = [];
    const body = this.launchBody();
    this.player = { x: body.x, y: body.y };
    if (Math.hypot(this.pull.x, this.pull.y) < 8) return;
    const maxSteps = Math.ceil(
      (Math.max(0, -body.vy) / ROOF_GRAVITY + 0.25) * 120,
    );
    let previousY = body.y,
      descending = 0;
    for (let i = 0; i < maxSteps; i++) {
      const events = stepRoofBody(body, this.buildings, 1 / 120);
      if (events.some((p) => p.impulse > 5)) break;
      if (i % 6 === 0) {
        this.preview.push({ x: body.x, y: body.y, time: (i + 1) / 120 });
        descending = body.y > previousY + 1e-7 ? descending + 1 : 0;
        previousY = body.y;
        if (descending >= this.previewDescendingDots) break;
      }
      if (body.y > this.groundY) break;
    }
  }
  move(x, y) {
    super.move(x, y);
    if (this.phase !== "aim" || !this.input.down) return;
    const dx = this.input.x + this.cameraX - this.anchor.x,
      dy = this.input.y - this.anchor.y;
    const f = Math.min(1, 140 / (Math.hypot(dx, dy) || 1));
    this.pull = { x: dx * f, y: dy * f };
    this.refreshPreview();
    this.hint =
      Math.hypot(this.pull.x, this.pull.y) >= 8
        ? "Solte o mouse para lançar. A mira vai até o início da descida."
        : "Puxe o emoji para trás e para baixo; depois solte.";
  }
  press() {
    const world = { x: this.input.x + this.cameraX, y: this.input.y };
    if (!this.canGrab(world)) return;
    super.press();
    this.move(this.input.x, this.input.y);
  }
  release() {
    if (!this.input.down) return;
    super.release();
    if (this.phase !== "aim" || Math.hypot(this.pull.x, this.pull.y) < 8) {
      this.hint =
        "Segure o emoji, puxe para trás e para baixo. Solte para saltar.";
      return;
    }
    this.body = this.launchBody();
    this.player = { x: this.body.x, y: this.body.y };
    this.phase = "flying";
    this.clockStarted = true;
    this.bounces = 0;
    this.restTime = 0;
    this.hint = "Espere o emoji se acomodar no telhado para puxar novamente.";
  }
  update(dt) {
    if (!this.input.down) {
      const target = Math.max(0, this.body.x - 245);
      this.cameraX += (target - this.cameraX) * (1 - Math.exp(-dt / 0.14));
    }
    this.refreshFloor();
    if (this.phase === "aim") return;
    const events = stepRoofBody(this.body, this.buildings, dt);
    this.player = { x: this.body.x, y: this.body.y };
    for (const event of events) {
      if (event.impulse > 18) {
        this.contacts.push({ ...event, at: this.elapsed });
        this.contacts = this.contacts.slice(-24);
      }
      if (
        event.ny < -0.65 &&
        event.normalSpeed < -70 &&
        this.elapsed - this.lastBounce > 0.08
      ) {
        this.bounces++;
        this.lastBounce = this.elapsed;
      }
    }
    const roof = roofEquilibrium(this.body, this.buildings);
    if (
      roof &&
      Math.hypot(this.body.vx, this.body.vy) < 18 &&
      Math.abs(this.body.omega) < 0.5
    ) {
      this.restTime += dt;
      if (this.restTime > 0.3) {
        this.body.vx = this.body.vy = this.body.omega = 0;
        this.support = roof;
        this.anchor = { x: this.body.x, y: this.body.y };
        this.anchorAngle = this.body.angle;
        this.phase = "aim";
        this.pull = { x: 0, y: 0 };
        this.preview = [];
        if (roof.id > this.score) this.point(roof.id - this.score);
        if (!this.finished) this.newTarget();
      }
    } else this.restTime = 0;
    const circles = playerCircles(this.body);
    if (this.gapHazards)
      for (const b of this.floor)
        for (const c of circles) {
          if (this.hits(b, c, c.r)) {
            this.fail("O emoji caiu sobre os elementos entre os prédios.");
            break;
          }
        }
    if (circles.some((c) => c.y + c.r >= this.groundY))
      this.fail("O emoji caiu no vão entre os prédios.");
    if (
      this.body.x < -100 ||
      this.body.y < -180 ||
      this.body.x > this.finish.x + this.finish.w + 500
    )
      this.fail("O emoji saiu da área dos prédios.");
  }
  step(seconds) {
    if (!this.clockStarted && !this.finished) {
      this.update(clamp(seconds, 0, 0.05));
      return;
    }
    super.step(seconds);
  }
  drawBuilding(v, b) {
    const x = b.x - this.cameraX;
    if (x + b.w < 0 || x > 960) return;
    const active = b.id === this.target.id;
    v.rect(x, b.y, b.w, b.h, active ? "#695064" : "#4c405b", 0);
    v.rect(x + b.w - 8, b.y, 8, b.h, "#211b2c40", 0);
    for (let y = b.y + 22; y < this.groundY - 12; y += 32)
      for (let xx = 12; xx < b.w - 12; xx += 23) {
        v.rect(
          x + xx,
          y,
          11,
          15,
          (Math.floor((y - b.y) / 32) + Math.floor(xx / 23)) % 3 === 0
            ? "#d6ac8280"
            : "#b19ac832",
          1,
        );
      }
    v.rect(x, b.y, b.w, 6, active ? "#b8edcf" : "#a08bac", 0);
    v.line(
      { x: x + 5, y: b.y + 9 },
      { x: x + b.w - 10, y: b.y + 9 },
      "#211b2c55",
      2,
    );
    if (b.final) {
      const pole = x + b.w - 20,
        top = b.y - 65;
      v.line({ x: pole, y: b.y }, { x: pole, y: top }, "#edfff5", 3);
      for (let row = 0; row < 3; row++)
        for (let col = 0; col < 4; col++)
          v.rect(
            pole - 32 + col * 8,
            top + row * 8,
            8,
            8,
            (row + col) % 2 ? "#332a43" : "#b8edcf",
            0,
          );
      v.text("CHEGADA", x + b.w / 2, b.y - 77, 12, "#b8edcf");
    } else if (active)
      v.text(`${b.id} / ${this.goal}`, x + b.w / 2, b.y - 17, 12, "#b8edcf");
  }
  draw(v) {
    v.rect(0, this.groundY, 960, 26, "#15121e", 0);
    v.line(
      { x: 0, y: this.groundY },
      { x: 960, y: this.groundY },
      "#8e7a9e55",
      2,
    );
    this.buildings.forEach((b) => this.drawBuilding(v, b));
    this.floor.forEach((b) =>
      v.enemy(
        { ...b, x: b.x - this.cameraX },
        { x: b.x - this.cameraX, y: 0 },
        b.size,
      ),
    );
    if (this.phase === "aim") {
      const p = this.launchBody(),
        x = p.x - this.cameraX,
        a = this.anchor.x - this.cameraX,
        roof = this.support.y;
      // A single Y frame remains fixed to the roof while the pouch follows
      // the character. The same highlighted area is used by canGrab().
      v.line({ x: a, y: roof - 3 }, { x: a, y: roof - 27 }, "#211b2c", 14);
      v.line({ x: a, y: roof - 3 }, { x: a, y: roof - 27 }, "#b38260", 9);
      for (const side of [-1, 1]) {
        const base = { x: a, y: roof - 27 },
          fork = { x: a + side * 40, y: roof - 56 },
          pouch = { x: x + side * 22, y: p.y + 18 };
        v.line(base, fork, "#211b2c", 12);
        v.line(base, fork, "#e5bc8f", 8);
        v.circle(fork.x, fork.y, 5, "#e5bc8f");
        v.line(fork, pouch, "#211b2c", 6);
        v.line(fork, pouch, "#ffad8c", 3);
      }
      if (!this.input.down) {
        const hover = this.pointerCursor === "grab",
          labelX = clamp(x - 112, 12, 724),
          labelY = p.y - 136;
        v.circle(
          x,
          p.y,
          48,
          hover ? "#ffad8c18" : "#ffad8c09",
          hover ? "#fff0cf" : "#ffad8c99",
        );
        v.line({ x, y: labelY + 52 }, { x, y: p.y - 49 }, "#ffad8c66", 1.5);
        v.rect(labelX, labelY, 224, 52, "#211b2ce8", 10);
        v.rect(labelX + 13, labelY + 13, 17, 25, "#ffad8c", 8);
        v.line(
          { x: labelX + 21.5, y: labelY + 16 },
          { x: labelX + 21.5, y: labelY + 24 },
          "#211b2c",
          2,
        );
        v.text(
          "SEGURE O EMOJI",
          labelX + 43,
          labelY + 22,
          12,
          "#ffbd9f",
          "left",
        );
        v.text(
          "Puxe para trás e para baixo",
          labelX + 43,
          labelY + 40,
          11,
          "#d8cbe4",
          "left",
        );
        const end = { x: x - 98, y: p.y + 45 };
        v.line({ x: x - 47, y: p.y + 6 }, end, "#ffad8c", 2.5);
        v.line(end, { x: end.x + 12, y: end.y - 1 }, "#ffad8c", 2.5);
        v.line(end, { x: end.x + 3, y: end.y - 12 }, "#ffad8c", 2.5);
      }
      this.preview.forEach((dot) =>
        v.circle(dot.x - this.cameraX, dot.y, 3, "#ffbd9fc0"),
      );
      v.player({ x, y: p.y }, 76, p.angle);
      // Front of the pouch stays visible across the lower edge of the emoji.
      v.line(
        { x: x - 21, y: p.y + 23 },
        { x: x + 21, y: p.y + 23 },
        "#674350",
        7,
      );
      v.line(
        { x: x - 19, y: p.y + 22 },
        { x: x + 19, y: p.y + 22 },
        "#e5bc8f",
        3,
      );
    } else
      v.player(
        { x: this.body.x - this.cameraX, y: this.body.y },
        76,
        this.body.angle,
      );
    const last = this.contacts.at(-1);
    if (last && this.elapsed - last.at < 0.1)
      v.circle(last.x - this.cameraX, last.y, 3, "#fff0c9");
  }
}
