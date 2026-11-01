import { clamp } from "./games/kit.js";

// Read-only presentation state. Gameplay geometry stays entirely in the canvas.
export function gameHud(id, sim) {
  let summary = "Sobreviva",
    resource = null;
  const meter = (label, value, max, display, low = false) => ({
    label,
    value: clamp(value, 0, max),
    max,
    display,
    low,
  });
  if (id === "arena") summary = `× 1 / projéteis × ${sim.kibes.length}`;
  if (sim.goal) summary = `${sim.score}/${sim.goal} ${sim.metric}`;
  else if (id === "rhythm")
    summary = `${sim.score} ${sim.score === 1 ? "expulso" : "expulsos"}`;
  else if (id === "paddle") summary = `${sim.score} rebatidas`;
  else if (id === "climb")
    summary = `${sim.score} plataformas · subida sem fim`;
  else if (id === "gravity") summary = `${sim.score} colunas`;
  else if (id === "shelter") summary = `${sim.score} bloqueios`;
  else if (id === "slash") summary = `${sim.score} cortes`;
  else if (id === "juggle")
    summary = `${sim.balls.length} ameaças · ${sim.score} afastamentos`;
  else if (id === "thunder" && sim.wave)
    summary = `${sim.wave.paths.length} trajetórias · ${sim.wave.fired ? "em voo" : "prepare-se"}`;
  if (sim.maxLives > 1) summary += ` · ${sim.lives}/${sim.maxLives} chances`;
  if (id === "web")
    summary = `${Math.round(sim.courseProgress * 100)}% do percurso · ${sim.attachments} teias`;
  if (id === "shelter")
    resource = meter(
      "Tinta livre",
      sim.ink,
      sim.maxInk,
      `${Math.round(sim.ink)} / ${sim.maxInk}`,
      sim.ink < 60,
    );
  if (id === "rhythm") {
    const left = Math.max(0, sim.cooldownUntil - sim.elapsed);
    resource = meter(
      "Taco",
      sim.cooldown - left,
      sim.cooldown,
      left > 0 ? `Volta em ${left.toFixed(1)} s` : "Pronto",
      left > 0,
    );
  }
  if (id === "stretch") {
    const force = sim.phase === "aim" ? Math.hypot(sim.pull.x, sim.pull.y) : 0;
    resource = meter(
      "Força do disparo",
      force,
      140,
      sim.phase === "aim"
        ? `${Math.round(clamp(force / 140, 0, 1) * 100)}%`
        : "Em voo",
    );
  }
  return {
    summary,
    resource,
    feedback:
      sim.feedback && sim.elapsed < sim.feedback.until ? sim.feedback : null,
  };
}
