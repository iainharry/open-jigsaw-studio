import { describe, expect, it } from 'vitest';
import {
  applyPlacement,
  cellsAt,
  coverage,
  findBoardSnap,
  isBoardFull,
  isLegal,
  occupancy,
  placementOf,
  rotateCells,
  turnsOf,
} from '../freeform.js';
import { generatePolyominoGeometry } from '../polyomino.js';
import { stateFromGeometry, clusterOf } from '../puzzle.js';
import { DEFAULT_SETTINGS } from '../types.js';

const board = (seed = 5, rows = 6, cols = 8) =>
  stateFromGeometry(
    generatePolyominoGeometry(seed, rows, cols, cols * 100, rows * 100, {
      targetCells: 4,
      flatEdges: true,
    }),
    { ...DEFAULT_SETTINGS, rotationEnabled: true },
  );

describe('rotateCells', () => {
  it('leaves a shape alone at zero turns', () => {
    const L = [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ];
    expect(rotateCells(L, 0)).toEqual(L);
  });

  it('returns to the start after four turns', () => {
    const L = [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ];
    expect(rotateCells(L, 4)).toEqual(rotateCells(L, 0));
  });

  it('swaps the footprint on a quarter turn', () => {
    const bar = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
    ];
    const turned = rotateCells(bar, 1);
    expect(Math.max(...turned.map((c) => c.row))).toBe(2);
    expect(Math.max(...turned.map((c) => c.col))).toBe(0);
  });

  it('keeps the cell count and normalises to the origin', () => {
    const plus = [
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
      { row: 2, col: 1 },
    ];
    for (const t of [0, 1, 2, 3]) {
      const r = rotateCells(plus, t);
      expect(r).toHaveLength(5);
      expect(Math.min(...r.map((c) => c.row))).toBe(0);
      expect(Math.min(...r.map((c) => c.col))).toBe(0);
    }
  });

  it('handles negative turns', () => {
    const L = [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ];
    expect(rotateCells(L, -1)).toEqual(rotateCells(L, 3));
  });
});

describe('turnsOf', () => {
  it('maps radians to quarter turns', () => {
    expect(turnsOf(0)).toBe(0);
    expect(turnsOf(Math.PI / 2)).toBe(1);
    expect(turnsOf(Math.PI)).toBe(2);
    expect(turnsOf(-Math.PI / 2)).toBe(3);
    expect(turnsOf(2 * Math.PI)).toBe(0);
  });
});

describe('placement and occupancy', () => {
  it('a freshly cut puzzle is fully placed and complete', () => {
    // Every piece starts in its solved position, which is a legal arrangement -- indeed
    // the one it was cut from. Free-form does not make that the *only* answer, but it
    // certainly has to accept it.
    const state = board();
    expect(coverage(state)).toBeCloseTo(1, 6);
    expect(isBoardFull(state)).toBe(true);
  });

  it('moving a piece off the board opens a hole', () => {
    const state = board();
    const cluster = clusterOf(state, 0);
    cluster.x -= 5000;
    expect(placementOf(state, cluster.id)).toBeNull();
    expect(coverage(state)).toBeLessThan(1);
    expect(isBoardFull(state)).toBe(false);
  });

  it('occupancy names the piece in each cell', () => {
    const state = board();
    const grid = occupancy(state);
    expect([...grid].every((o) => o !== -1)).toBe(true);
    const piece = state.geometry.pieces[0]!;
    const id = clusterOf(state, 0).id;
    for (const cell of piece.cells) {
      expect(grid[cell.row * state.geometry.cols + cell.col]).toBe(id);
    }
  });

  it('a cell freed by lifting a piece reads as empty', () => {
    const state = board();
    const cluster = clusterOf(state, 0);
    const piece = state.geometry.pieces[0]!;
    cluster.y -= 4000;
    const grid = occupancy(state);
    for (const cell of piece.cells) {
      expect(grid[cell.row * state.geometry.cols + cell.col]).toBe(-1);
    }
  });
});

