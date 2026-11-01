// Use the PNG's visible alpha pixels, in the exact dimensions and rotation used by the renderer.
export const PROJECTILE_HEIGHT = 54;
export const ALPHA_THRESHOLD = 32;

export function createAlphaMask(imageData, worldWidth, worldHeight) {
  const { width, height, data } = imageData;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  }
  return { width, height, alpha, worldWidth, worldHeight };
}

export function maskFromSprite(
  image,
  worldHeight = PROJECTILE_HEIGHT,
  samples = 2,
) {
  const worldWidth = (worldHeight * image.naturalWidth) / image.naturalHeight;
  const canvas = document.createElement("canvas");
  // Alpha samples are cached once; no pixel readback is needed during gameplay.
  canvas.width = Math.ceil(worldWidth * samples);
  canvas.height = Math.ceil(worldHeight * samples);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return createAlphaMask(
    context.getImageData(0, 0, canvas.width, canvas.height),
    worldWidth,
    worldHeight,
  );
}

export function alphaMaskHitsCircle(mask, source, rotation, circle, radius) {
  if (!mask) return false; // Unloaded/invisible artwork never produces an invisible hit.
  const dx = circle.x - source.x,
    dy = circle.y - source.y;
  const cos = Math.cos(rotation),
    sin = Math.sin(rotation);
  const x = cos * dx + sin * dy;
  const y = -sin * dx + cos * dy;
  const { worldWidth, worldHeight, width, height, alpha } = mask;
  const halfW = worldWidth / 2,
    halfH = worldHeight / 2;
  if (
    x + radius < -halfW ||
    x - radius > halfW ||
    y + radius < -halfH ||
    y - radius > halfH
  )
    return false;
  const pixelW = worldWidth / width,
    pixelH = worldHeight / height;
  const left = Math.max(0, Math.floor((x - radius + halfW) / pixelW));
  const right = Math.min(width - 1, Math.floor((x + radius + halfW) / pixelW));
  const top = Math.max(0, Math.floor((y - radius + halfH) / pixelH));
  const bottom = Math.min(
    height - 1,
    Math.floor((y + radius + halfH) / pixelH),
  );
  for (let row = top; row <= bottom; row++) {
    const py = (row + 0.5) * pixelH - halfH;
    for (let col = left; col <= right; col++) {
      if (!alpha[row * width + col]) continue;
      const px = (col + 0.5) * pixelW - halfW;
      if ((px - x) ** 2 + (py - y) ** 2 <= radius * radius) return true;
    }
  }
  return false;
}

// Match the renderer's size and optional world-Y reflection before rotation.
export function orientedSpriteHitsCircle(
  mask,
  source,
  rotation,
  circle,
  radius,
) {
  const scale = (source.size || PROJECTILE_HEIGHT) / PROJECTILE_HEIGHT;
  return alphaMaskHitsCircle(
    mask,
    source,
    rotation,
    {
      x: source.x + (circle.x - source.x) / scale,
      y: source.y + ((circle.y - source.y) / scale) * (source.flipY ? -1 : 1),
    },
    radius / scale,
  );
}
