import { Challenge, clamp, lerp, distance, shuffle } from "./kit.js";

export class Memory extends Challenge {
  constructor(o) {
    super(o);
    this.goal = this.duration < 12 ? 2 : 3;
    this.metric = "sequências";
    this.lives = 3;
    this.grid = { x: 327, y: 155, cols: 3, rows: 3, gap: 105, size: 92 };
    this.sequence = [];
    this.cursor = 0;
    this.round();
    this.hint = "Observe os pisos iluminados. Espere a sua vez.";
  }
  round() {
    this.sequence = Array.from({ length: 3 + this.score }, () =>
      Math.floor(this.random() * 9),
    );
    this.phase = "watch";
    this.phaseAt = this.elapsed + 0.4;
    this.index = 0;
  }
  press() {
    super.press();
    if (this.phase !== "answer") return;
    const i = this.cellAt();
    if (i < 0) return;
    if (i === this.sequence[this.index]) {
      this.flash = { i, until: this.elapsed + 0.24 };
      this.index++;
      this.notice("Isso!");
      if (this.index === this.sequence.length) {
        this.point();
        if (!this.finished) this.round();
      }
    } else {
      this.hurt("Piso errado. Tente a sequência de novo.");
      this.index = 0;
      this.phase = "watch";
      this.phaseAt = this.elapsed + 0.4;
    }
  }
  update() {
    if (
      this.phase === "watch" &&
      this.elapsed > this.phaseAt + this.sequence.length * 0.64
    ) {
      this.phase = "answer";
      this.notice("Sua vez!");
    }
    this.hint =
      this.phase === "watch"
        ? "OBSERVE · espere terminar"
        : `SUA VEZ · passo ${this.index + 1} de ${this.sequence.length}`;
  }
  draw(v) {
    const beat = Math.floor((this.elapsed - this.phaseAt) / 0.64),
      lit =
        this.phase === "watch" &&
        this.elapsed >= this.phaseAt &&
        (this.elapsed - this.phaseAt) % 0.64 < 0.46
          ? this.sequence[beat]
          : -1;
    for (let i = 0; i < 9; i++) {
      const b = this.cell(i),
        on =
          lit === i || (this.flash?.i === i && this.elapsed < this.flash.until);
      v.rect(b.x, b.y, b.w, b.h, on ? "#b8edcf" : "#57465f", 12);
      v.text(
        String(i + 1),
        b.x + b.w / 2,
        b.y + 57,
        25,
        on ? "#252031" : "#a696b9",
      );
      if (i === this.cursor) v.rect(b.x + 5, b.y + 5, b.w - 10, 3, "#b8edcf44");
    }
    v.text(
      this.phase === "watch" ? "OBSERVE" : "SUA VEZ",
      480,
      119,
      23,
      this.phase === "watch" ? "#ffad8c" : "#b8edcf",
    );
    v.text(`${this.score} / ${this.goal}`, 800, 300, 28);
    v.player({ x: 172, y: 320 }, 105);
  }
}

export class Doors extends Challenge {
  constructor(o) {
    super(o);
    this.goal = Math.max(3, Math.floor(this.duration * 0.38));
    this.metric = "ameaças";
    this.lives = 4;
    this.doors = [null, null, null];
    this.next = 0.5;
    this.hint = "Clique nos projéteis. Não clique nos rostos.";
  }
  press() {
    super.press();
    for (let i = 0; i < 3; i++) {
      const d = this.doors[i],
        x = 175 + i * 240;
      if (
        d &&
        this.input.x > x - 82 &&
        this.input.x < x + 82 &&
        this.input.y > 180 &&
        this.input.y < 422
      ) {
        if (d.friend) this.hurt("Era um emoji inocente!");
        else this.point();
        this.doors[i] = null;
        break;
      }
    }
  }
  update() {
    if (this.elapsed >= this.next) {
      const available = [0, 1, 2].filter((i) => !this.doors[i]);
      if (available.length) {
        const i = available[Math.floor(this.random() * available.length)];
        this.doors[i] = {
          friend: this.random() < 0.25,
          until:
            this.elapsed +
            lerp(1.5, 0.72, this.progress) / Math.sqrt(this.intensity),
        };
      }
      this.next =
        this.elapsed + lerp(0.95, 0.48, this.progress) / this.intensity;
    }
    this.doors.forEach((d, i) => {
      if (d && this.elapsed > d.until) {
        if (!d.friend) this.hurt("Uma ameaça escapou.");
        this.doors[i] = null;
      }
    });
    this.kibes = this.doors.filter(Boolean);
  }
  draw(v) {
    for (let i = 0; i < 3; i++) {
      const x = 175 + i * 240,
        d = this.doors[i];
      v.rect(x - 82, 180, 164, 242, "#655071", 18);
      v.rect(x - 69, 195, 138, 214, d ? "#302538" : "#44364f", 12);
      if (d) {
        if (d.friend) v.player({ x, y: 300 }, 116);
        else v.enemy({ x, y: 300 }, { x, y: 490 }, 105);
        v.bar(
          x - 61,
          399,
          122,
          clamp((d.until - this.elapsed) / 1.5, 0, 1),
          "#ffad8c",
        );
      }
      v.text(String(i + 1), x, 460, 18);
    }
    v.text(`${this.score} / ${this.goal} ameaças`, 480, 124, 23);
    v.text("PROJÉTIL: CLIQUE     ROSTO: POUPE", 480, 504, 14, "#b8edcf");
  }
}

