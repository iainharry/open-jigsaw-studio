/**
 * Unified pointer input: mouse, touch and pen on one code path.
 *
 * Pointer Events rather than separate mouse/touch handlers, deliberately. A stylus on
 * an Android tablet, a finger, and a mouse all arrive here as the same event with a
 * different `pointerType`, which is the only reason a single gesture implementation can
 * be correct on a PC and a tablet at once. Retrofitting touch onto mouse handlers later
 * is how apps end up with two subtly different drag behaviours.
 *
 * Gestures:
 *   one pointer on a piece   -> drag that cluster
 *   one pointer on the board -> pan
 *   two pointers             -> pinch zoom and pan together
 *   wheel                    -> zoom about the cursor
 */

import { bringToFront, moveCluster, releaseCluster, type PuzzleState } from '../engine/puzzle.js';
import type { Point, Viewport } from '../engine/types.js';
import type { Renderer } from '../render/renderer.js';
import { screenToWorld, zoomAbout } from '../render/viewport.js';

type Mode = 'idle' | 'drag' | 'pan' | 'pinch';

export interface PointerCallbacks {
  getState(): PuzzleState | null;
  getViewport(): Viewport;
  setViewport(vp: Viewport): void;
  onChange(): void;
  onDragStart?(clusterId: number): void;
  onDrop?(result: { clusterId: number; merges: number }): void;
}

interface Tracked {
  x: number;
  y: number;
}

export class PointerInput {
  private readonly pointers = new Map<number, Tracked>();
  private mode: Mode = 'idle';
  private dragClusterId: number | null = null;
  private lastWorld: Point = { x: 0, y: 0 };
  private lastScreen: Point = { x: 0, y: 0 };
  private pinchDistance = 0;
  private pinchMid: Point = { x: 0, y: 0 };
  private detach: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: Renderer,
    private readonly cb: PointerCallbacks,
  ) {
    this.attach();
  }

  private attach(): void {
    const c = this.canvas;
    // Without this the browser claims touch drags for scrolling and pinch for page zoom.
    c.style.touchAction = 'none';

    const add = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      c.addEventListener(type, fn as EventListener, opts);
      this.detach.push(() => c.removeEventListener(type, fn as EventListener, opts));
    };

    add('pointerdown', (e) => this.onDown(e));
    add('pointermove', (e) => this.onMove(e));
    add('pointerup', (e) => this.onUp(e));
    add('pointercancel', (e) => this.onUp(e));
    add('wheel', (e) => this.onWheel(e), { passive: false });
    add('contextmenu', (e) => e.preventDefault());
  }

  dispose(): void {
    for (const fn of this.detach) fn();
    this.detach = [];
  }

  private local(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private toWorld(p: Point): Point {
    return screenToWorld(this.cb.getViewport(), this.renderer.size, p);
  }

  private onDown(e: PointerEvent): void {
    const state = this.cb.getState();
    if (!state) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    const p = this.local(e);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y });

    if (this.pointers.size === 2) {
      // A second finger converts a drag into a pinch. Release the dragged cluster
      // first so it snaps if it happens to be in place, rather than being abandoned.
      this.finishDrag();
      this.beginPinch();
      return;
    }
    if (this.pointers.size > 2) return;

    const world = this.toWorld(p);
    const hit = this.renderer.hitTest(state, world);

    if (hit && e.button !== 1) {
      this.mode = 'drag';
      this.dragClusterId = hit.clusterId;
      bringToFront(state, hit.clusterId);
      this.renderer.highlightCluster = hit.clusterId;
      this.lastWorld = world;
      this.cb.onDragStart?.(hit.clusterId);
    } else {
      this.mode = 'pan';
      this.lastScreen = p;
    }
    this.cb.onChange();
  }

  private onMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const state = this.cb.getState();
    if (!state) return;

    const p = this.local(e);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y });

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      this.updatePinch();
      this.cb.onChange();
      return;
    }

    if (this.mode === 'drag' && this.dragClusterId !== null) {
      const world = this.toWorld(p);
      moveCluster(state, this.dragClusterId, world.x - this.lastWorld.x, world.y - this.lastWorld.y);
      this.lastWorld = world;
      this.cb.onChange();
      return;
    }

    if (this.mode === 'pan') {
      const vp = this.cb.getViewport();
      this.cb.setViewport({
        ...vp,
        x: vp.x - (p.x - this.lastScreen.x) / vp.zoom,
        y: vp.y - (p.y - this.lastScreen.y) / vp.zoom,
      });
      this.lastScreen = p;
      this.cb.onChange();
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }

    if (this.pointers.size === 1 && this.mode === 'pinch') {
      // Second finger lifted: continue as a pan from wherever the remaining one is.
      const remaining = [...this.pointers.values()][0]!;
      this.mode = 'pan';
      this.lastScreen = { x: remaining.x, y: remaining.y };
      return;
    }

    if (this.pointers.size > 0) return;

    if (this.mode === 'drag') this.finishDrag();
    this.mode = 'idle';
    this.renderer.highlightCluster = null;
    this.cb.onChange();
  }

  private finishDrag(): void {
    const state = this.cb.getState();
    if (!state || this.dragClusterId === null) return;
    const result = releaseCluster(state, this.dragClusterId);
    this.dragClusterId = null;
    this.renderer.highlightCluster = null;
    this.cb.onDrop?.(result);
  }

  private twoPointers(): [Tracked, Tracked] {
    const list = [...this.pointers.values()];
    return [list[0]!, list[1]!];
  }

  private beginPinch(): void {
    const [a, b] = this.twoPointers();
    this.mode = 'pinch';
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private updatePinch(): void {
    const [a, b] = this.twoPointers();
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    const size = this.renderer.size;
    let vp = this.cb.getViewport();

    // Pan by the movement of the midpoint, then zoom about the new midpoint.
    vp = {
      ...vp,
      x: vp.x - (mid.x - this.pinchMid.x) / vp.zoom,
      y: vp.y - (mid.y - this.pinchMid.y) / vp.zoom,
    };
    vp = zoomAbout(vp, size, mid, distance / this.pinchDistance);

    this.cb.setViewport(vp);
    this.pinchDistance = distance;
    this.pinchMid = mid;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // Normalise line-mode and page-mode wheels so a trackpad and a mouse feel similar.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(-e.deltaY * unit * 0.0016);
    this.cb.setViewport(zoomAbout(this.cb.getViewport(), this.renderer.size, anchor, factor));
    this.cb.onChange();
  }
}
