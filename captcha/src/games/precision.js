import {
  Challenge,
  W,
  H,
  clamp,
  lerp,
  distance,
  segmentDistance,
} from "./kit.js";

export class Paddle extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: 480, y: 470 };
    this.lives = 3;
    this.balls = [];
    this.addBall();
    this.hint = "Mova a raquete. Até dois erros; o terceiro encerra.";
  }
  addBall() {
    this.balls.push({
      x: this.rand(250, 710),
      y: 130,
      vx: this.rand(-100, 100),
      vy: 200,
    });
  }
  update(dt) {
    this.player.x = clamp(this.axis(700), 95, 865);
    const max = 1 + Number(this.progress > 0.35) + Number(this.progress > 0.7);
    if (this.balls.length < max) this.addBall();
    for (const b of this.balls) {
      const s = lerp(1, 2.5, this.progress) * this.intensity;
      const old = b.y;
      b.x += b.vx * s * dt;
      b.y += b.vy * s * dt;
      if (b.x < 37) {
        b.x = 37;
        b.vx = Math.abs(b.vx);
      }
      if (b.x > 923) {
        b.x = 923;
        b.vx = -Math.abs(b.vx);
      }
      if (b.y < 95) {
        b.y = 95;
        b.vy = Math.abs(b.vy);
      }
      if (
        b.vy > 0 &&
        old < 434 &&
        b.y >= 434 &&
        Math.abs(b.x - this.player.x) < 103
      ) {
        b.y = 434;
        b.vy = -220;
        b.vx = clamp((b.x - this.player.x) * 2.6, -220, 220);
        this.score++;
        this.notice("Boa rebatida!");
      }
      if (b.y > 565) {
        this.hurt("Passou da raquete!");
        b.x = this.rand(180, 780);
        b.y = 120;
        b.vx = this.rand(-100, 100);
        b.vy = 200;
      }
    }
    this.kibes = this.balls;
  }
  draw(v) {
    v.line({ x: 30, y: 94 }, { x: 930, y: 94 }, "#8e7c9c", 2);
    this.balls.forEach((b) => v.enemy(b, this.player));
    v.rect(this.player.x - 88, 452, 176, 13, "#b8edcf", 6);
    v.player({ x: this.player.x, y: 493 }, 58);
    v.text(`${this.score} rebatidas`, 480, 130, 17);
  }
}

export class Rhythm extends Challenge {
  constructor(o) {
    super(o);
    this.goal = Math.max(4, Math.floor(this.duration * 0.48));
    this.lives = 3;
    this.notes = [];
    let t = 1.65;
    for (let i = 0; i < this.goal + 2; i++) {
      this.notes.push({ at: t, hit: false });
      t += i % 4 === 2 ? 0.48 : lerp(1.35, 0.8, i / (this.goal + 2));
    }
    this.hint = "Acerte quando o projétil chegar no anel. Espaço ou clique.";
    this.window = 0.23;
    this.metric = "defesas";
  }
  press() {
    super.press();
    const n = this.notes
      .filter((n) => !n.hit && !n.missed)
      .sort(
        (a, b) => Math.abs(a.at - this.elapsed) - Math.abs(b.at - this.elapsed),
      )[0];
    if (n && Math.abs(n.at - this.elapsed) <= this.window) {
      n.hit = true;
      this.point();
      this.pulse = this.elapsed;
      this.notice("No tempo!");
    } else this.hurt("Fora do compasso!");
  }
  update() {
    this.window = lerp(0.23, 0.13, this.progress) / Math.sqrt(this.intensity);
    for (const n of this.notes)
      if (!n.hit && !n.missed && this.elapsed > n.at + this.window) {
        n.missed = true;
        this.hurt("Uma nota passou.");
      }
    this.kibes = this.notes.filter((n) => !n.hit && !n.missed);
    if (!this.finished && this.score + this.kibes.length < this.goal)
      this.fail(
        "Não restaram notas suficientes para completar as defesas.",
        "missed",
      );
    this.hint = `${this.score}/${this.goal} defesas · espere o anel acender`;
  }
  draw(v) {
    v.line({ x: 155, y: 290 }, { x: 920, y: 290 }, "#8f7d9e", 3);
    const near = this.notes.some(
      (n) => !n.hit && !n.missed && Math.abs(n.at - this.elapsed) < this.window,
    );
    v.circle(
      280,
      290,
      43,
      near ? "#b8edcf25" : null,
      near ? "#b8edcf" : "#b19ac8",
    );
    for (const n of this.notes) {
      const x = 280 + (n.at - this.elapsed) * 230;
      if (!n.hit && !n.missed && x > 150 && x < 950)
        v.enemy({ x, y: 290 }, { x: 280, y: 290 }, 54);
    }
    v.player({ x: 280, y: 400 }, 80);
    v.text(
      near ? "AGORA" : "ESPERE",
      280,
      205,
      22,
      near ? "#b8edcf" : "#a696b9",
    );
    v.text(`${this.score} / ${this.goal}`, 680, 405, 42, "#fff3eb");
    v.text("notas duplas também contam", 680, 440, 15);
  }
}