const CELLS = 25,
  COLS = 5;
const neighbors = (i) => {
  const a = [];
  for (let y = -1; y <= 1; y++)
    for (let x = -1; x <= 1; x++) {
      const xx = (i % COLS) + x,
        yy = Math.floor(i / COLS) + y;
      if ((x || y) && xx >= 0 && xx < COLS && yy >= 0 && yy < COLS)
        a.push(yy * COLS + xx);
    }
  return a;
};
const numbers = (mines) =>
  Array.from(
    { length: CELLS },
    (_, i) => neighbors(i).filter((j) => mines.has(j)).length,
  );
function flood(i, mines, counts, open) {
  if (mines.has(i) || open.has(i)) return;
  open.add(i);
  if (counts[i] === 0)
    neighbors(i).forEach((j) => flood(j, mines, counts, open));
}
export function logicalSolve(mines, first) {
  const counts = numbers(mines),
    open = new Set(),
    flags = new Set();
  flood(first, mines, counts, open);
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of open) {
      const around = neighbors(i),
        unknown = around.filter((j) => !open.has(j) && !flags.has(j)),
        need = counts[i] - around.filter((j) => flags.has(j)).length;
      if (unknown.length && need === 0) {
        unknown.forEach((j) => flood(j, mines, counts, open));
        changed = true;
      } else if (unknown.length && need === unknown.length) {
        unknown.forEach((j) => flags.add(j));
        changed = true;
      }
    }
    const unknown = Array.from({ length: CELLS }, (_, i) => i).filter(
      (i) => !open.has(i) && !flags.has(i),
    );
    if (unknown.length && flags.size === mines.size) {
      unknown.forEach((j) => flood(j, mines, counts, open));
      changed = true;
    }
  }
  return open.size === CELLS - mines.size;
}
export class Mines extends Challenge {
  constructor(o) {
    super(o);
    this.grid = { x: 220, y: 135, cols: 5, rows: 5, gap: 70, size: 63 };
    this.cursor = 0;
    this.open = new Set();
    this.flags = new Set();
    this.mines = null;
    this.counts = [];
    this.flagMode = false;
    this.goal = 20;
    this.metric = "casas seguras";
    this.hint = "Primeiro clique é seguro. Números contam ameaças vizinhas.";
  }
  generate(first) {
    const eligible = Array.from({ length: CELLS }, (_, i) => i).filter(
      (i) => i !== first && !neighbors(first).includes(i),
    );
    for (let attempt = 0; attempt < 2000; attempt++) {
      const m = new Set(shuffle(eligible, this.random).slice(0, 5)),
        opened = new Set();
      flood(first, m, numbers(m), opened);
      if (opened.size < 16 && logicalSolve(m, first)) {
        this.mines = m;
        break;
      }
    }
    if (!this.mines) {
      /* Deterministic retry stream also handles a pathological injected RNG. */ let seed = 1;
      const retry = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      for (let attempt = 0; attempt < 2000 && !this.mines; attempt++) {
        const m = new Set(shuffle(eligible, retry).slice(0, 5)),
          opened = new Set();
        flood(first, m, numbers(m), opened);
        if (opened.size < 16 && logicalSolve(m, first)) this.mines = m;
      }
    }
    this.counts = numbers(this.mines);
    this.goal = CELLS - this.mines.size;
  }
  press() {
    super.press();
    if (
      this.input.x > 660 &&
      this.input.x < 905 &&
      this.input.y > 175 &&
      this.input.y < 230
    ) {
      this.flagMode = !this.flagMode;
      return;
    }
    const i = this.cellAt();
    if (i < 0) return;
    if (this.flagMode) {
      this.flag(i);
      return;
    }
    if (this.flags.has(i) || this.open.has(i)) return;
    if (!this.mines) this.generate(i);
    if (this.mines.has(i)) {
      this.fail("Você abriu uma casa com ameaça.");
      return;
    }
    flood(i, this.mines, this.counts, this.open);
    this.score = this.open.size;
    if (this.score === this.goal)
      this.win("Todas as casas seguras foram abertas!");
  }
  flag(i) {
    if (this.open.has(i)) return;
    if (this.flags.has(i)) this.flags.delete(i);
    else this.flags.add(i);
  }
  secondary() {
    const i = this.cellAt();
    if (i >= 0) this.flag(i);
  }
  draw(v) {
    for (let i = 0; i < CELLS; i++) {
      const b = this.cell(i),
        opened = this.open.has(i);
      v.rect(b.x, b.y, b.w, b.h, opened ? "#b5a4c1" : "#5b4968", 9);
      if (this.flags.has(i))
        v.text("⚑", b.x + b.w / 2, b.y + 43, 27, "#ffad8c");
      else if (opened && this.counts[i])
        v.text(
          String(this.counts[i]),
          b.x + b.w / 2,
          b.y + 43,
          26,
          ["", "#264954", "#755422", "#622948"][this.counts[i]] || "#442d54",
        );
      else if (this.finished && this.mines?.has(i))
        v.enemy({ x: b.x + 31.5, y: b.y + 31.5 }, { x: b.x + 31.5, y: 0 }, 53);
    }
    v.text(`${this.mines?.size ?? 5} ameaças`, 775, 144, 23);
    v.rect(660, 175, 245, 55, this.flagMode ? "#b8edcf" : "#57465f", 10);
    v.text(
      this.flagMode ? "⚑ MARCAR ATIVO" : "⚑ Modo de marcação",
      782,
      209,
      17,
      this.flagMode ? "#252031" : "#ddd0e8",
    );
    v.text("ou use o botão direito", 782, 258, 14);
    v.text(`${this.score} / ${this.goal} seguras`, 782, 309, 21);
    v.player({ x: 775, y: 410 }, 112);
    v.text("Os números incluem diagonais.", 400, 516, 14);
  }
}

