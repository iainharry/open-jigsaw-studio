/**
 * Sampling each piece's colour from the source image.
 *
 * Lives here rather than in the engine because it needs a canvas. The clustering that
 * consumes the result is pure maths and lives in `src/engine/colour.ts`.
 *
 * Two decisions worth keeping:
 *
 * Sampling happens inside the piece's *nominal cell*, not its bounding box. The bounding
 * box includes tab overhang, which sticks into the neighbouring piece's territory — a sky
 * piece with a tab reaching down into a tree would be pulled towards green by pixels that
 * belong to its neighbour's part of the picture.
 *
 * The image is analysed at reduced resolution. Colour grouping does not need detail, and
 * reading a 25-megapixel ImageData buffer to average a few hundred blocks would cost
 * ~100 MB and a visible pause for no gain.
 */

import { rgbToOklab } from '../engine/colour.js';
import type { PuzzleGeometry } from '../engine/types.js';

/** Long edge used for colour analysis. Plenty for averaging; cheap to read back. */
const ANALYSIS_EDGE = 900;
/** Samples per axis inside each cell. 5x5 is enough to survive noise and JPEG blocks. */
const GRID = 5;
/** Fraction of the cell sampled, centred — keeps well clear of tabs and neighbours. */
const INSET = 0.62;

/**
 * Mean OKLab colour of every piece, as a flat [L,a,b, L,a,b, ...] array indexed by piece id.
 *
 * Averaging in OKLab rather than in sRGB: the mean of two sRGB values is not the colour
 * halfway between them, so a piece split between sky and cloud would average to something
 * neither the eye nor the clustering recognises.
 */
export function samplePieceColours(
  image: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
  geometry: PuzzleGeometry,
): Float32Array {
  const out = new Float32Array(geometry.pieces.length * 3);

  const scale = Math.min(1, ANALYSIS_EDGE / Math.max(imageWidth, imageHeight));
  const w = Math.max(1, Math.round(imageWidth * scale));
  const h = Math.max(1, Math.round(imageHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return out;
  ctx.drawImage(image, 0, 0, w, h);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    // A tainted canvas would throw. Nothing here loads cross-origin images, but failing
    // soft is better than breaking the sort.
    return out;
  }

  const cellW = geometry.cellWidth * scale;
  const cellH = geometry.cellHeight * scale;

  for (const piece of geometry.pieces) {
    // Nominal cell in analysis pixels, independent of tab overhang.
    const x0 = piece.col * cellW;
    const y0 = piece.row * cellH;
    const insetX = (cellW * (1 - INSET)) / 2;
    const insetY = (cellH * (1 - INSET)) / 2;

    let l = 0;
    let a = 0;
    let b = 0;
    let n = 0;

    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const px = Math.round(x0 + insetX + ((cellW - insetX * 2) * (gx + 0.5)) / GRID);
        const py = Math.round(y0 + insetY + ((cellH - insetY * 2) * (gy + 0.5)) / GRID);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const i = (py * w + px) * 4;
        const lab = rgbToOklab(data[i]!, data[i + 1]!, data[i + 2]!);
        l += lab[0];
        a += lab[1];
        b += lab[2];
        n++;
      }
    }

    if (n > 0) {
      out[piece.id * 3] = l / n;
      out[piece.id * 3 + 1] = a / n;
      out[piece.id * 3 + 2] = b / n;
    }
  }

  return out;
}