export class Tower extends Challenge {
  constructor(o) {
    super(o);
    this.goal = this.duration < 14 ? 4 : 8;
    this.metric = "andares";
    this.stack = [{ x: 360, w: 240 }];
    this.moving = { x: 80, w: 240 };
    this.dir = 1;
    this.cooldown = 0;
    this.hint = "Clique quando a peça estiver alinhada com a torre.";
    this.player = { x: 480, y: 441 };
  }
  press() {
    super.press();
    if (this.cooldown > 0) return;
    const prev = this.stack.at(-1),
      left = Math.max(prev.x, this.moving.x),
      right = Math.min(prev.x + prev.w, this.moving.x + this.moving.w),
      width = right - left;
    if (width < 15) {
      this.fail("A plataforma perdeu o apoio.");
      return;
    }
    const perfect = Math.abs(this.moving.x - prev.x) < 7;
    this.stack.push({
      x: perfect ? prev.x : left,
      w: perfect ? prev.w : width,
    });
    this.score++;
    this.notice(perfect ? "Encaixe perfeito!" : "A borda ficou para trás");
    if (this.score >= this.goal) {
      this.win("O emoji chegou ao topo!");
      return;
    }
    this.moving = {
      x: this.dir > 0 ? W - width - 30 : 30,
      w: this.stack.at(-1).w,
    };
    this.dir *= -1;
    this.cooldown = 0.2;
  }
  update(dt) {
    this.cooldown -= dt;
    this.moving.x += this.dir * (180 + this.score * 34) * this.intensity * dt;
    if (this.moving.x < 25) {
      this.moving.x = 25;
      this.dir = 1;
    }
    if (this.moving.x + this.moving.w > 935) {
      this.moving.x = 935 - this.moving.w;
      this.dir = -1;
    }
    const p = this.stack.at(-1);
    this.player = { x: p.x + p.w / 2, y: 442 - this.score * 37 };
  }
  draw(v) {
    v.rect(280, 491, 400, 5, "#8f7d9e");
    this.stack.forEach((b, i) =>
      v.rect(b.x, 466 - i * 37, b.w, 31, i % 2 ? "#ad96c5" : "#8f7ca6", 5),
    );
    if (!this.finished)
      v.rect(
        this.moving.x,
        466 - (this.score + 1) * 37,
        this.moving.w,
        31,
        "#b8edcf",
        5,
      );
    v.player(this.player, 61);
    v.text(`${this.score} / ${this.goal} andares`, 785, 115, 20);
    v.text("CLIQUE PARA SOLTAR", 480, 520, 14, "#b8edcf");
  }
}

