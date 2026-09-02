/**
 * Canvas2D renderer.
 *
 * Deliberately thin: it reads engine state and draws it, and owns no puzzle state of
 * its own. Everything renderer-specific (baked bitmaps, Path2D objects, device pixel
 * ratio) lives on this side of the line so that swapping in a WebGL renderer later
 * means writing a second file, not touching the engine.
 */

import { pieceWorldBounds, toSolved } from '../engine/clusters.js';
import { clusterOf, type PuzzleState } from '../engine/puzzle.js';
import {
  isHidden,
  isOnHeader,
  trayAt,
  trayBounds,
  trayMetrics,
  trayPieceCount,
} from '../engine/trays.js';
import type { Cluster, PieceGeometry, Point, Tray, Viewport } from '../engine/types.js';
import { BakeCache, bakeScaleFor, outlineToPath2D } from './bakeCache.js';
import { visibleWorldRect, worldToScreen, type ScreenSize } from './viewport.js';

export interface RenderStats {
  piecesDrawn: number;
  piecesCulled: number;
  bakedBytes: number;
  lastFrameMs: number;
  /**
   * Median of recent frames.
   *
   * `lastFrameMs` alone is misleading in the footer: once the view settles the app stops
   * drawing, so the last frame recorded is whichever one happened to do the baking after
   * a zoom or piece-count change. That reads as 80ms when the steady state is nearer 4ms.
   */
  medianFrameMs: number;
}

export interface RendererOptions {
  readonly showBoard?: boolean;
  readonly background?: string;
  readonly boardTint?: string;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hitCtx: CanvasRenderingContext2D;
  private readonly pathCache = new Map<number, Path2D>();
  readonly bakeCache: BakeCache;
  readonly stats: RenderStats = {
    piecesDrawn: 0,
    piecesCulled: 0,
    bakedBytes: 0,
    lastFrameMs: 0,
    medianFrameMs: 0,
  };
  private readonly recentFrames: number[] = [];

  showBoard: boolean;
  background: string;
  boardTint: string;
  /** Clusters currently being dragged, drawn with a lift shadow. */
  highlightClusters: Set<number> | null = null;
  /** Clusters in the user's selection, outlined. */
  selection: ReadonlySet<number> = new Set();
  /** Rubber-band rectangle in world space while a selection drag is in progress. */
  band: { x: number; y: number; w: number; h: number } | null = null;
  selectionColour = '#6aa9ff';
  /** Tray highlighted because it is selected, or because a drag is hovering over it. */
  selectedTray: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: RendererOptions = {},
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2D is not available in this browser');
    this.ctx = ctx;

    // A 1x1 scratch context used only for hit testing, so hit tests never depend on
    // whatever transform the last frame happened to leave behind.
    const scratch = document.createElement('canvas');
    const hitCtx = scratch.getContext('2d');
    if (!hitCtx) throw new Error('Canvas2D is not available in this browser');
    this.hitCtx = hitCtx;

