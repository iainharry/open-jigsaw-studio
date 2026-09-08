/**
 * Unified pointer input: mouse, touch and pen on one code path.
 *
 * Pointer Events rather than separate mouse/touch handlers, deliberately. A stylus on an
 * Android tablet, a finger and a mouse all arrive here as the same event with a different
 * `pointerType`, which is the only reason one gesture implementation can be correct on a
 * PC and a tablet at once.
 *
 * Gestures:
 *   one pointer on a piece      drag it, or the whole selection if it is part of one
 *   one pointer on the board    pan (or rubber-band select in select mode / with Shift)
 *   two pointers, not dragging  pinch zoom and pan
 *   two pointers while dragging twist the held pieces about the first finger
 *   wheel                       zoom about the cursor
 *
 * Two design notes worth keeping:
 *
 * A second finger landing mid-drag means "turn this piece", not "abandon it and zoom".
 * That is the gesture people actually make with a physical puzzle piece, and it is why
 * the pinch handler checks whether a drag is in progress before claiming the pointers.
 *
 * Rotation gestures are inert unless the puzzle has rotation enabled. With rotation off
 * the snap test ignores angle, so a piece that could be turned would snap home while
 * visibly sideways.
 */

import {
  clustersIntersecting,
  moveClusters,
  quantiseClusterRotations,
  releaseClusters,
  rotateClusters,
  selectionCentre,
  bringToFront,
  type PuzzleState,
} from '../engine/puzzle.js';
import { addToTray, moveTray, removeFromTray, trayAt } from '../engine/trays.js';
import type { Point, Viewport } from '../engine/types.js';
import type { Renderer } from '../render/renderer.js';
import { screenToWorld, zoomAbout } from '../render/viewport.js';

type Mode = 'idle' | 'drag' | 'twist' | 'pan' | 'band' | 'pinch' | 'tray';
export type Tool = 'move' | 'select';

/** Movement below this many screen pixels counts as a tap, not a drag. */
const TAP_SLOP = 4;

export interface PointerCallbacks {
  getState(): PuzzleState | null;
  getViewport(): Viewport;
  setViewport(vp: Viewport): void;
  getTool(): Tool;
  /** Mutable selection of cluster ids, owned by the app. */
  selection: Set<number>;
  onChange(): void;
  onSelectionChange?(): void;
  /**
   * A piece was picked up. Fired for the piece under the pointer whenever a press lands
   * on one, which is the natural "the piece in my hand" signal -- selection is not, since
   * grabbing a piece deliberately clears the selection to start a fresh single drag.
   */
  onGrab?(pieceId: number, clusterId: number): void;
  onDrop?(result: { clusterIds: number[]; merges: number }): void;
  onTrayChange?(): void;
  /** A tray header was tapped without dragging — the app opens its rename editor. */
  onTrayActivate?(trayId: number): void;
}

interface Tracked {
  x: number;
  y: number;
}