export class Stretch extends Challenge {
  constructor(o) {
    super(o);
    this.goal = this.duration < 12 ? 2 : 3;
    this.metric = "travessias";
    this.lives = 3;
    this.length = 0;
    this.crossing = 0;
    this.newGap();
    this.hint = "Segure para esticar. A ponta precisa terminar na faixa verde.";
  }
  newGap() {
    this.from = { x: 110, y: 424, w: 130 };
    this.to = { x: this.rand(435, 665), y: 424, w: 120 - this.score * 23 };
    this.player = { x: 210, y: 395 };
    this.length = 0;
  }
  press() {
    if (this.crossing > 0) return;
    super.press();
    this.length = 0;
  }
  release() {
    if (!this.input.down) return;
    super.release();
    const tip = 240 + this.length;
    if (tip >= this.to.x && tip <= this.to.x + this.to.w) {
      this.crossing = 0.7;
      this.notice("Ponte no ponto!");
    } else {
      this.hurt(tip < this.to.x ? "Faltou ponte." : "Passou da plataforma.");
      this.length = 0;
    }
  }
  update(dt) {
    if (this.crossing > 0) {
      this.crossing -= dt;
      this.player.x = lerp(
        210,
        this.to.x + this.to.w / 2,
        clamp(1 - this.crossing / 0.7, 0, 1),
      );
      if (this.crossing <= 0) {
        this.point();
        if (!this.finished) this.newGap();
      }
    } else if (this.input.down)
      this.length = clamp(
        this.length + (210 + this.score * 45) * this.intensity * dt,
        0,
        650,
      );
  }
  draw(v) {
    v.rect(110, 424, 130, 100, "#847093");
    v.rect(this.to.x, 424, this.to.w, 100, "#b8edcf70");
    v.rect(this.to.x, 416, this.to.w, 8, "#b8edcf");
    if (this.length) v.rect(240, 414, this.length, 8, "#ffad8c", 3);
    v.player(this.player, 73);
    v.text("CHEGADA", this.to.x + this.to.w / 2, 465, 13, "#b8edcf");
    v.text(`${this.score} / ${this.goal} pontes`, 480, 165, 32, "#fff3eb");
    v.text(
      this.input.down ? "ESTICANDO…" : "SEGURE → SOLTE",
      480,
      215,
      17,
      "#cbb9db",
    );
  }
}

export class Slash extends Challenge {
  constructor(o) {
    super(o);
    this.goal = Math.max(5, Math.ceil(this.duration * 0.55));
    this.metric = "cortes";
    this.lives = 4;
    this.targets = [];
    this.next = 0.4;
    this.lastPoint = null;
    this.trail = [];
    this.hint = "Arraste segurando: corte projéteis, poupe os rostos.";
  }
  cut(a, b) {
    const n = Math.max(1, Math.ceil(distance(a, b) / 7));
    for (const t of this.targets) {
      if (t.cut) continue;
      let hit = false;
      for (let j = 0; j <= n && !hit; j++) {
        const p = { x: lerp(a.x, b.x, j / n), y: lerp(a.y, b.y, j / n) };
        hit = t.friend ? distance(t, p) < 26 : this.hits(t, p, 9);
      }
      if (hit) {
        t.cut = true;
        if (t.friend) this.hurt("Você cortou um emoji!");
        else this.point();
      }
    }
  }
  move(x, y) {
    super.move(x, y);
    const p = { x: this.input.x, y: this.input.y };
    if (this.input.down) {
      if (this.lastPoint) this.cut(this.lastPoint, p);
      this.trail.push({ ...p, at: this.elapsed });
    }
    this.lastPoint = p;
  }
  press() {
    super.press();
    this.lastPoint = { x: this.input.x, y: this.input.y };
    this.cut(this.lastPoint, this.lastPoint);
  }
  release() {
    super.release();
    this.lastPoint = null;
  }
  update(dt) {
    if (this.elapsed >= this.next) {
      const x = this.rand(150, 810);
      this.targets.push({
        x,
        y: 580,
        vx: this.rand(-75, 75),
        vy: -this.rand(430, 510),
        friend: this.random() < 0.18,
        size: 64,
        aim: { x, y: 0 },
      });
      this.next =
        this.elapsed + lerp(0.8, 0.48, this.progress) / this.intensity;
    }
    for (const t of this.targets) {
      t.vy += 560 * dt;
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      if (t.y > 620 && !t.cut && !t.friend) {
        t.cut = true;
        this.hurt("Um projétil escapou do corte.");
      }
    }
    this.targets = this.targets.filter((t) => !t.cut && t.y < 640);
    this.kibes = this.targets;
    this.trail = this.trail.filter((p) => this.elapsed - p.at < 0.16);
    const k = this.input.keys;
    if (k.size) {
      let x = this.axis(700),
        y = this.input.y;
      if (k.has("arrowup")) y -= 700 * dt;
      if (k.has("arrowdown")) y += 700 * dt;
      this.move(x, y);
    }
  }
  draw(v) {
    this.targets.forEach((t) =>
      t.friend ? v.player(t, 65) : v.enemy(t, t.aim, 64),
    );
    for (let i = 1; i < this.trail.length; i++)
      v.line(this.trail[i - 1], this.trail[i], "#b8edcf", 4);
    v.circle(this.input.x, this.input.y, 10, null, "#b8edcf");
    v.text(`${this.score} / ${this.goal} cortes`, 480, 111, 26);
  }
}

