import { describe, expect, it } from 'vitest';
import {
  SHAPES,
  generatePolyominoGeometry,
  rotations,
  tile,
  tilingStats,
} from '../polyomino.js';
import { deserialize, serialize } from '../serialize.js';
import { mergeClusters, stateFromGeometry } from '../puzzle.js';
import { DEFAULT_SETTINGS } from '../types.js';

describe('rotations', () => {
  it('gives one form for a square and four for an L', () => {
    const square = SHAPES.find((s) => s.name === 'O')!;
    const ell = SHAPES.find((s) => s.name === 'L')!;
    expect(rotations(square)).toHaveLength(1);
    expect(rotations(ell)).toHaveLength(4);
  });

  it('gives two for a bar, which is symmetric under a half turn', () => {
    expect(rotations(SHAPES.find((s) => s.name === 'I')!)).toHaveLength(2);
  });

  it('keeps the cell count', () => {
    for (const shape of SHAPES) {
      for (const form of rotations(shape)) expect(form).toHaveLength(shape.cells.length);
    }
  });

  it('normalises every form to the origin', () => {
    for (const shape of SHAPES) {
      for (const form of rotations(shape)) {
        expect(Math.min(...form.map((c) => c.row))).toBe(0);
        expect(Math.min(...form.map((c) => c.col))).toBe(0);
      }
    }
  });
});

