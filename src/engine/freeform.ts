/**
 * Free-form solving: any arrangement that fills the frame counts.
 *
 * The ordinary puzzle has exactly one solution, because snapping asks "is my neighbour
 * where it should be relative to me" — it is keyed to *identity*. A pentomino puzzle asks
 * something different: does this shape fit in that hole. Two consequences follow, and
 * both are forced rather than chosen.
 *
 * **Pieces do not merge.** Two pieces sitting side by side in your arrangement are not
 * connected in any meaningful sense — you may well pull one out again. Merging them into
 * a cluster would fight the puzzle: it would glue together an arrangement you are still
 * experimenting with. So in this mode a piece stays its own cluster for the whole game,
 * and "progress" is how much of the board is covered rather than how much is joined.
 *
 * **Edges must be flat.** A tab is complementary to exactly one neighbouring socket, in
 * exactly one arrangement. Put the piece somewhere else and the tabs collide. Free-form
 * therefore only makes sense with straight cuts, and the app enforces that rather than
 * letting someone select a combination that cannot work.
 *
 * The placement maths leans on a property the flat cut already guarantees and already has
 * a test for: a flat piece's bounding box is exactly its cell rectangle. So a placement
 * can be read off the piece's world bounding box — round its top-left to the nearest cell
 * — with no pivot arithmetic at all. Rotation stays axis-aligned under quarter turns, so
 * the same trick survives turning pieces.
 */

import { clusterWorldBounds, type PuzzleState } from './puzzle.js';
import { translate } from './clusters.js';
import { silhouetteMask, type Cell, type Silhouette } from './polyomino.js';

/**
 * Which cells are part of the puzzle.
 *
 * A silhouette makes most of the bounding rectangle not part of the board at all, and
 * free-form has to know: a piece must not be placeable in the empty corner outside a
 * diamond, and coverage must be measured against the outline rather than the rectangle,
 * or a diamond puzzle could never read as finished.
 */
export function boardMask(state: PuzzleState): Uint8Array {
  const { rows, cols } = state.geometry;
  const shape = (state.geometry.polyominoOptions?.['silhouette'] ?? 'rectangle') as Silhouette;
  return silhouetteMask(rows, cols, shape);
}

export interface Placement {
  readonly row: number;
  readonly col: number;
  /** Quarter turns clockwise, 0-3. */
  readonly turns: number;
}