    this.bakeCache = new BakeCache();
    this.showBoard = options.showBoard ?? true;
    this.background = options.background ?? '#14161a';
    this.boardTint = options.boardTint ?? 'rgba(255,255,255,0.05)';
  }

  setImage(image: CanvasImageSource, width: number, height: number): void {
    this.bakeCache.setSource(image, width, height);
  }

  invalidateGeometry(): void {
    this.pathCache.clear();
    this.bakeCache.clear();
  }

  private pathFor(piece: PieceGeometry): Path2D {
    let path = this.pathCache.get(piece.id);
    if (!path) {
      path = outlineToPath2D(piece.outline, 1);
      this.pathCache.set(piece.id, path);
    }
    return path;
  }

  get size(): ScreenSize {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
  }

  /** Resize the backing store to match CSS size and device pixel ratio. */
  resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  draw(state: PuzzleState, vp: Viewport): void {
    const t0 = performance.now();
    const bakesBefore = this.bakeCache.bakeCount;
    const { ctx } = this;
    const size = this.size;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, size.width, size.height);

    if (this.showBoard) {
      const tl = worldToScreen(vp, size, { x: 0, y: 0 });
      ctx.fillStyle = this.boardTint;
      ctx.fillRect(
        tl.x,
        tl.y,
        state.geometry.imageWidth * vp.zoom,
        state.geometry.imageHeight * vp.zoom,
      );
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        tl.x,
        tl.y,
        state.geometry.imageWidth * vp.zoom,
        state.geometry.imageHeight * vp.zoom,
      );
    }

    const view = visibleWorldRect(vp, size, 64);
    const bakeScale = bakeScaleFor(vp.zoom, dpr, this.bakeCache.maxScale);

    // Trays paint first, behind their contents.
    this.drawTrays(state, vp, size);

    let drawn = 0;
    let culled = 0;

    for (const clusterId of state.zOrder) {
      const cluster = state.clusters.get(clusterId);
      if (!cluster) continue;
      // A collapsed tray's pieces are not drawn at all. That is the whole point of the
      // feature: fifty pieces become one tile and stop competing for screen space.
      if (isHidden(state, clusterId)) {
        culled += cluster.pieces.length;
        continue;
      }

      const lifted = this.highlightClusters?.has(clusterId) ?? false;
      const selected = this.selection.has(clusterId);
      const origin = worldToScreen(vp, size, { x: cluster.x, y: cluster.y });

      ctx.save();
      ctx.translate(origin.x, origin.y);
      if (cluster.rotation !== 0) ctx.rotate(cluster.rotation);
      ctx.scale(vp.zoom, vp.zoom);

      if (lifted) {
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 18 / vp.zoom;
        ctx.shadowOffsetY = 6 / vp.zoom;
      }

      const visible: number[] = [];
      for (const pieceId of cluster.pieces) {
        const piece = state.geometry.pieces[pieceId]!;
        const wb = pieceWorldBounds(cluster, piece);
        if (wb.maxX < view.minX || wb.minX > view.maxX || wb.maxY < view.minY || wb.minY > view.maxY) {
          culled++;
          continue;
        }
        const baked = this.bakeCache.get(piece, bakeScale);
        if (!baked) continue;
        ctx.drawImage(
          baked.canvas,
          piece.solved.x - cluster.pivotX,
          piece.solved.y - cluster.pivotY,
          piece.bounds.w,
          piece.bounds.h,
        );
        visible.push(pieceId);
        drawn++;
      }

      // Outline the selection last, so a piece's own edge never paints over it.
      if (selected && visible.length > 0) {
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = this.selectionColour;
        ctx.lineWidth = 2.5 / vp.zoom;
        ctx.lineJoin = 'round';
        for (const pieceId of visible) {
          const piece = state.geometry.pieces[pieceId]!;
          ctx.save();
          ctx.translate(piece.solved.x - cluster.pivotX, piece.solved.y - cluster.pivotY);
          ctx.stroke(this.pathFor(piece));
          ctx.restore();
        }
      }

      ctx.restore();
    }

    if (this.band) {
      const a = worldToScreen(vp, size, { x: this.band.x, y: this.band.y });
      const b = worldToScreen(vp, size, {
        x: this.band.x + this.band.w,
        y: this.band.y + this.band.h,
      });
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.fillStyle = 'rgba(106,169,255,0.12)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = this.selectionColour;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.setLineDash([]);
    }

    this.stats.piecesDrawn = drawn;
    this.stats.piecesCulled = culled;
    this.stats.bakedBytes = this.bakeCache.usedBytes;
    const elapsed = performance.now() - t0;
    this.stats.lastFrameMs = elapsed;

    // Only frames that rasterised nothing count towards the reported median. A frame that
    // baked two hundred pieces after a zoom or a new picture costs tens of milliseconds and
    // is entirely unrepresentative -- reporting it made the footer claim 28ms where the
    // steady state measures 1.3ms. The spike is real but it happens once, not every frame.
    if (this.bakeCache.bakeCount === bakesBefore) {
      this.recentFrames.push(elapsed);
      if (this.recentFrames.length > 60) this.recentFrames.shift();
    }
    if (this.recentFrames.length > 0) {
      const sorted = [...this.recentFrames].sort((a, b) => a - b);
      this.stats.medianFrameMs = sorted[sorted.length >> 1]!;
    } else {
      this.stats.medianFrameMs = elapsed;
    }
  }

  private drawTrays(state: PuzzleState, vp: Viewport, size: ScreenSize): void {
    const { ctx } = this;
    const { header } = trayMetrics(state);

    for (const tray of state.trays.values()) {
      const b = trayBounds(state, tray);
      const tl = worldToScreen(vp, size, { x: b.x, y: b.y });
      const w = b.w * vp.zoom;
      const h = b.h * vp.zoom;
      if (tl.x + w < 0 || tl.x > size.width || tl.y + h < 0 || tl.y > size.height) continue;

      const selected = this.selectedTray === tray.id;
      const radius = Math.min(10, h / 2);

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(tl.x, tl.y, w, h, radius);
      ctx.fillStyle = tray.collapsed ? 'rgba(32,40,52,0.96)' : 'rgba(26,32,41,0.82)';
      ctx.fill();
      ctx.strokeStyle = selected ? this.selectionColour : 'rgba(255,255,255,0.18)';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();

      // Header bar.
      const headerH = Math.min(header * vp.zoom, h);
      ctx.beginPath();
      ctx.roundRect(tl.x, tl.y, w, headerH, [radius, radius, 0, 0]);
      ctx.fillStyle = selected ? 'rgba(106,169,255,0.22)' : 'rgba(255,255,255,0.07)';
      ctx.fill();

      const fontPx = Math.max(9, Math.min(headerH * 0.52, 16));
      if (fontPx >= 9) {
        ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(230,233,238,0.95)';
        const chevron = tray.collapsed ? '▸' : '▾';
        const count = trayPieceCount(state, tray);
        const label = `${chevron} ${tray.name}`;
        const suffix = `${count}`;
        const pad = fontPx * 0.6;

        ctx.save();
        ctx.beginPath();
        ctx.rect(tl.x, tl.y, Math.max(0, w - pad), headerH);
        ctx.clip();
        ctx.fillText(label, tl.x + pad, tl.y + headerH / 2);
        ctx.restore();

        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(141,151,166,0.95)';
        ctx.fillText(suffix, tl.x + w - pad, tl.y + headerH / 2);
        ctx.textAlign = 'left';
      }
      ctx.restore();
    }
  }

  /** The tray whose header or body is under a world point. */
  trayHitTest(state: PuzzleState, world: Point): { tray: Tray; onHeader: boolean } | null {
    const tray = trayAt(state, world);
    if (!tray) return null;
    return { tray, onHeader: isOnHeader(state, tray, world) };
  }

  /**
   * Topmost piece under a world point, or null.
   *
   * Hit testing happens in piece-local space: the world point is pushed back through
   * the cluster transform, which means it works unchanged for rotated assemblies and
   * costs nothing extra when rotation is off.
   */
  hitTest(state: PuzzleState, world: Point): { pieceId: number; clusterId: number } | null {
    for (let i = state.zOrder.length - 1; i >= 0; i--) {
      const cluster = state.clusters.get(state.zOrder[i]!);
      if (!cluster) continue;
      // Not drawn means not grabbable.
      if (isHidden(state, cluster.id)) continue;
      const local = toSolved(cluster, world);
      for (const pieceId of cluster.pieces) {
        const piece = state.geometry.pieces[pieceId]!;
        const px = local.x - piece.bounds.x;
        const py = local.y - piece.bounds.y;
        if (px < 0 || py < 0 || px > piece.bounds.w || py > piece.bounds.h) continue;
        if (this.hitCtx.isPointInPath(this.pathFor(piece), px, py)) {
          return { pieceId, clusterId: cluster.id };
        }
      }
    }
    return null;
  }

  /** Bounding box of everything on the board, for "fit to view". */
  contentBounds(state: PuzzleState): { x: number; y: number; w: number; h: number } {
    let minX = 0;
    let minY = 0;
    let maxX = state.geometry.imageWidth;
    let maxY = state.geometry.imageHeight;
    for (const cluster of state.clusters.values()) {
      for (const pieceId of cluster.pieces) {
        const wb = pieceWorldBounds(cluster, state.geometry.pieces[pieceId]!);
        if (wb.minX < minX) minX = wb.minX;
        if (wb.minY < minY) minY = wb.minY;
        if (wb.maxX > maxX) maxX = wb.maxX;
        if (wb.maxY > maxY) maxY = wb.maxY;
      }
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
}

export { clusterOf };
export type { Cluster };