describe('tile', () => {
  it('covers every cell exactly once', () => {
    const t = tile(1234, 9, 11);
    expect([...t.owner].every((o) => o >= 0)).toBe(true);
    const counted = t.pieces.reduce((n, cells) => n + cells.length, 0);
    expect(counted).toBe(9 * 11);
  });

  it('never lets two pieces claim the same cell', () => {
    const t = tile(99, 8, 8);
    const seen = new Set<string>();
    for (const cells of t.pieces) {
      for (const cell of cells) {
        const k = `${cell.row},${cell.col}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it('keeps every cell inside the grid', () => {
    const t = tile(7, 6, 10);
    for (const cells of t.pieces) {
      for (const cell of cells) {
        expect(cell.row).toBeGreaterThanOrEqual(0);
        expect(cell.col).toBeGreaterThanOrEqual(0);
        expect(cell.row).toBeLessThan(6);
        expect(cell.col).toBeLessThan(10);
      }
    }
  });

  it('is deterministic for a seed and varies between seeds', () => {
    const a = tile(42, 7, 7);
    const b = tile(42, 7, 7);
    const c = tile(43, 7, 7);
    expect(a.pieces).toEqual(b.pieces);
    expect(a.pieces).not.toEqual(c.pieces);
  });

  it('the owner map agrees with the piece lists', () => {
    const t = tile(5, 8, 9);
    for (const [index, cells] of t.pieces.entries()) {
      for (const cell of cells) expect(t.owner[cell.row * t.cols + cell.col]).toBe(index);
    }
  });

  it('mostly produces real shapes rather than scraps', () => {
    // Greedy placement cannot fail, but it can degrade into a field of single cells --
    // which would be a grid puzzle wearing a polyomino's name. This is the guard.
    for (const seed of [1, 2, 3, 17, 250]) {
      const stats = tilingStats(tile(seed, 12, 16));
      expect(stats.chunky).toBeGreaterThan(0.9);
      expect(stats.meanCells).toBeGreaterThan(2.5);
    }
  });

  it('leaves almost no single-cell scraps, at any size', () => {
    // The assertion that was missing. An earlier version passed a "chunky > 75%" check
    // while asking for five-cell pieces produced fifteen dropped single squares out of
    // forty-eight -- the big shapes fitted first and stranded cells behind them. A
    // fraction-of-cells measure hides that, because fifteen strays out of a hundred and
    // sixty cells is still 91% chunky. Count the scraps directly.
    for (const target of [2, 3, 4, 5]) {
      for (const seed of [1, 8, 99]) {
        const stats = tilingStats(tile(seed, 10, 16, { targetCells: target }));
        expect(stats.singles / stats.pieces).toBeLessThan(0.06);
      }
    }
  });

  it('the size dial makes pieces bigger, not just different', () => {
    const sizes = [2, 3, 4, 5].map((t) => tilingStats(tile(8, 12, 12, { targetCells: t })));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]!.meanCells).toBeGreaterThan(sizes[i - 1]!.meanCells);
      expect(sizes[i]!.pieces).toBeLessThan(sizes[i - 1]!.pieces);
    }
  });

  it('copes with a grid one cell wide', () => {
    const t = tile(3, 7, 1);
    expect([...t.owner].every((o) => o >= 0)).toBe(true);
  });

  it('copes with a single cell', () => {
    const t = tile(3, 1, 1);
    expect(t.pieces).toHaveLength(1);
    expect(t.pieces[0]).toHaveLength(1);
  });
});

describe('generatePolyominoGeometry', () => {
  const geo = (over = {}) => generatePolyominoGeometry(2026, 8, 10, 1600, 1200, over);

  it('produces one piece per tile with a closed outline', () => {
    const g = geo();
    expect(g.pieces.length).toBeGreaterThan(0);
    for (const piece of g.pieces) {
      expect(piece.outline[0]!.kind).toBe('move');
      expect(piece.outline[piece.outline.length - 1]!.kind).toBe('close');
      expect(piece.outline.length).toBeGreaterThan(2);
    }
  });

  it('the outline returns to where it started', () => {
    const g = geo({ flatEdges: true });
    for (const piece of g.pieces) {
      const start = piece.outline[0] as { to: { x: number; y: number } };
      const last = piece.outline[piece.outline.length - 2] as { to: { x: number; y: number } };
      expect(last.to.x).toBeCloseTo(start.to.x, 6);
      expect(last.to.y).toBeCloseTo(start.to.y, 6);
    }
  });

  it('every cell of the picture is covered exactly once', () => {
    const g = geo();
    const total = g.pieces.reduce((n, p) => n + p.cells.length, 0);
    expect(total).toBe(g.rows * g.cols);
  });

  it('adjacency is symmetric', () => {
    const g = geo();
    for (const piece of g.pieces) {
      for (const other of piece.adjacent) {
        expect(g.pieces[other]!.adjacent).toContain(piece.id);
      }
    }
  });

  it('no piece claims itself as a neighbour', () => {
    const g = geo();
    for (const piece of g.pieces) expect(piece.adjacent).not.toContain(piece.id);
  });

  it('marks exactly the pieces touching the outside as border pieces', () => {
    const g = geo();
    for (const piece of g.pieces) {
      const touches = piece.cells.some(
        (c) => c.row === 0 || c.col === 0 || c.row === g.rows - 1 || c.col === g.cols - 1,
      );
      expect(piece.isBorder).toBe(touches);
    }
  });

  it('bounds contain the whole outline', () => {
    const g = geo();
    for (const piece of g.pieces) {
      for (const cmd of piece.outline) {
        if (cmd.kind === 'close') continue;
        const pts = cmd.kind === 'move' ? [cmd.to] : [cmd.c1, cmd.c2, cmd.to];
        for (const p of pts) {
          expect(p.x).toBeGreaterThanOrEqual(-1e-6);
          expect(p.y).toBeGreaterThanOrEqual(-1e-6);
          expect(p.x).toBeLessThanOrEqual(piece.bounds.w + 1e-6);
          expect(p.y).toBeLessThanOrEqual(piece.bounds.h + 1e-6);
        }
      }
    }
  });

  it('flat edges have no tab overhang, so pieces tile their cells exactly', () => {
    const g = generatePolyominoGeometry(11, 6, 8, 800, 600, { flatEdges: true });
    const cellW = 800 / 8;
    const cellH = 600 / 6;
    for (const piece of g.pieces) {
      const minCol = Math.min(...piece.cells.map((c) => c.col));
      const minRow = Math.min(...piece.cells.map((c) => c.row));
      expect(piece.bounds.x).toBeCloseTo(minCol * cellW, 6);
      expect(piece.bounds.y).toBeCloseTo(minRow * cellH, 6);
    }
  });

  it('tabbed edges do overhang, which is what makes them interlock', () => {
    const flat = generatePolyominoGeometry(11, 6, 8, 800, 600, { flatEdges: true });
    const tabbed = generatePolyominoGeometry(11, 6, 8, 800, 600, { flatEdges: false });
    const area = (g: typeof flat): number =>
      g.pieces.reduce((n, p) => n + p.bounds.w * p.bounds.h, 0);
    expect(area(tabbed)).toBeGreaterThan(area(flat));
  });

  it('the border of the picture is never tabbed', () => {
    // A tab sticking out past the edge of the photograph would have nothing behind it.
    const g = generatePolyominoGeometry(4, 5, 7, 700, 500, {});
    for (const piece of g.pieces) {
      const onLeft = piece.cells.some((c) => c.col === 0);
      if (onLeft) expect(piece.bounds.x).toBeGreaterThanOrEqual(-1e-6);
    }
    const minX = Math.min(...g.pieces.map((p) => p.bounds.x));
    expect(minX).toBeCloseTo(0, 6);
  });

  it('is deterministic for a seed', () => {
    expect(geo()).toEqual(generatePolyominoGeometry(2026, 8, 10, 1600, 1200, {}));
  });

  it('survives a save and reload with the same pieces', () => {
    // Geometry is regenerated rather than stored, so the save has to name the cut and
    // its options. Getting this wrong would reload a polyomino puzzle as a classic grid
    // and put every cluster on a piece that no longer exists.
    const state = stateFromGeometry(
      generatePolyominoGeometry(77, 6, 8, 800, 600, { targetCells: 5, flatEdges: true }),
      DEFAULT_SETTINGS,
    );
    const ids = [...state.clusters.keys()];
    mergeClusters(state, ids[0]!, ids[1]!);

    const back = deserialize(serialize(state, {}, null)).state;
    expect(back.geometry.cut).toBe('polyomino');
    expect(back.geometry.pieces).toHaveLength(state.geometry.pieces.length);
    expect(back.clusters.size).toBe(state.clusters.size);
    for (const [i, piece] of back.geometry.pieces.entries()) {
      expect(piece.cells).toEqual(state.geometry.pieces[i]!.cells);
      expect(piece.adjacent).toEqual(state.geometry.pieces[i]!.adjacent);
    }
  });

  it('a classic save still reloads as classic', () => {
    const state = stateFromGeometry(
      generatePolyominoGeometry(1, 4, 4, 400, 400, {}),
      DEFAULT_SETTINGS,
    );
    const saved = serialize(state, {}, null);
    // Older saves carry no `cut` at all; those must still take the classic path.
    delete (saved.puzzle as { cut?: unknown }).cut;
    expect(deserialize(saved).state.geometry.cut).not.toBe('polyomino');
  });

  it('drops straight into the existing puzzle state', () => {
    // The point of the whole exercise: nothing downstream needs to know about the cut.
    const state = stateFromGeometry(geo(), DEFAULT_SETTINGS);
    expect(state.clusters.size).toBe(state.geometry.pieces.length);
    expect(state.clusterOfPiece.length).toBe(state.geometry.pieces.length);
  });
});
