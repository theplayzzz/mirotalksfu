import {
  Challenge,
  W,
  H,
  clamp,
  lerp,
  distance,
  circleRect,
  segmentDistance,
} from "./kit.js";

export class Rain extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: 480, y: 457 };
    this.rows = [];
    this.next = 1;
    this.gap = 480;
    this.hint = "Só esquerda e direita. Procure a próxima abertura.";
  }
  update(dt) {
    this.player.x = this.axis(680);
    if (this.elapsed >= this.next) {
      const gap = clamp(this.gap + this.rand(-230, 230), 110, 850),
        width = lerp(215, 112, this.progress);
      this.rows.push({ y: -20, gap, width });
      this.gap = gap;
      this.next = this.elapsed + lerp(2, 1.05, this.progress) / this.intensity;
    }
    this.kibes = [];
    for (const row of this.rows) {
      row.y += lerp(170, 500, this.progress) * this.intensity * dt;
      for (let x = 28; x < W; x += 53)
        if (Math.abs(x - row.gap) > row.width / 2) {
          const b = { x, y: row.y };
          this.kibes.push(b);
          if (this.hits(b, this.player, 19))
            this.fail("A chuva alcançou o emoji.");
        }
    }
    this.rows = this.rows.filter((r) => r.y < H + 60);
  }
  draw(v) {
    v.rect(12, 488, 936, 3, "#857396");
    for (const r of this.rows) {
      v.rect(r.gap - r.width / 2, 74, r.width, 408, "#b8edcf09", 0);
      v.text("↓", r.gap, 105, 23, "#b8edcf");
    }
    this.kibes.forEach((b) => v.enemy(b, this.player));
    v.player(this.player, 68);
  }
}

export class Orbit extends Challenge {
  constructor(o) {
    super(o);
    this.center = { x: 480, y: 294 };
    this.radius = 165;
    this.angle = -Math.PI / 2;
    this.dir = 1;
    this.attacks = [];
    this.next = 1.1;
    this.hint = "Clique para inverter o sentido na órbita.";
    this.place();
  }
  place() {
    this.player = {
      x: 480 + Math.cos(this.angle) * this.radius,
      y: 294 + Math.sin(this.angle) * this.radius,
    };
  }
  press() {
    super.press();
    this.dir *= -1;
    this.notice("Sentido invertido");
  }
  update(dt) {
    this.angle += this.dir * lerp(1.65, 2.2, this.progress) * dt;
    this.place();
    if (this.elapsed >= this.next) {
      const a = this.angle + this.rand(-0.7, 0.7);
      const x = 480 + Math.cos(a) * 400,
        y = 294 + Math.sin(a) * 400;
      const target = { x: 480 + Math.cos(a) * 165, y: 294 + Math.sin(a) * 165 };
      const angle = Math.atan2(target.y - y, target.x - x);
      this.attacks.push({
        x,
        y,
        vx: Math.cos(angle),
        vy: Math.sin(angle),
        wait: lerp(0.7, 0.32, this.progress),
      });
      this.next =
        this.elapsed + lerp(1.8, 0.52, this.progress) / this.intensity;
    }
    for (const b of this.attacks) {
      b.wait -= dt;
      if (b.wait > 0) continue;
      b.x += b.vx * lerp(230, 560, this.progress) * dt * this.intensity;
      b.y += b.vy * lerp(230, 560, this.progress) * dt * this.intensity;
      if (this.hits(b, this.player, 20))
        this.fail("Você cruzou o ataque na órbita.");
    }
    this.attacks = this.attacks.filter(
      (b) => b.x > -100 && b.x < W + 100 && b.y > -150 && b.y < H + 150,
    );
    this.kibes = this.attacks;
  }
  draw(v) {
    v.circle(480, 294, 165, null, "#81708f");
    v.circle(480, 294, 85, "#c5a6e010");
    v.text(this.dir > 0 ? "↻" : "↺", 480, 303, 65, "#c5a6e0");
    this.attacks.forEach((b) => {
      if (b.wait > 0) v.line(b, { x: 480, y: 294 }, "#ffad8c60", 2);
      else v.enemy(b, this.player);
    });
    v.player(this.player, 64);
  }
}