export class Juggle extends Challenge {
  constructor(o) {
    super(o);
    this.balls = [];
    this.addBall();
    this.hint = "Clique em cada projétil para lançá-lo para cima.";
  }
  addBall() {
    const x = [480, 245, 715][this.balls.length];
    this.balls.push({ x, y: 240, vx: this.rand(-40, 40), vy: -260 });
  }
  press() {
    super.press();
    const p = { x: this.input.x, y: this.input.y };
    const ball = this.balls.find((b) => distance(b, p) < 53);
    if (ball) {
      ball.vy = -420;
      ball.vx = this.rand(-90, 90);
      this.score++;
      this.notice("Para cima!");
    } else this.notice("Clique no desenho", "bad");
  }
  update(dt) {
    const max = 1 + Number(this.progress > 0.32) + Number(this.progress > 0.65);
    if (this.balls.length < max) this.addBall();
    for (const b of this.balls) {
      b.vy += lerp(310, 540, this.progress) * this.intensity * dt;
      b.y += b.vy * dt;
      b.x += b.vx * dt;
      if (b.y < 115) {
        b.y = 115;
        b.vy = 60;
      }
      if (b.x < 70 || b.x > 890) b.vx *= -1;
      if (b.y > 493) this.fail("Um dos projéteis caiu.");
    }
    this.kibes = this.balls;
  }
  draw(v) {
    v.rect(25, 503, 910, 3, "#ed82b6");
    this.balls.forEach((b) => {
      v.circle(b.x, b.y, 53, null, "#b8edcf22");
      v.enemy(b, { x: b.x, y: 0 }, 65);
    });
    v.player({ x: 480, y: 510 }, 50);
    v.text("NÃO DEIXE TOCAR A LINHA", 480, 95, 15, "#b8edcf");
  }
}