export class PointerInput {
  private readonly pointers = new Map<number, Tracked>();
  private readonly order: number[] = [];
  private mode: Mode = 'idle';
  /** Cluster ids being dragged. Either the selection, or the single cluster grabbed. */
  private dragging: number[] = [];
  private lastWorld: Point = { x: 0, y: 0 };
  private lastScreen: Point = { x: 0, y: 0 };
  private downScreen: Point = { x: 0, y: 0 };
  private movedFar = false;
  private bandStart: Point = { x: 0, y: 0 };
  private bandAdditive = false;
  private pinchDistance = 0;
  private pinchMid: Point = { x: 0, y: 0 };
  private twistAngle = 0;
  private dragTrayId: number | null = null;
  private trayWasHeaderTap = false;
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

    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      c.addEventListener(type, fn as EventListener, opts);
      this.detach.push(() => c.removeEventListener(type, fn as EventListener, opts));
    };

    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e));
    on('pointercancel', (e) => this.onUp(e));
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('contextmenu', (e) => e.preventDefault());

    const keys = (e: KeyboardEvent): void => this.onKey(e);
    window.addEventListener('keydown', keys);
    this.detach.push(() => window.removeEventListener('keydown', keys));
  }

  dispose(): void {
    for (const fn of this.detach) fn();
    this.detach = [];
  }

  // --- helpers --------------------------------------------------------------

  private local(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private toWorld(p: Point): Point {
    return screenToWorld(this.cb.getViewport(), this.renderer.size, p);
  }

  private rotationAllowed(): boolean {
    return this.cb.getState()?.settings.rotationEnabled ?? false;
  }

  private tracked(index: number): Tracked | null {
    const id = this.order[index];
    return id === undefined ? null : (this.pointers.get(id) ?? null);
  }

  /** Rotate the current drag set, or the selection, by `angle` about its own centre. */
  rotateSelection(angle: number): void {
    const state = this.cb.getState();
    if (!state || !this.rotationAllowed()) return;
    const ids = this.dragging.length > 0 ? this.dragging : [...this.cb.selection];
    if (ids.length === 0) return;
    const centre = selectionCentre(state, ids);
    if (!centre) return;
    rotateClusters(state, ids, angle, centre);
    quantiseClusterRotations(state, ids);
    this.cb.onChange();
  }

  // --- pointer handling -----------------------------------------------------

  private onDown(e: PointerEvent): void {
    const state = this.cb.getState();
    if (!state) return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Throws if the pointer has already gone; gestures still work without capture.
    }

    const p = this.local(e);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y });
    this.order.push(e.pointerId);

    if (this.pointers.size === 2) {
      if (this.mode === 'drag' && this.rotationAllowed()) {
        this.beginTwist();
      } else {
        this.finishDrag();
        this.mode = 'band' === this.mode ? 'band' : 'pinch';
        this.beginPinch();
      }
      return;
    }
    if (this.pointers.size > 2) return;

    this.downScreen = p;
    this.movedFar = false;

    const world = this.toWorld(p);
    const hit = this.renderer.hitTest(state, world);
    const bandGesture = this.cb.getTool() === 'select' || e.shiftKey;

    // A tray header beats anything under it: it is the handle for moving the tray, and
    // for a collapsed tray it is the only thing there.
    const trayHit = this.renderer.trayHitTest(state, world);
    if (trayHit && (trayHit.onHeader || (!hit && !bandGesture))) {
      this.mode = 'tray';
      this.dragTrayId = trayHit.tray.id;
      this.trayWasHeaderTap = trayHit.onHeader;
      this.lastWorld = world;
      this.renderer.selectedTray = trayHit.tray.id;
      this.cb.onChange();
      return;
    }

    if (hit && e.button !== 1) {
      if (e.shiftKey) {
        // Shift-click toggles one cluster in and out of the selection.
        if (this.cb.selection.has(hit.clusterId)) this.cb.selection.delete(hit.clusterId);
        else this.cb.selection.add(hit.clusterId);
        this.cb.onSelectionChange?.();
        this.mode = 'idle';
        this.cb.onChange();
        return;
      }

      // Grabbing a piece that is part of the selection drags the whole selection;
      // grabbing anything else starts a fresh single-piece drag.
      if (this.cb.selection.has(hit.clusterId)) {
        this.dragging = [...this.cb.selection].filter((id) => state.clusters.has(id));
      } else {
        this.cb.selection.clear();
        this.cb.onSelectionChange?.();
        this.dragging = [hit.clusterId];
      }
      for (const id of this.dragging) bringToFront(state, id);
      this.mode = 'drag';
      this.renderer.highlightClusters = new Set(this.dragging);
      this.lastWorld = world;
      // After the selection bookkeeping above, so anything keyed off the grabbed piece
      // is not immediately overwritten by the selection having been cleared.
      this.cb.onGrab?.(hit.pieceId, hit.clusterId);
    } else if (bandGesture) {
      this.mode = 'band';
      this.bandStart = world;
      this.bandAdditive = e.shiftKey;
      if (!this.bandAdditive) {
        this.cb.selection.clear();
        this.cb.onSelectionChange?.();
      }
      this.renderer.band = { x: world.x, y: world.y, w: 0, h: 0 };
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
    if (Math.hypot(p.x - this.downScreen.x, p.y - this.downScreen.y) > TAP_SLOP) {
      this.movedFar = true;
    }

    switch (this.mode) {
      case 'twist':
        this.updateTwist(state);
        break;

      case 'pinch':
        if (this.pointers.size >= 2) this.updatePinch();
        break;

      case 'tray': {
        if (this.dragTrayId === null) break;
        const world = this.toWorld(p);
        moveTray(state, this.dragTrayId, world.x - this.lastWorld.x, world.y - this.lastWorld.y);
        this.lastWorld = world;
        break;
      }

      case 'drag': {
        const world = this.toWorld(p);
        moveClusters(state, this.dragging, world.x - this.lastWorld.x, world.y - this.lastWorld.y);
        this.lastWorld = world;
        // Highlight the tray the pieces would land in if released here.
        const over = trayAt(state, world);
        this.renderer.selectedTray = over ? over.id : null;
        break;
      }

      case 'band': {
        const world = this.toWorld(p);
        this.renderer.band = {
          x: this.bandStart.x,
          y: this.bandStart.y,
          w: world.x - this.bandStart.x,
          h: world.y - this.bandStart.y,
        };
        break;
      }

      case 'pan': {
        const vp = this.cb.getViewport();
        this.cb.setViewport({
          ...vp,
          x: vp.x - (p.x - this.lastScreen.x) / vp.zoom,
          y: vp.y - (p.y - this.lastScreen.y) / vp.zoom,
        });
        this.lastScreen = p;
        break;
      }

      default:
        return;
    }
    this.cb.onChange();
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    const at = this.order.indexOf(e.pointerId);
    if (at >= 0) this.order.splice(at, 1);
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* already released */
    }

    if (this.pointers.size === 1) {
      if (this.mode === 'twist') {
        // Second finger lifted: carry on dragging with the one that remains.
        this.mode = 'drag';
        const remaining = this.tracked(0);
        if (remaining) this.lastWorld = this.toWorld(remaining);
        return;
      }
      if (this.mode === 'pinch') {
        this.mode = 'pan';
        const remaining = this.tracked(0);
        if (remaining) this.lastScreen = { x: remaining.x, y: remaining.y };
        return;
      }
    }

    if (this.pointers.size > 0) return;

    const state = this.cb.getState();
    if (this.mode === 'band' && state) {
      const band = this.renderer.band;
      if (band) {
        for (const id of clustersIntersecting(state, band)) this.cb.selection.add(id);
        this.cb.onSelectionChange?.();
      }
      this.renderer.band = null;
    } else if (this.mode === 'pan' && !this.movedFar && this.cb.selection.size > 0) {
      // A tap on empty board clears the selection.
      this.cb.selection.clear();
      this.cb.onSelectionChange?.();
    } else if (this.mode === 'tray' && state) {
      // A header tap that never became a drag is a request to rename or collapse.
      if (this.trayWasHeaderTap && !this.movedFar && this.dragTrayId !== null) {
        this.cb.onTrayActivate?.(this.dragTrayId);
      }
      this.dragTrayId = null;
      this.cb.onTrayChange?.();
    } else if (this.mode === 'drag' || this.mode === 'twist') {
      this.finishDrag();
    }

    this.mode = 'idle';
    this.renderer.highlightClusters = null;
    this.renderer.selectedTray = null;
    this.cb.onChange();
  }

  private finishDrag(): void {
    const state = this.cb.getState();
    if (!state || this.dragging.length === 0) return;

    if (this.rotationAllowed()) quantiseClusterRotations(state, this.dragging);

    // Where the pieces were let go decides whether they join a tray, leave one, or
    // simply land on the board.
    const target = trayAt(state, this.lastWorld);
    if (target) {
      addToTray(state, target.id, this.dragging);
      this.dragging = [];
      this.renderer.highlightClusters = null;
      this.cb.onTrayChange?.();
      this.cb.onDrop?.({ clusterIds: [], merges: 0 });
      return;
    }
    // Dropped on open board: anything that came out of a tray is now free, and free
    // pieces snap as usual.
    removeFromTray(state, this.dragging);

    const result = releaseClusters(state, this.dragging);
    // Merges retire cluster ids, so a stale selection would point at nothing.
    if (this.cb.selection.size > 0) {
      const kept = [...this.cb.selection].filter((id) => state.clusters.has(id));
      this.cb.selection.clear();
      for (const id of kept) this.cb.selection.add(id);
      this.cb.onSelectionChange?.();
    }
    this.dragging = [];
    this.renderer.highlightClusters = null;
    this.cb.onTrayChange?.();
    this.cb.onDrop?.(result);
  }

  // --- two-pointer gestures -------------------------------------------------

  private beginTwist(): void {
    const a = this.tracked(0);
    const b = this.tracked(1);
    if (!a || !b) return;
    this.mode = 'twist';
    this.twistAngle = Math.atan2(b.y - a.y, b.x - a.x);
  }

  private updateTwist(state: PuzzleState): void {
    const a = this.tracked(0);
    const b = this.tracked(1);
    if (!a || !b) return;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const delta = angle - this.twistAngle;
    // Turn about the held finger, so the piece pivots where it is pinned.
    rotateClusters(state, this.dragging, delta, this.toWorld(a));
    this.twistAngle = angle;
    this.lastWorld = this.toWorld(a);
  }

  private beginPinch(): void {
    const a = this.tracked(0);
    const b = this.tracked(1);
    if (!a || !b) return;
    this.mode = 'pinch';
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.renderer.band = null;
  }

  private updatePinch(): void {
    const a = this.tracked(0);
    const b = this.tracked(1);
    if (!a || !b) return;
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    const size = this.renderer.size;
    let vp = this.cb.getViewport();
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
    this.cb.setViewport(
      zoomAbout(this.cb.getViewport(), this.renderer.size, anchor, Math.exp(-e.deltaY * unit * 0.0016)),
    );
    this.cb.onChange();
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    const state = this.cb.getState();
    if (!state) return;

    if (e.key === 'Escape' && this.cb.selection.size > 0) {
      this.cb.selection.clear();
      this.cb.onSelectionChange?.();
      this.cb.onChange();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      this.rotateSelection(e.shiftKey ? -Math.PI / 2 : Math.PI / 2);
      return;
    }
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      for (const id of state.clusters.keys()) this.cb.selection.add(id);
      this.cb.onSelectionChange?.();
      this.cb.onChange();
    }
  }
}
