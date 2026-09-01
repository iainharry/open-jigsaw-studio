/**
 * Viewport: the mapping between world space (puzzle coordinates) and screen pixels.
 *
 * Kept separate from both the engine and the renderer because pan/zoom is a property
 * of *looking at* the puzzle, not of the puzzle itself, and because the reference-image
 * panel and any future minimap need the same maths without a canvas.
 */

import type { Point, Viewport } from '../engine/types.js';

export const MIN_ZOOM = 0.03;
export const MAX_ZOOM = 8;

export interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

export function worldToScreen(vp: Viewport, size: ScreenSize, p: Point): Point {
  return {
    x: (p.x - vp.x) * vp.zoom + size.width / 2,
    y: (p.y - vp.y) * vp.zoom + size.height / 2,
  };
}

export function screenToWorld(vp: Viewport, size: ScreenSize, p: Point): Point {
  return {
    x: (p.x - size.width / 2) / vp.zoom + vp.x,
    y: (p.y - size.height / 2) / vp.zoom + vp.y,
  };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Zoom by `factor`, keeping the world point under `anchor` (a screen point) fixed. */
export function zoomAbout(
  vp: Viewport,
  size: ScreenSize,
  anchor: Point,
  factor: number,
): Viewport {
  const before = screenToWorld(vp, size, anchor);
  const zoom = clampZoom(vp.zoom * factor);
  const after = { ...vp, zoom };
  const nowAt = screenToWorld(after, size, anchor);
  return { x: vp.x + (before.x - nowAt.x), y: vp.y + (before.y - nowAt.y), zoom };
}

/** Centre the viewport on a world rectangle, with a little breathing room. */
export function fitTo(
  size: ScreenSize,
  rect: { x: number; y: number; w: number; h: number },
  padding = 0.06,
): Viewport {
  const zoom = clampZoom(
    Math.min(size.width / (rect.w * (1 + padding * 2)), size.height / (rect.h * (1 + padding * 2))),
  );
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, zoom };
}

/** World-space rectangle currently visible, expanded by `margin` screen pixels. */
export function visibleWorldRect(
  vp: Viewport,
  size: ScreenSize,
  margin = 0,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const halfW = (size.width / 2 + margin) / vp.zoom;
  const halfH = (size.height / 2 + margin) / vp.zoom;
  return {
    minX: vp.x - halfW,
    minY: vp.y - halfH,
    maxX: vp.x + halfW,
    maxY: vp.y + halfH,
  };
}