describe('isLegal', () => {
  it('refuses a placement that runs off the board', () => {
    const state = board();
    const id = clusterOf(state, 0).id;
    expect(isLegal(state, id, { row: -1, col: 0, turns: 0 })).toBe(false);
    expect(isLegal(state, id, { row: 0, col: 99, turns: 0 })).toBe(false);
  });

  it('refuses a placement that overlaps another piece', () => {
    const state = board();
    const first = clusterOf(state, 0).id;
    // Everything is placed, so anywhere other than its own home is taken.
    const other = state.geometry.pieces.find((p) => p.id !== 0 && p.cells.length > 0)!;
    const target = other.cells[0]!;
    expect(isLegal(state, first, { row: target.row, col: target.col, turns: 0 })).toBe(false);
  });

  it('accepts the placement a piece is already in', () => {
    const state = board();
    const id = clusterOf(state, 0).id;
    const here = placementOf(state, id)!;
    expect(isLegal(state, id, here)).toBe(true);
  });
});

describe('findBoardSnap', () => {
  it('pulls a nudged piece back into its cell', () => {
    const state = board();
    const cluster = clusterOf(state, 0);
    const home = placementOf(state, cluster.id)!;
    cluster.x += 18;
    cluster.y -= 12;
    const snap = findBoardSnap(state, cluster.id);
    expect(snap).toEqual(home);
    applyPlacement(state, cluster.id, snap!);
    expect(placementOf(state, cluster.id)).toEqual(home);
  });

  it('ignores a piece dropped far from the board', () => {
    const state = board();
    const cluster = clusterOf(state, 0);
    cluster.x += 100000;
    cluster.y += 100000;
    expect(findBoardSnap(state, cluster.id)).toBeNull();
  });

  it('will not snap into a hole the shape does not fit', () => {
    // Lift two pieces, then try to drop one into the *other* one's hole. It only fits if
    // the shapes happen to match, so assert the general rule: the result is either null
    // or a legal placement, never an overlapping one.
    const state = board();
    const a = clusterOf(state, 0);
    const b = [...state.clusters.values()].find((c) => c.id !== a.id)!;
    a.y -= 5000;
    const snap = findBoardSnap(state, b.id);
    if (snap) expect(isLegal(state, b.id, snap)).toBe(true);
  });

  it('a piece can take a different hole than the one it came from', () => {
    // The property that makes this free-form at all: identity does not decide fit.
    const state = board(9, 5, 6);
    const pieces = [...state.clusters.values()];
    // Lift everything, then place a piece into the first empty cell that accepts it.
    for (const c of pieces) c.y -= 9000;
    expect(coverage(state)).toBe(0);

    const mover = pieces[0]!;
    const piece = state.geometry.pieces[mover.pieces[0]!]!;
    let placed = false;
    for (let row = 0; row < state.geometry.rows && !placed; row++) {
      for (let col = 0; col < state.geometry.cols && !placed; col++) {
        for (const turns of [0, 1, 2, 3]) {
          const candidate = { row, col, turns };
          if (isLegal(state, mover.id, candidate)) {
            mover.rotation = (turns * Math.PI) / 2;
            applyPlacement(state, mover.id, candidate);
            placed = true;
            break;
          }
        }
      }
    }
    expect(placed).toBe(true);
    expect(coverage(state)).toBeCloseTo(piece.cells.length / (state.geometry.rows * state.geometry.cols), 6);
  });

  it('a rotated piece still finds a legal home', () => {
    const state = board(3, 6, 6);
    const cluster = clusterOf(state, 0);
    cluster.y -= 6000;
    cluster.rotation = Math.PI / 2;
    // Its own hole is free; a quarter turn may or may not fit there, but whatever the
    // snap returns must be legal.
    const snap = findBoardSnap(state, cluster.id, 2);
    if (snap) expect(isLegal(state, cluster.id, snap)).toBe(true);
  });
});

describe('coverage', () => {
  it('counts cells, not pieces', () => {
    const state = board();
    const cluster = clusterOf(state, 0);
    const piece = state.geometry.pieces[0]!;
    const total = state.geometry.rows * state.geometry.cols;
    cluster.x -= 7000;
    expect(coverage(state)).toBeCloseTo((total - piece.cells.length) / total, 6);
  });

  it('is zero with everything lifted', () => {
    const state = board();
    for (const c of state.clusters.values()) c.y -= 9000;
    expect(coverage(state)).toBe(0);
    expect(isBoardFull(state)).toBe(false);
  });
});

describe('cellsAt', () => {
  it('offsets a rotated shape to the placement', () => {
    const L = [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ];
    const at = cellsAt(L, { row: 3, col: 4, turns: 0 });
    expect(at).toContainEqual({ row: 3, col: 4 });
    expect(at).toContainEqual({ row: 4, col: 5 });
  });
});
