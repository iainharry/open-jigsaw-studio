/**
 * Piece trays: named holding areas for loose pieces.
 *
 * Why this is not just "a cluster with a name", which is what the first architecture note
 * claimed: a cluster holds its members rigidly at their *solved* offsets, which is exactly
 * right for pieces you have joined and completely wrong for a box of unrelated sky pieces.
 * A tray therefore owns a list of cluster ids and positions them itself.
 *
 * The packing is shelf packing rather than a uniform grid, because a tray can hold a
 * single piece and a twelve-piece assembly side by side and a uniform grid sized to the
 * largest member would waste most of the tray.
 *
 * All of this is pure geometry over plain data, so it tests in Node without a canvas.
 */

import { toWorld } from './clusters.js';
import type { PuzzleState } from './puzzle.js';
import type { Cluster, PieceGeometry, Tray } from './types.js';

/** Height of the tray's title bar, in world units, relative to a piece cell. */
export const TRAY_HEADER_RATIO = 0.42;
/** Gap between packed items, and between items and the tray edge. */
export const TRAY_GAP_RATIO = 0.12;

export interface TrayMetrics {
  header: number;
  gap: number;
}

export function trayMetrics(state: PuzzleState): TrayMetrics {
  const cell = Math.min(state.geometry.cellWidth, state.geometry.cellHeight);
  return { header: cell * TRAY_HEADER_RATIO, gap: cell * TRAY_GAP_RATIO };
}

/** Size of a cluster's own bounding box in solved space, ignoring where it currently is. */
export function clusterExtent(
  state: PuzzleState,
  clusterId: number,
): { w: number; h: number } | null {
  const cluster = state.clusters.get(clusterId);
  if (!cluster) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pieceId of cluster.pieces) {
    const piece: PieceGeometry = state.geometry.pieces[pieceId]!;
    if (piece.bounds.x < minX) minX = piece.bounds.x;
    if (piece.bounds.y < minY) minY = piece.bounds.y;
    if (piece.bounds.x + piece.bounds.w > maxX) maxX = piece.bounds.x + piece.bounds.w;
    if (piece.bounds.y + piece.bounds.h > maxY) maxY = piece.bounds.y + piece.bounds.h;
  }
  // A rotated cluster occupies its rotated footprint; use the larger square to keep
  // packing stable as the player turns things.
  const w = maxX - minX;
  const h = maxY - minY;
  if (cluster.rotation !== 0) {
    const side = Math.max(w, h);
    return { w: side, h: side };
  }
  return { w, h };
}

/** Where a cluster's solved-space top-left sits, so a packed position can be applied. */
function clusterOrigin(state: PuzzleState, cluster: Cluster): { x: number; y: number } {
  let minX = Infinity;
  let minY = Infinity;
  for (const pieceId of cluster.pieces) {
    const piece = state.geometry.pieces[pieceId]!;
    if (piece.bounds.x < minX) minX = piece.bounds.x;
    if (piece.bounds.y < minY) minY = piece.bounds.y;
  }
  return { x: minX, y: minY };
}