export class Climb extends Challenge {
  constructor(o) {
    super(o);
    this.goal = 8;
    this.metric = "plataformas";
    this.player = { x: 480, y: 455 };
    this.vy = -510;
    this.camera = 0;
    this.platforms = [{ x: 350, y: 500, w: 260, i: 0 }];
    let x = 480;
    for (let i = 1; i <= 8; i++) {
      x = clamp(x + this.rand(-180, 180), 170, 790);
      this.platforms.push({
        x: x - 75,
        y: 500 - i * 96,
        w: 150 - i * 3,
        i,
        phase: this.rand(0, 6),
      });
    }
    this.hint = "O salto é automático. Conduza para a próxima plataforma.";
  }
  update(dt) {
    this.player.x = clamp(this.axis(620), 28, 932);
    const old = this.player.y;
    this.vy += 1100 * dt;
    this.player.y += this.vy * dt;
    for (const p of this.platforms) {
      p.drawX = p.x + (p.i > 3 ? Math.sin(this.elapsed + p.phase) * 22 : 0);
      if (
        this.vy > 0 &&
        old + 22 <= p.y &&
        this.player.y + 22 >= p.y &&
        this.player.x > p.drawX - 8 &&
        this.player.x < p.drawX + p.w + 8
      ) {
        this.player.y = p.y - 22;
        this.vy = -510;
        if (p.i > this.score) {
          this.score = p.i;
          this.notice("Mais um andar!");
          if (this.score >= this.goal) this.win("Você alcançou a saída!");
        }
      }
    }
    this.camera = Math.max(this.camera, 250 - this.player.y);
    if (this.player.y + this.camera > 550)
      this.fail("O emoji caiu das plataformas.");
  }
  draw(v) {
    this.platforms.forEach((p) => {
      const y = p.y + this.camera;
      if (y > 70 && y < 550) {
        v.rect(
          p.drawX ?? p.x,
          y,
          p.w,
          12,
          p.i === this.score + 1 ? "#b8edcf" : "#8e7a9e",
          5,
        );
        v.text(
          p.i === 8 ? "SAÍDA" : String(p.i),
          (p.drawX ?? p.x) + p.w / 2,
          y + 31,
          13,
          p.i === this.score + 1 ? "#b8edcf" : "#a696b9",
        );
      }
    });
    v.player({ x: this.player.x, y: this.player.y + this.camera }, 65);
    v.text(`${this.score} / ${this.goal}`, 840, 110, 25);
  }
}

export class Jump extends Challenge {
  constructor(o) {
    super(o);
    this.goal = this.duration < 12 ? 2 : 4;
    this.metric = "saltos";
    this.charge = 0;
    this.flying = false;
    this.nextPlatform();
    this.hint =
      "Segure para carregar, solte para saltar. A marca mostra o alcance.";
  }
  nextPlatform() {
    this.player = { x: 160, y: 396 };
    this.target = { x: this.rand(390, 665), w: 125 - this.score * 12 };
    this.charge = 0;
    this.flying = false;
    this.vy = 0;
    this.vx = 0;
  }
  press() {
    if (this.flying) return;
    super.press();
    this.charge = 0;
  }
  release() {
    if (!this.input.down || this.flying) return;
    super.release();
    this.flying = true;
    this.vy = -480;
    this.vx = lerp(130, 700, this.charge);
  }
  update(dt) {
    if (!this.flying) {
      if (this.input.down)
        this.charge = clamp(this.charge + dt * 0.6 * this.intensity, 0, 1);
      return;
    }
    const old = this.player.y;
    this.vy += 1050 * dt;
    this.player.x += this.vx * dt;
    this.player.y += this.vy * dt;
    if (
      this.vy > 0 &&
      old + 24 <= 420 &&
      this.player.y + 24 >= 420 &&
      this.player.x > this.target.x + 3 &&
      this.player.x < this.target.x + this.target.w - 3
    ) {
      this.point();
      if (!this.finished) this.nextPlatform();
    }
    if (this.player.y > 570 || this.player.x > 1010)
      this.fail("O salto não encontrou a plataforma.");
  }
  draw(v) {
    v.rect(90, 420, 140, 120, "#8e7a9e");
    v.rect(this.target.x, 420, this.target.w, 120, "#b8edcf60");
    v.rect(this.target.x, 416, this.target.w, 6, "#b8edcf");
    if (!this.flying) {
      const reach = 160 + lerp(130, 700, this.charge) * (960 / 1050);
      v.circle(reach, 411, 7, "#ffad8c");
      v.bar(85, 145, 230, this.charge, "#ffad8c", "FORÇA DO SALTO");
      v.text("↓ alcance previsto", reach, 385, 14, "#ffad8c");
    }
    v.player(this.player, 70);
    v.text(`${this.score} / ${this.goal} saltos`, 760, 150, 23);
  }
}

