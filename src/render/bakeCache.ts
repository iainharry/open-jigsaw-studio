/**
 * Baked piece bitmaps, with a memory budget and LRU eviction.
 *
 * This is the file that decides whether the app survives 2,000 pieces on a tablet.
 *
 * Canvas2D cannot clip a path per piece per frame at any useful frame rate, so each
 * piece is rasterised once into its own small bitmap and then blitted. The catch is
 * memory: 2,000 pieces from a 24-megapixel photo, each baked at full resolution, is
 * roughly 190 MB of RGBA before you count the decoded source image. That is an
 * out-of-memory crash on a mid-range Android tablet, not a slow frame.
 *
 * So bakes are (a) capped at a scale relative to the current zoom rather than the
 * source resolution, (b) budgeted in bytes, and (c) evicted least-recently-used. A
 * piece that is off-screen and has not been drawn for a while costs nothing.
 *
 * The long-term fix is a WebGL renderer that triangulates each outline and samples one
 * shared texture, which is why `PieceGeometry` is an outline plus a UV rect rather than
 * anything Canvas2D-specific. This cache is what makes Canvas2D good enough until then.
 */

import type { PathCommand, PieceGeometry } from '../engine/types.js';

export interface BakedPiece {
  readonly canvas: HTMLCanvasElement;
  readonly scale: number;
  readonly bytes: number;
}

export function outlineToPath2D(outline: readonly PathCommand[], scale = 1): Path2D {
  const path = new Path2D();
  for (const cmd of outline) {
    if (cmd.kind === 'move') {
      path.moveTo(cmd.to.x * scale, cmd.to.y * scale);
    } else if (cmd.kind === 'cubic') {
      path.bezierCurveTo(
        cmd.c1.x * scale,
        cmd.c1.y * scale,
        cmd.c2.x * scale,
        cmd.c2.y * scale,
        cmd.to.x * scale,
        cmd.to.y * scale,
      );
    } else {
      path.closePath();
    }
  }
  return path;
}

/** Quantise zoom into bake scales so small zoom changes do not invalidate every bitmap. */
export function bakeScaleFor(zoom: number, dpr: number, maxScale: number): number {
  const wanted = zoom * dpr;
  const bucket = Math.pow(2, Math.round(Math.log2(Math.max(wanted, 1e-3)) * 2) / 2);
  return Math.min(maxScale, Math.max(0.06, bucket));
}

export interface BakeCacheOptions {
  /** Byte budget for baked bitmaps. Default 96 MB. */
  readonly budgetBytes?: number;
  /** Never bake above this multiple of source resolution. */
  readonly maxScale?: number;
  /** Draw a soft edge highlight so pieces read against each other. */
  readonly bevel?: boolean;
}

export class BakeCache {
  private readonly entries = new Map<string, BakedPiece>();
  private readonly budgetBytes: number;
  readonly maxScale: number;
  private readonly bevel: boolean;
  private bytes = 0;
  /** Bakes performed, so the renderer can tell a one-off rasterising frame from a normal one. */
  bakeCount = 0;
  private source: CanvasImageSource | null = null;
  private sourceWidth = 0;
  private sourceHeight = 0;

  constructor(options: BakeCacheOptions = {}) {
    this.budgetBytes = options.budgetBytes ?? 96 * 1024 * 1024;
    this.maxScale = options.maxScale ?? 1;
    this.bevel = options.bevel ?? true;
  }

  setSource(image: CanvasImageSource, width: number, height: number): void {
    this.source = image;
    this.sourceWidth = width;
    this.sourceHeight = height;
    this.clear();
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get usedBytes(): number {
    return this.bytes;
  }

  get size(): number {
    return this.entries.size;
  }

  get(piece: PieceGeometry, scale: number): BakedPiece | null {
    if (!this.source) return null;
    const key = `${piece.id}@${scale}`;
    const hit = this.entries.get(key);
    if (hit) {
      // Refresh LRU position.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const baked = this.bake(piece, scale);
    if (!baked) return null;
    this.bakeCount++;
    this.entries.set(key, baked);
    this.bytes += baked.bytes;
    this.evictIfNeeded(key);
    return baked;
  }

  private evictIfNeeded(protectKey: string): void {
    if (this.bytes <= this.budgetBytes) return;
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.budgetBytes) break;
      if (key === protectKey) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
  }

  private bake(piece: PieceGeometry, scale: number): BakedPiece | null {
    if (!this.source) return null;
    const w = Math.max(1, Math.ceil(piece.bounds.w * scale));
    const h = Math.max(1, Math.ceil(piece.bounds.h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const path = outlineToPath2D(piece.outline, scale);

    ctx.save();
    ctx.clip(path);
    // Draw the whole source image offset so the piece's region lands at the origin.
    // No source-rectangle arithmetic, so tab overhang near the image border simply
    // resolves to transparent pixels rather than an out-of-bounds read.
    ctx.drawImage(
      this.source,
      -piece.bounds.x * scale,
      -piece.bounds.y * scale,
      this.sourceWidth * scale,
      this.sourceHeight * scale,
    );
    ctx.restore();

    if (this.bevel) {
      ctx.save();
      ctx.clip(path);
      ctx.lineWidth = Math.max(1, 1.6 * scale);
      ctx.strokeStyle = 'rgba(0,0,0,0.30)';
      ctx.stroke(path);
      ctx.lineWidth = Math.max(0.5, 0.7 * scale);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.stroke(path);
      ctx.restore();
    }

    return { canvas, scale, bytes: w * h * 4 };
  }
}
