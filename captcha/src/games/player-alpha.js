import packed from "./player-mask.js";
const alpha = new Uint8Array(packed.width * packed.height);
for (let y = 0; y < packed.height; y++)
  for (let i = 0; i < packed.rows[y].length; i += 2)
    alpha.fill(
      1,
      y * packed.width + packed.rows[y][i],
      y * packed.width + packed.rows[y][i + 1],
    );
export const playerAlpha = { ...packed, alpha };