export interface PackedItem {
  clusterId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PackResult {
  items: PackedItem[];
  /** Inner content size, excluding the header. */
  width: number;
  height: number;
}

/**
 * Shelf-pack the tray's clusters into rows, wrapping at the tray width.
 *
 * Deliberately preserves insertion order rather than sorting by size. A player who drops
 * pieces in a particular order expects to find them roughly where they put them; a
 * height-sorted pack would reshuffle the whole tray every time one piece was added.
 */
export function packTray(state: PuzzleState, tray: Tray): PackResult {
  const { gap } = trayMetrics(state);
  const items: PackedItem[] = [];

  let cursorX = gap;
  let cursorY = gap;
  let rowHeight = 0;
  let widest = 0;

  for (const clusterId of tray.clusters) {
    const extent = clusterExtent(state, clusterId);
    if (!extent) continue;

    if (cursorX > gap && cursorX + extent.w > tray.width - gap) {
      cursorX = gap;
      cursorY += rowHeight + gap;
      rowHeight = 0;
    }

    items.push({ clusterId, x: cursorX, y: cursorY, w: extent.w, h: extent.h });
    cursorX += extent.w + gap;
    if (extent.h > rowHeight) rowHeight = extent.h;
    if (cursorX > widest) widest = cursorX;
  }

  return {
    items,
    width: Math.max(tray.width, widest + gap),
    height: cursorY + rowHeight + gap,
  };
}

/** Full world-space rectangle of a tray, header included. Collapsed trays are header-only. */
export function trayBounds(
  state: PuzzleState,
  tray: Tray,
): { x: number; y: number; w: number; h: number } {
  const { header } = trayMetrics(state);
  if (tray.collapsed) {
    return { x: tray.x, y: tray.y, w: tray.width, h: header };
  }
  const packed = packTray(state, tray);
  return { x: tray.x, y: tray.y, w: packed.width, h: header + packed.height };
}

/** Move every member cluster to its packed slot inside the tray. */
export function applyPacking(state: PuzzleState, tray: Tray): void {
  const { header } = trayMetrics(state);
  const packed = packTray(state, tray);

  for (const item of packed.items) {
    const cluster = state.clusters.get(item.clusterId);
    if (!cluster) continue;
    const origin = clusterOrigin(state, cluster);
    // Where the cluster's top-left currently is in world space...
    const current = toWorld(cluster, origin);
    // ...and where the packing wants it.
    const wantX = tray.x + item.x;
    const wantY = tray.y + header + item.y;
    cluster.x += wantX - current.x;
    cluster.y += wantY - current.y;
  }
}

/** A sensible default tray width: roughly six average pieces across. */
export function defaultTrayWidth(state: PuzzleState): number {
  const cell = Math.min(state.geometry.cellWidth, state.geometry.cellHeight);
  return cell * 6.6;
}

export function createTray(
  state: PuzzleState,
  options: { name?: string; x: number; y: number; clusters?: readonly number[]; width?: number },
): Tray {
  const tray: Tray = {
    id: state.nextTrayId++,
    name: options.name ?? `Tray ${state.trays.size + 1}`,
    x: options.x,
    y: options.y,
    collapsed: false,
    clusters: [],
    width: options.width ?? defaultTrayWidth(state),
  };
  state.trays.set(tray.id, tray);
  if (options.clusters && options.clusters.length > 0) {
    addToTray(state, tray.id, options.clusters);
  }
  return tray;
}

/**
 * Move clusters into a tray.
 *
 * A cluster belongs to at most one tray, so this removes it from any previous one. The
 * tray is repacked afterwards, which is what physically moves the pieces.
 */
export function addToTray(
  state: PuzzleState,
  trayId: number,
  clusterIds: Iterable<number>,
): void {
  const tray = state.trays.get(trayId);
  if (!tray) return;
  const touched = new Set<number>([trayId]);

  for (const clusterId of clusterIds) {
    if (!state.clusters.has(clusterId)) continue;
    const previous = state.trayOfCluster.get(clusterId);
    if (previous === trayId) continue;
    if (previous !== undefined) {
      const old = state.trays.get(previous);
      if (old) {
        old.clusters = old.clusters.filter((id) => id !== clusterId);
        touched.add(previous);
      }
    }
    tray.clusters.push(clusterId);
    state.trayOfCluster.set(clusterId, trayId);
  }

  for (const id of touched) {
    const t = state.trays.get(id);
    if (t) applyPacking(state, t);
  }
}

/** Take clusters out of whatever tray holds them, leaving them where they are. */
export function removeFromTray(state: PuzzleState, clusterIds: Iterable<number>): void {
  const touched = new Set<number>();
  for (const clusterId of clusterIds) {
    const trayId = state.trayOfCluster.get(clusterId);
    if (trayId === undefined) continue;
    const tray = state.trays.get(trayId);
    if (tray) {
      tray.clusters = tray.clusters.filter((id) => id !== clusterId);
      touched.add(trayId);
    }
    state.trayOfCluster.delete(clusterId);
  }
  for (const id of touched) {
    const t = state.trays.get(id);
    if (t) applyPacking(state, t);
  }
}

/** Remove a tray. Its pieces stay on the board where the tray left them. */
export function deleteTray(state: PuzzleState, trayId: number): void {
  const tray = state.trays.get(trayId);
  if (!tray) return;
  if (tray.collapsed) {
    // Contents were hidden; expand first so the pieces reappear where the tray was
    // rather than at whatever stale position they held when it was collapsed.
    tray.collapsed = false;
    applyPacking(state, tray);
  }
  for (const clusterId of tray.clusters) state.trayOfCluster.delete(clusterId);
  state.trays.delete(trayId);
}

export function moveTray(state: PuzzleState, trayId: number, dx: number, dy: number): void {
  const tray = state.trays.get(trayId);
  if (!tray) return;
  tray.x += dx;
  tray.y += dy;
  if (!tray.collapsed) applyPacking(state, tray);
}

export function setTrayCollapsed(state: PuzzleState, trayId: number, collapsed: boolean): void {
  const tray = state.trays.get(trayId);
  if (!tray || tray.collapsed === collapsed) return;
  tray.collapsed = collapsed;
  // Expanding must re-place the pieces: while collapsed they were not being drawn, and
  // the tray may have been dragged somewhere else entirely.
  if (!collapsed) applyPacking(state, tray);
}

export function renameTray(state: PuzzleState, trayId: number, name: string): void {
  const tray = state.trays.get(trayId);
  if (tray) tray.name = name.trim() || tray.name;
}

/** True when this cluster is inside a tray and so should not be drawn or snapped. */
export function isInTray(state: PuzzleState, clusterId: number): boolean {
  return state.trayOfCluster.has(clusterId);
}

/** True when this cluster is inside a *collapsed* tray, and so is not on screen at all. */
export function isHidden(state: PuzzleState, clusterId: number): boolean {
  const trayId = state.trayOfCluster.get(clusterId);
  if (trayId === undefined) return false;
  return state.trays.get(trayId)?.collapsed ?? false;
}

/** The tray whose body contains a world point, topmost last-created first. */
export function trayAt(state: PuzzleState, point: { x: number; y: number }): Tray | null {
  const trays = [...state.trays.values()].reverse();
  for (const tray of trays) {
    const b = trayBounds(state, tray);
    if (point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h) {
      return tray;
    }
  }
  return null;
}

/** True when a world point is on the tray's title bar rather than its contents. */
export function isOnHeader(state: PuzzleState, tray: Tray, point: { x: number; y: number }): boolean {
  const { header } = trayMetrics(state);
  const b = trayBounds(state, tray);
  return (
    point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + header
  );
}

/** Total pieces held, for the tray label. */
export function trayPieceCount(state: PuzzleState, tray: Tray): number {
  let n = 0;
  for (const clusterId of tray.clusters) {
    n += state.clusters.get(clusterId)?.pieces.length ?? 0;
  }
  return n;
}