export class Gravity extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: 225, y: 429 };
    this.vy = 0;
    this.gravity = 1;
    this.gates = [];
    this.next = 1;
    this.hint = "Clique troca a gravidade. Escolha teto ou chão.";
  }
  press() {
    super.press();
    this.gravity *= -1;
    this.notice(this.gravity > 0 ? "Chão ↓" : "Teto ↑");
  }
  update(dt) {
    this.vy += this.gravity * 2100 * dt;
    this.player.y = clamp(this.player.y + this.vy * dt, 139, 429);
    if (this.player.y === 139 || this.player.y === 429) this.vy = 0;
    if (this.elapsed >= this.next) {
      this.gates.push({ x: 1010, top: this.random() > 0.5, w: 60 });
      this.next = this.elapsed + lerp(2, 1.03, this.progress) / this.intensity;
    }
    for (const g of this.gates) {
      g.x -= lerp(190, 460, this.progress) * this.intensity * dt;
      const box = { x: g.x, y: g.top ? 115 : 320, w: g.w, h: 135 };
      if (circleRect(this.player, 21, box))
        this.fail("O portão fechou seu caminho.");
    }
    this.gates = this.gates.filter((g) => g.x > -100);
    this.kibes = this.gates;
  }
  draw(v) {
    v.rect(20, 111, 920, 5, "#9f8bad");
    v.rect(20, 455, 920, 5, "#9f8bad");
    this.gates.forEach((g) => {
      v.rect(g.x, g.top ? 115 : 320, g.w, 135, "#b879a8", 8);
      v.enemy({ x: g.x + 30, y: g.top ? 182 : 385 }, this.player, 57);
    });
    v.text(
      this.gravity > 0 ? "↓" : "↑",
      225,
      this.player.y + (this.gravity > 0 ? -60 : 70),
      28,
      "#b8edcf",
    );
    v.player(this.player, 64);
  }
}

export class Shelter extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: 480, y: 437 };
    this.lines = [];
    this.drops = [];
    this.ink = 700;
    this.next = 0.9;
    this.lastPoint = null;
    this.hint = "Desenhe acima do emoji. A tinta volta aos poucos.";
  }
  move(x, y) {
    super.move(x, y);
    if (!this.input.down || y > 345 || y < 110) {
      this.lastPoint = null;
      return;
    }
    const p = { x: this.input.x, y: this.input.y };
    if (this.lastPoint) {
      const n = distance(p, this.lastPoint);
      if (n > 6 && this.ink >= n) {
        this.lines.push({ a: this.lastPoint, b: p, hp: 3 });
        this.ink -= n;
        if (this.lines.length > 110) this.lines.shift();
        this.lastPoint = p;
      }
    } else this.lastPoint = p;
  }
  press() {
    super.press();
    this.lastPoint = null;
    this.move(this.input.x, this.input.y);
  }
  release() {
    super.release();
    this.lastPoint = null;
  }
  update(dt) {
    this.ink = clamp(this.ink + 28 * dt, 0, 700);
    if (this.elapsed >= this.next) {
      const x = this.rand(245, 715),
        a = Math.atan2(437 - 60, 480 - x);
      this.drops.push({
        x,
        y: 66,
        vx: Math.cos(a) * this.rand(40, 100),
        vy: lerp(90, 220, this.progress),
      });
      this.next =
        this.elapsed + lerp(1.05, 0.29, this.progress) / this.intensity;
    }
    for (const b of this.drops) {
      b.vy += lerp(65, 130, this.progress) * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      for (const l of this.lines)
        if (l.hp > 0 && segmentDistance(b, l.a, l.b) < 22 && b.vy > 0) {
          l.hp--;
          b.vy = -220;
          b.vx += (b.x - 480) * 0.6;
          this.score++;
          this.notice("Rebatido!");
          break;
        }
      if (this.hits(b, this.player, 23))
        this.fail("A chuva atravessou seu abrigo.");
    }
    this.lines = this.lines.filter((l) => l.hp > 0);
    this.drops = this.drops.filter((b) => b.y > -80 && b.y < 600);
    this.kibes = this.drops;
  }
  draw(v) {
    v.bar(40, 88, 200, this.ink / 700, "#b8edcf", "TINTA");
    v.line({ x: 30, y: 345 }, { x: 930, y: 345 }, "#ac96bf35", 1);
    v.text("desenhe acima desta linha", 760, 335, 13, "#a696b9");
    this.lines.forEach((l) =>
      v.line(l.a, l.b, l.hp === 1 ? "#8b7a9d" : "#b8edcf", 6),
    );
    this.drops.forEach((b) => v.enemy(b, this.player));
    v.player(this.player, 80);
    v.rect(406, 472, 148, 8, "#8b7a9d");
  }
}

