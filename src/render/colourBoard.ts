/**
 * A picture made of the pieces themselves, for puzzles played without a photograph.
 *
 * The trick here is to produce an *image*, not a special rendering mode. Piece outlines
 * tile the picture exactly — that is the shared-edge guarantee — so filling every
 * outline with its own colour, in its solved position, gives a seamless mosaic that can
 * be handed to `setImage()` like any photograph. The bake cache, the renderer, the
 * reference panel, thumbnails and the ghost then all work unchanged. A dedicated
 * "no image" path through the renderer would have meant touching every one of them.
 *
 * Filling the outline rather than the piece's grid cells matters: a tab overhangs into
 * the neighbour's cell, so colouring by cell would give every tab the colour of the
 * piece it points at.
 */

import { oklabToRgb } from '../engine/colour.js';
import type { PuzzleGeometry } from '../engine/index.js';
import { outlineToPath2D } from './bakeCache.js';

/**
 * A colour per piece, spaced around the hue circle by the golden angle.
 *
 * The golden angle is used because consecutive indices land far apart on the circle, and
 * piece ids of neighbouring pieces are usually close together — so neighbours come out
 * strongly contrasting without needing to solve a graph-colouring problem. Lightness and
 * chroma cycle on different periods so two pieces a long way apart in id do not collide
 * either.
 */
export function pieceColour(index: number): string {
  const hue = (index * 137.508 * Math.PI) / 180;
  const lightness = 0.62 + 0.16 * Math.sin(index * 1.1);
  const chroma = 0.11 + 0.035 * Math.cos(index * 0.7);
  const [r, g, b] = oklabToRgb([
    lightness,
    chroma * Math.cos(hue),
    chroma * Math.sin(hue),
  ]);
  return `rgb(${r} ${g} ${b})`;
}

/**
 * Paint every piece in its own colour, in its solved position.
 *
 * The result is the same size as the picture would have been, so a puzzle can switch
 * between a photograph and colours without anything else changing.
 */
export function makeColourBoard(
  geometry: PuzzleGeometry,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // A backdrop, so any hairline between two filled paths reads as a seam rather than as
  // a transparent hole with the board showing through.
  ctx.fillStyle = '#0e1013';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const piece of geometry.pieces) {
    const path = outlineToPath2D(piece.outline, 1);
    ctx.save();
    ctx.translate(piece.bounds.x, piece.bounds.y);
    ctx.fillStyle = pieceColour(piece.id);
    ctx.fill(path);
    // Half a pixel of stroke in the same colour closes the antialiasing gap between
    // adjacent fills without changing the shape.
    ctx.lineWidth = 1;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.stroke(path);
    ctx.restore();
  }

  return canvas;
}