export class Munch extends Challenge {
  constructor(o) {
    super(o);
    this.goal = Math.max(12, Math.floor(this.duration * 1.2));
    this.metric = "pontos";
    this.player = { x: 480, y: 300 };
    this.enemy = { x: 800, y: 300, dir: -1 };
    this.dir = 1;
    this.power = 0;
    this.powerAt = 2;
    this.orb = { x: 240, y: 300 };
    this.dots = [];
    this.makeDots();
    this.hint = "Clique para inverter. Pegue o brilho verde antes do encontro.";
  }
  makeDots() {
    this.dots = [];
    for (let x = 130; x <= 850; x += 40) this.dots.push({ x, y: 300 });
  }
  press() {
    super.press();
    this.dir *= -1;
    this.notice("Sentido invertido");
  }
  update(dt) {
    const speed = lerp(175, 265, this.progress) * this.intensity;
    this.player.x += this.dir * speed * dt;
    if (this.player.x > 870) this.player.x = 110;
    if (this.player.x < 110) this.player.x = 870;
    this.enemy.x +=
      this.enemy.dir * lerp(135, 295, this.progress) * this.intensity * dt;
    if (this.enemy.x > 870) this.enemy.x = 110;
    if (this.enemy.x < 110) this.enemy.x = 870;
    this.power = Math.max(0, this.power - dt);
    if (this.elapsed > this.powerAt && !this.orb)
      this.orb = { x: clamp(this.player.x + this.dir * 170, 140, 840), y: 300 };
    if (this.orb && distance(this.player, this.orb) < 29) {
      this.power = 2.5;
      this.orb = null;
      this.powerAt = this.elapsed + 4.5;
      this.notice("Você ficou invencível!");
    }
    for (const d of this.dots)
      if (!d.taken && distance(d, this.player) < 24) {
        d.taken = true;
        this.point();
      }
    if (this.dots.every((d) => d.taken) && !this.finished) this.makeDots();
    let dx = this.player.x - this.enemy.x;
    if (dx > 380) dx -= 760;
    if (dx < -380) dx += 760;
    if (Math.abs(dx) < 35) {
      if (this.power > 0) {
        this.enemy.x = 110 + ((this.player.x - 110 + 380) % 760);
        this.enemy.dir *= -1;
        this.notice("Perseguidor afastado!");
      } else this.fail("O perseguidor alcançou você.");
    }
    this.kibes = [this.enemy];
  }
  draw(v) {
    v.rect(100, 253, 780, 94, "#b19ac80c", 35);
    v.line({ x: 110, y: 300 }, { x: 870, y: 300 }, "#8e7a9e", 2);
    this.dots
      .filter((d) => !d.taken)
      .forEach((d) => v.circle(d.x, d.y, 5, "#ffad8c"));
    if (this.orb) {
      v.circle(this.orb.x, 300, 20, "#b8edcf44", "#b8edcf");
      v.text("✦", this.orb.x, 309, 25, "#b8edcf");
    }
    if (this.power > 0) v.circle(this.player.x, 300, 43, null, "#b8edcf");
    v.enemy(this.enemy, this.player, 62);
    v.text(this.enemy.dir > 0 ? "→" : "←", this.enemy.x, 368, 22, "#ffad8c");
    v.player(this.player, 68);
    v.text(`${this.score} / ${this.goal} pontos`, 480, 170, 29);
    v.text("↔ as pontas do corredor se conectam", 480, 409, 16);
  }
}