export class Jet extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: 220, y: 290 };
    this.vy = 0;
    this.gates = [];
    this.next = 1;
    this.lastGap = 285;
    this.hint = "Segure para subir. Solte para descer.";
  }
  update(dt) {
    const thrust = this.input.down;
    this.vy = clamp(this.vy + (thrust ? -950 : 730) * dt, -290, 320);
    this.player.y += this.vy * dt;
    if (this.player.y < 99 || this.player.y > 472)
      this.fail("Você saiu do corredor de voo.");
    if (this.elapsed >= this.next) {
      this.lastGap = clamp(this.lastGap + this.rand(-85, 85), 190, 380);
      this.gates.push({
        x: 1010,
        gap: this.lastGap,
        size: lerp(192, 132, this.progress),
      });
      this.next = this.elapsed + lerp(2, 1.13, this.progress) / this.intensity;
    }
    for (const g of this.gates) {
      g.x -= lerp(190, 365, this.progress) * this.intensity * dt;
      if (
        circleRect(this.player, 19, {
          x: g.x,
          y: 75,
          w: 54,
          h: g.gap - g.size / 2 - 75,
        }) ||
        circleRect(this.player, 19, {
          x: g.x,
          y: g.gap + g.size / 2,
          w: 54,
          h: 495 - g.gap - g.size / 2,
        })
      )
        this.fail("O emoji bateu no portão.");
    }
    this.gates = this.gates.filter((g) => g.x > -100);
    this.kibes = this.gates;
  }
  draw(v) {
    v.rect(20, 75, 920, 4, "#a696b9");
    v.rect(20, 495, 920, 4, "#a696b9");
    this.gates.forEach((g) => {
      v.rect(g.x, 79, 54, g.gap - g.size / 2 - 79, "#b879a8");
      v.rect(g.x, g.gap + g.size / 2, 54, 495 - g.gap - g.size / 2, "#b879a8");
      v.enemy({ x: g.x + 27, y: g.gap - g.size / 2 - 35 }, this.player, 50);
    });
    if (this.input.down) {
      v.circle(this.player.x, this.player.y + 36, 10, "#ffad8c");
      v.text("↑", this.player.x, this.player.y + 72, 23, "#ffad8c");
    }
    v.player(this.player, 64, this.vy * 0.0007);
  }
}

export class Thunder extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: 480, y: 300 };
    this.strikes = [];
    this.next = 0.9;
    this.hint = "Faixa laranja avisa. Faixa rosa acerta: saia dela.";
  }
  update(dt) {
    const k = this.input.keys,
      dx =
        Number(k.has("arrowright") || k.has("d")) -
        Number(k.has("arrowleft") || k.has("a")),
      dy =
        Number(k.has("arrowdown") || k.has("s")) -
        Number(k.has("arrowup") || k.has("w"));
    if (dx || dy) {
      this.input.x = clamp(this.input.x + dx * 600 * dt, 40, 920);
      this.input.y = clamp(this.input.y + dy * 600 * dt, 100, 490);
    }
    this.player = { x: this.input.x, y: clamp(this.input.y, 100, 490) };
    if (this.elapsed >= this.next) {
      const vertical = this.random() > 0.38;
      const coord = vertical ? this.player.x : this.player.y;
      this.strikes.push({
        vertical,
        coord,
        width: lerp(100, 145, this.progress),
        at:
          this.elapsed +
          lerp(0.98, 0.43, this.progress) / Math.sqrt(this.intensity),
        done: false,
      });
      this.next =
        this.elapsed + lerp(1.45, 0.47, this.progress) / this.intensity;
    }
    for (const s of this.strikes)
      if (this.elapsed >= s.at && this.elapsed < s.at + 0.25) {
        const delta = Math.abs(
          (s.vertical ? this.player.x : this.player.y) - s.coord,
        );
        if (delta < s.width / 2 + 19)
          this.fail("O raio pegou você na faixa marcada.");
      }
    this.strikes = this.strikes.filter((s) => this.elapsed < s.at + 0.3);
    this.kibes = this.strikes;
  }
  draw(v) {
    this.strikes.forEach((s) => {
      const active = this.elapsed >= s.at;
      v.rect(
        s.vertical ? s.coord - s.width / 2 : 20,
        s.vertical ? 80 : s.coord - s.width / 2,
        s.vertical ? s.width : 920,
        s.vertical ? 420 : s.width,
        active ? "#ed82b69c" : "#ffad8c20",
        0,
      );
      v.text(
        active ? "⚡" : "!",
        s.vertical ? s.coord : 70,
        s.vertical ? 130 : s.coord + 10,
        29,
        active ? "#fff" : "#ffad8c",
      );
      if (!active)
        v.bar(
          s.vertical ? s.coord - 30 : 110,
          s.vertical ? 151 : s.coord - 4,
          60,
          1 - (s.at - this.elapsed),
          "#ffad8c",
        );
    });
    v.player(this.player, 65);
  }
}

