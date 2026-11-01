import { clamp, W, H } from "./kit.js";
import { spacedColumn } from "./column-layout.js";

export const WEB_PATTERNS = [
  { kind: "top", label: "Passe por baixo", top: 248, bottom: null, safeY: 354 },
  {
    kind: "bottom",
    label: "Passe por cima",
    top: null,
    bottom: 322,
    safeY: 242,
  },
  {
    kind: "middle",
    label: "Passe pelo meio",
    top: 204,
    bottom: 406,
    safeY: 305,
  },
  {
    kind: "high",
    label: "Abertura mais alta",
    top: 128,
    bottom: 328,
    safeY: 228,
  },
  {
    kind: "floating",
    label: "Escolha acima ou abaixo",
    floating: [258, 382],
    safeY: 212,
  },
  {
    kind: "low",
    label: "Abertura mais baixa",
    top: 272,
    bottom: 472,
    safeY: 372,
  },
];

export function buildWebCourse(duration = 25, groundY = 514, intensity = 0.9) {
  const count = clamp(Math.floor(duration / 3), 2, 10);
  const gates = Array.from({ length: count }, (_, i) => {
    const basePattern = WEB_PATTERNS[i % WEB_PATTERNS.length],
      inset = (intensity - 0.9) * 35,
      pattern = {
        ...basePattern,
        top: basePattern.top ? basePattern.top + inset : null,
        bottom: basePattern.bottom ? basePattern.bottom - inset : null,
        floating: basePattern.floating ? [basePattern.floating[0] - inset, basePattern.floating[1] + inset] : null,
      },
      x = 500 + i * 400,
      spans = pattern.floating
        ? [
            {
              y: pattern.floating[0],
              h: pattern.floating[1] - pattern.floating[0],
              anchor: "start",
            },
          ]
        : [
            ...(pattern.top
              ? [{ y: 12, h: pattern.top - 12, anchor: "end" }]
              : []),
            ...(pattern.bottom
              ? [
                  {
                    y: pattern.bottom,
                    h: groundY - pattern.bottom,
                    anchor: "start",
                  },
                ]
              : []),
          ];
    const parts = spans
      .flatMap((s) =>
        spacedColumn(x - 32, s.y, s.h, 64, s.anchor, {
          step: 44,
          maxOuterGap: 32,
        }),
      )
      .map((p, index) => ({ ...p, id: `gate-${i}-${index}`, gateId: i }));
    return {
      id: i,
      x,
      kind: pattern.kind,
      label: pattern.label,
      safeY: pattern.safeY,
      spans,
      parts,
    };
  });
  const finish = { x: gates.at(-1).x + 420, y: 440, w: 210, h: groundY - 440 };
  finish.lineX = finish.x + 75;
  return {
    gates,
    finish,
    ceiling: { id: 0, x: -W, y: 0, w: finish.x + W * 3, h: 12 },
    ground: { x: -W, y: groundY, w: finish.x + W * 3, h: H - groundY + 100 },
  };
}