/** Rotate a cell set by quarter turns and normalise it back to the origin. */
export function rotateCells(cells: readonly Cell[], turns: number): Cell[] {
  let out = cells.map((c) => ({ row: c.row, col: c.col }));
  for (let i = 0; i < (((turns % 4) + 4) % 4); i++) {
    out = out.map((c) => ({ row: c.col, col: -c.row }));
  }
  const minR = Math.min(...out.map((c) => c.row));
  const minC = Math.min(...out.map((c) => c.col));
  return out
    .map((c) => ({ row: c.row - minR, col: c.col - minC }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

/** Quarter turns a cluster is currently at, from its rotation in radians. */
export function turnsOf(rotation: number): number {
  const quarter = Math.round(rotation / (Math.PI / 2));
  return ((quarter % 4) + 4) % 4;
}

/** The cells a piece would occupy at a placement. */
export function cellsAt(cells: readonly Cell[], placement: Placement): Cell[] {
  return rotateCells(cells, placement.turns).map((c) => ({
    row: c.row + placement.row,
    col: c.col + placement.col,
  }));
}

/**
 * Where a cluster is sitting, if it is sitting on the board at all.
 *
 * Returns null for a piece still loose in the scatter, which is not an error — it is the
 * normal state of most pieces for most of the game.
 */
export function placementOf(
  state: PuzzleState,
  clusterId: number,
  tolerance = 0.25,
): Placement | null {
  const cluster = state.clusters.get(clusterId);
  const bounds = clusterWorldBounds(state, clusterId);
  if (!cluster || !bounds) return null;

  const { cellWidth, cellHeight, rows, cols } = state.geometry;
  const col = bounds.minX / cellWidth;
  const row = bounds.minY / cellHeight;
  const nearestCol = Math.round(col);
  const nearestRow = Math.round(row);
  if (Math.abs(col - nearestCol) > tolerance || Math.abs(row - nearestRow) > tolerance) {
    return null;
  }
  if (nearestRow < 0 || nearestCol < 0 || nearestRow >= rows || nearestCol >= cols) return null;

  return { row: nearestRow, col: nearestCol, turns: turnsOf(cluster.rotation) };
}

/**
 * Which piece occupies each cell. -1 for empty.
 *
 * Derived from where pieces actually are rather than tracked alongside them, so it cannot
 * drift out of step with the board — the same reasoning that keeps geometry derived from
 * the seed rather than stored.
 */
export function occupancy(state: PuzzleState, ignore?: number): Int32Array {
  const { rows, cols } = state.geometry;
  const grid = new Int32Array(rows * cols).fill(-1);

  for (const cluster of state.clusters.values()) {
    if (cluster.id === ignore) continue;
    const placement = placementOf(state, cluster.id);
    if (!placement) continue;
    const piece = state.geometry.pieces[cluster.pieces[0]!];
    if (!piece) continue;
    for (const cell of cellsAt(piece.cells, placement)) {
      if (cell.row < 0 || cell.col < 0 || cell.row >= rows || cell.col >= cols) continue;
      grid[cell.row * cols + cell.col] = cluster.id;
    }
  }
  return grid;
}

/** Would this placement sit entirely on free board? */
export function isLegal(
  state: PuzzleState,
  clusterId: number,
  placement: Placement,
  grid?: Int32Array,
): boolean {
  const { rows, cols } = state.geometry;
  const cluster = state.clusters.get(clusterId);
  if (!cluster) return false;
  const piece = state.geometry.pieces[cluster.pieces[0]!];
  if (!piece) return false;

  const occupied = grid ?? occupancy(state, clusterId);
  const mask = boardMask(state);
  for (const cell of cellsAt(piece.cells, placement)) {
    if (cell.row < 0 || cell.col < 0 || cell.row >= rows || cell.col >= cols) return false;
    if (mask[cell.row * cols + cell.col] === 0) return false;
    const holder = occupied[cell.row * cols + cell.col]!;
    if (holder !== -1 && holder !== clusterId) return false;
  }
  return true;
}

/**
 * The placement a released piece should fall into, or null to leave it where it is.
 *
 * Only the nearest cell is considered, plus the eight around it. Searching the whole
 * board would let a piece dropped in the scatter leap across the screen into a hole it
 * happens to fit, which is not a snap — it is the app playing for you.
 */
export function findBoardSnap(
  state: PuzzleState,
  clusterId: number,
  toleranceCells = 0.5,
): Placement | null {
  const cluster = state.clusters.get(clusterId);
  const bounds = clusterWorldBounds(state, clusterId);
  if (!cluster || !bounds) return null;

  const { cellWidth, cellHeight } = state.geometry;
  const col = bounds.minX / cellWidth;
  const row = bounds.minY / cellHeight;
  const turns = turnsOf(cluster.rotation);
  const grid = occupancy(state, clusterId);

  let best: Placement | null = null;
  let bestDist = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const candidate = {
        row: Math.round(row) + dr,
        col: Math.round(col) + dc,
        turns,
      };
      const dist = Math.hypot(candidate.col - col, candidate.row - row);
      if (dist > toleranceCells) continue;
      if (!isLegal(state, clusterId, candidate, grid)) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
  }
  return best;
}

/** Move a cluster so it sits exactly at a placement. */
export function applyPlacement(state: PuzzleState, clusterId: number, placement: Placement): void {
  const bounds = clusterWorldBounds(state, clusterId);
  if (!bounds) return;
  const { cellWidth, cellHeight } = state.geometry;
  translate(
    state.clusters.get(clusterId)!,
    placement.col * cellWidth - bounds.minX,
    placement.row * cellHeight - bounds.minY,
  );
}

/** Fraction of the board covered. The free-form answer to "how far along am I". */
export function coverage(state: PuzzleState): number {
  const grid = occupancy(state);
  const mask = boardMask(state);
  let filled = 0;
  let total = 0;
  for (let i = 0; i < grid.length; i++) {
    if (mask[i] === 0) continue;
    total++;
    if (grid[i] !== -1) filled++;
  }
  return total === 0 ? 0 : filled / total;
}

/**
 * Complete when the frame is full.
 *
 * Note what is *not* required: that pieces are where they were cut from. That is the
 * whole point — any arrangement filling the rectangle is a solution, and there are
 * usually a great many.
 */
export function isBoardFull(state: PuzzleState): boolean {
  return coverage(state) >= 1;
}