export class Energy extends Challenge {
  constructor(o) {
    super(o);
    this.player = { x: 480, y: 300 };
    this.battery = 65;
    this.orbs = [
      { x: 430, y: 260 },
      { x: 550, y: 340 },
    ];
    this.nextOrb = 1.5;
    this.nextEnemy = 2;
    this.drops = [];
    this.lives = 3;
    this.hint = "Segure perto das cargas verdes. Recarregar deixa você lento.";
  }
  update(dt) {
    this.axis();
    const k = this.input.keys;
    if (k.has("arrowup") || k.has("w")) this.input.y -= 600 * dt;
    if (k.has("arrowdown") || k.has("s")) this.input.y += 600 * dt;
    this.input.y = clamp(this.input.y, 110, 480);
    const dx = this.input.x - this.player.x,
      dy = this.input.y - this.player.y,
      d = Math.hypot(dx, dy),
      s = (this.input.down ? 160 : 650) * dt;
    if (d > 0) {
      this.player.x += dx * Math.min(1, s / d);
      this.player.y += dy * Math.min(1, s / d);
    }
    this.battery -= lerp(5, 10, this.progress) * this.intensity * dt;
    if (this.battery <= 0) this.fail("A bateria acabou.", "battery");
    for (const o of this.orbs)
      if (this.input.down && distance(o, this.player) < 53) {
        this.battery = clamp(this.battery + 24, 0, 100);
        o.taken = true;
        this.score++;
        this.notice("+24 energia");
      }
    this.orbs = this.orbs.filter((o) => !o.taken);
    if (this.elapsed >= this.nextOrb) {
      if (this.orbs.length < 6)
        this.orbs.push({ x: this.rand(100, 860), y: this.rand(150, 450) });
      this.nextOrb = this.elapsed + 1.35;
    }
    if (this.elapsed >= this.nextEnemy) {
      const side = this.random() > 0.5,
        x = side ? -40 : 1000,
        y = this.rand(150, 450),
        a = Math.atan2(this.player.y - y, this.player.x - x);
      this.drops.push({ x, y, vx: Math.cos(a), vy: Math.sin(a) });
      this.nextEnemy =
        this.elapsed + lerp(2, 1.0, this.progress) / this.intensity;
    }
    for (const b of this.drops) {
      b.x += b.vx * lerp(160, 390, this.progress) * dt;
      b.y += b.vy * lerp(160, 390, this.progress) * dt;
      if (this.hits(b, this.player, 20)) {
        this.hurt("Impacto! −1 chance");
        b.gone = true;
      }
    }
    this.drops = this.drops.filter(
      (b) => !b.gone && b.x > -100 && b.x < 1060 && b.y > 0 && b.y < 620,
    );
    this.kibes = this.drops;
  }
  draw(v) {
    v.bar(
      40,
      88,
      220,
      this.battery / 100,
      this.battery < 25 ? "#f492ab" : "#b8edcf",
      `BATERIA ${Math.ceil(this.battery)}%`,
    );
    this.orbs.forEach((o) => {
      v.circle(o.x, o.y, 20, "#b8edcf22", "#b8edcf");
      v.text("+", o.x, o.y + 7, 26, "#b8edcf");
    });
    this.drops.forEach((b) => v.enemy(b, this.player));
    if (this.input.down)
      v.circle(this.player.x, this.player.y, 53, null, "#b8edcf");
    v.player(this.player, 68);
  }
}