export class Timber extends Challenge {
  constructor(o) {
    super(o);
    this.goal = Math.max(8, Math.floor(this.duration * 0.75));
    this.metric = "cortes";
    this.lives = 3;
    this.rows = Array.from({ length: 6 }, () => (this.random() > 0.5 ? -1 : 1));
    this.deadline = 2.6;
    this.hint = "Ameaça à esquerda? Clique à direita. Leia de baixo para cima.";
  }
  choose(side) {
    if (this.finished) return;
    if (side === this.rows[0]) {
      this.hurt("Você escolheu o lado da ameaça.");
    } else {
      this.point();
      this.notice("Corte seguro!");
    }
    this.rows.shift();
    this.rows.push(this.random() > 0.5 ? -1 : 1);
    this.deadline =
      this.elapsed + lerp(2.5, 0.75, this.progress) / Math.sqrt(this.intensity);
    this.side = side;
  }
  press() {
    super.press();
    this.choose(this.input.x < 480 ? -1 : 1);
  }
  key(key) {
    if (key === "arrowleft" || key === "a") this.choose(-1);
    if (key === "arrowright" || key === "d") this.choose(1);
  }
  update() {
    if (this.elapsed > this.deadline) {
      this.hurt("Demorou para escolher o lado.");
      this.rows.shift();
      this.rows.push(this.random() > 0.5 ? -1 : 1);
      this.deadline = this.elapsed + lerp(2.5, 0.75, this.progress);
    }
  }
  draw(v) {
    v.rect(40, 100, 360, 390, "#b8edcf07", 18);
    v.rect(560, 100, 360, 390, "#b8edcf07", 18);
    v.text("← ESQUERDA", 210, 469, 18, "#b8edcf");
    v.text("DIREITA →", 750, 469, 18, "#b8edcf");
    this.rows.forEach((side, i) => {
      const y = 410 - i * 54;
      v.rect(437, y - 23, 86, 46, i ? "#796187" : "#b8edcf", 5);
      v.enemy({ x: 480 + side * 95, y }, { x: 480, y }, 50);
      if (!i) v.text("CORTE ESTE", 480, y + 40, 12, "#b8edcf");
    });
    v.player({ x: this.side === -1 ? 260 : 700, y: 368 }, 83);
    v.bar(
      60,
      95,
      280,
      clamp((this.deadline - this.elapsed) / 2.5, 0, 1),
      "#ffad8c",
      "TEMPO PARA O CORTE",
    );
    v.text(`${this.score} / ${this.goal}`, 780, 126, 24);
  }
}
