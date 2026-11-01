import escapeUrl from "./assets/player-escape-transparent.png";
import impactUrl from "./assets/player-impact-transparent.png";
import { maskFromSprite } from "./collision.js";

export const playerUrls = { escape: escapeUrl, impact: impactUrl };
const sprites = Object.fromEntries(
  Object.entries(playerUrls).map(([state, url]) => {
    const image = new Image();
    image.src = url;
    return [state, image];
  }),
);

export let playerCollisionMask;
export const playerSpritesReady = Promise.all(
  Object.values(sprites).map((image) => image.decode()),
).then(() => {
  playerCollisionMask = maskFromSprite(sprites.escape, 76, 3);
});
// The embedding parent may initialize after a fast network failure. Keep the
// original rejection for its loader while preventing an unhandled early promise.
playerSpritesReady.catch(() => {});

export function drawPlayer(
  context,
  x,
  y,
  { size = 76, angle = 0, impacted = false } = {},
) {
  const image = sprites[impacted ? "impact" : "escape"];
  if (!image.complete || !image.naturalWidth) return;
  const width = (size * image.naturalWidth) / image.naturalHeight;
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.drawImage(image, -width / 2, -size / 2, width, size);
  context.restore();
}
