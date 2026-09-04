/**
 * Painting an `ImageEdit` onto a canvas.
 *
 * Split from the maths in `src/engine/imageEdit.ts` because this half needs a canvas and
 * that half does not. The order of operations is the whole of the correctness here:
 *
 *   quarter turns -> straighten -> flip -> crop -> colour -> downscale
 *
 * The crop is stored in post-rotation coordinates, which is what lets the crop box stay
 * where the user put it while they nudge the straighten slider. So rotation has to happen
 * first, and the crop is then a plain rectangle in the rotated frame.
 */

import { editFilter, effectiveCrop, turnedSize, type ImageEdit } from '../engine/imageEdit.js';

export interface EditedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/**
 * Produce the prepared image.
 *
 * Rendered in two passes rather than one clever transform: rotate the whole photo into a
 * scratch canvas, then take the crop out of it. A single pass would need the crop
 * rectangle expressed in pre-rotation space, which is exactly the coordinate confusion
 * this design is trying to avoid.
 */
export async function renderEdited(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  edit: ImageEdit,
  maxEdge: number,
): Promise<EditedImage> {
  const turned = turnedSize(sourceWidth, sourceHeight, edit.turns);
  const crop = effectiveCrop(sourceWidth, sourceHeight, edit);

  // Pass one: the photo, turned, straightened and flipped, in its rotated frame.
  const rotated = document.createElement('canvas');
  rotated.width = Math.max(1, Math.round(turned.width));
  rotated.height = Math.max(1, Math.round(turned.height));
  const rctx = rotated.getContext('2d');
  if (!rctx) throw new Error('Canvas2D is not available');

  rctx.save();
  rctx.translate(rotated.width / 2, rotated.height / 2);
  if (edit.straighten !== 0) rctx.rotate((edit.straighten * Math.PI) / 180);
  rctx.rotate((edit.turns * Math.PI) / 2);
  if (edit.flipH) rctx.scale(-1, 1);
  rctx.imageSmoothingQuality = 'high';
  rctx.drawImage(source, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
  rctx.restore();

  // Pass two: crop, colour-correct and scale to the final size in one draw.
  const scale = Math.min(1, maxEdge / Math.max(crop.w, crop.h));
  const width = Math.max(1, Math.round(crop.w * scale));
  const height = Math.max(1, Math.round(crop.h * scale));

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('Canvas2D is not available');

  const filter = editFilter(edit);
  if (filter) octx.filter = filter;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(rotated, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
  octx.filter = 'none';

  return { bitmap: await createImageBitmap(out), width, height };
}

/** A small preview for the preparation view, at whatever size fits the panel. */
export function drawEditPreview(
  target: HTMLCanvasElement,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  edit: ImageEdit,
  boxWidth: number,
  boxHeight: number,
): { scale: number; offsetX: number; offsetY: number } {
  const turned = turnedSize(sourceWidth, sourceHeight, edit.turns);
  const scale = Math.min(boxWidth / turned.width, boxHeight / turned.height);
  const w = Math.max(1, Math.round(turned.width * scale));
  const h = Math.max(1, Math.round(turned.height * scale));

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  target.width = Math.round(w * dpr);
  target.height = Math.round(h * dpr);
  target.style.width = `${w}px`;
  target.style.height = `${h}px`;

  const ctx = target.getContext('2d');
  if (!ctx) return { scale, offsetX: 0, offsetY: 0 };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const filter = editFilter(edit);
  ctx.save();
  if (filter) ctx.filter = filter;
  ctx.translate(w / 2, h / 2);
  if (edit.straighten !== 0) ctx.rotate((edit.straighten * Math.PI) / 180);
  ctx.rotate((edit.turns * Math.PI) / 2);
  if (edit.flipH) ctx.scale(-1, 1);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    source,
    (-sourceWidth * scale) / 2,
    (-sourceHeight * scale) / 2,
    sourceWidth * scale,
    sourceHeight * scale,
  );
  ctx.restore();

  return { scale, offsetX: 0, offsetY: 0 };
}
