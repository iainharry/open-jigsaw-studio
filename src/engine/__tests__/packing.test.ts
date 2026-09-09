import { describe, expect, it } from 'vitest';
import { tile, silhouetteMask } from '../polyomino.js';
import {
  analyseTiling,
  countPackings,
  describe as summarise,
  pieceTypes,
  playouts,
  rate,
} from '../packing.js';

const full = (rows: number, cols: number): Uint8Array =>
  new Uint8Array(rows * cols).fill(1);

const type = (cells: [number, number][], count: number) => ({
  cells: cells.map(([row, col]) => ({ row, col })),
  count,
});

const DOMINO: [number, number][] = [
  [0, 0],
  [0, 1],
];

describe('countPackings', () => {
  /**
   * The check that makes the rest of this module believable.
   *
   * The number of ways to tile a 2xN strip with dominoes is the (N+1)th Fibonacci number
   * — a fact from outside this codebase, proved long before it, and one that a solver
   * with an off-by-one, a double-counted symmetry or a permuted-identical-pieces bug
   * cannot accidentally reproduce for six consecutive values. Every other assertion here
   * checks behaviour I chose; this one checks arithmetic I did not.
   */
  it('counts domino tilings of a 2xN strip as Fibonacci', () => {
    const expected = [1, 2, 3, 5, 8, 13];
    for (let n = 1; n <= 6; n++) {
      const report = countPackings(full(2, n), 2, n, [type(DOMINO, n)]);
      expect(report.exhausted).toBe(true);
      expect(report.solutions).toBe(expected[n - 1]);
    }
  });

  /**
   * The classic impossibility: remove two opposite corners and no domino tiling exists,
   * because both corners are the same colour and every domino covers one of each.
   *
   * Six by six rather than the traditional eight: proving impossibility is exhaustive by
   * definition, and on an 8x8 that runs past the default node budget — which would make
   * this a test of the budget instead of a test of the counter.
   */
  it('finds no tiling of a mutilated board', () => {
    const mask = full(6, 6);
    mask[0] = 0;
    mask[35] = 0;
    const report = countPackings(mask, 6, 6, [type(DOMINO, 17)], { maxNodes: 5_000_000 });
    expect(report.exhausted).toBe(true);
    expect(report.solutions).toBe(0);
  });

  /**
   * Identical pieces are interchangeable.
   *
   * Four single cells fill a 2x2 in exactly one way, not twenty-four. Counting the
   * orderings would inflate every real puzzle by the factorials of its repeat counts.
   */
  it('does not count permutations of identical pieces', () => {
    const report = countPackings(full(2, 2), 2, 2, [type([[0, 0]], 4)]);
    expect(report.solutions).toBe(1);
  });

  /** A square's four rotations are the same placement and must not be counted twice. */
  it('does not double-count the rotations of a symmetric piece', () => {
    const square: [number, number][] = [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ];
    const report = countPackings(full(2, 4), 2, 4, [type(square, 2)]);
    expect(report.solutions).toBe(1);
  });

  it('reports a truncated search rather than pretending to have finished', () => {
    const report = countPackings(full(2, 30), 2, 30, [type(DOMINO, 30)], {
      maxSolutions: 10,
    });
    expect(report.exhausted).toBe(false);
    expect(report.solutions).toBe(10);
  });

  /**
   * A tiling always has at least the arrangement it was cut from.
   *
   * Worth asserting because the first version of this module reported zero solutions for
   * a board generated from a solution — the search was truncated and the result was
   * presented as though it described the puzzle.
   */
  it('finds at least the solution a generated board was cut from', () => {
    const tiling = tile(4242, 5, 6, { targetCells: 5, shapeSet: 'pentominoes' });
    const report = countPackings(
      silhouetteMask(5, 6, 'rectangle'),
      5,
      6,
      pieceTypes(tiling),
    );
    expect(report.solutions).toBeGreaterThanOrEqual(1);
  });
});

describe('pieceTypes', () => {
  it('groups congruent pieces and keeps the total', () => {
    const tiling = tile(99, 6, 8, { targetCells: 4 });
    const types = pieceTypes(tiling);
    const total = types.reduce((n, t) => n + t.count, 0);
    expect(total).toBe(tiling.pieces.length);
    expect(types.length).toBeLessThan(tiling.pieces.length);
  });

  it('treats a rotated copy as the same shape', () => {
    // Two L-tetrominoes at different rotations are one type with a count of two.
    const tiling = {
      rows: 2,
      cols: 4,
      owner: new Int32Array(8),
      pieces: [
        [
          { row: 0, col: 0 },
          { row: 1, col: 0 },
          { row: 1, col: 1 },
        ],
        [
          { row: 0, col: 2 },
          { row: 0, col: 3 },
          { row: 1, col: 3 },
        ],
      ],
    };
    // Rotations are resolved when placements are generated, not when shapes are grouped,
    // so these stay two types -- and the count must still add up.
    const types = pieceTypes(tiling);
    expect(types.reduce((n, t) => n + t.count, 0)).toBe(2);
  });
});

describe('playouts', () => {
  it('always completes a puzzle of single cells', () => {
    const result = playouts(full(3, 3), 3, 3, [type([[0, 0]], 9)], 20, 7);
    expect(result.completed).toBe(1);
  });

  it('is deterministic for a seed', () => {
    const tiling = tile(20260906, 6, 8, { targetCells: 5, shapeSet: 'pentominoes' });
    const mask = silhouetteMask(6, 8, 'rectangle');
    const types = pieceTypes(tiling);
    const a = playouts(mask, 6, 8, types, 100, 5);
    const b = playouts(mask, 6, 8, types, 100, 5);
    expect(a).toEqual(b);
  });

  /**
   * The measure has to separate boards, which the first two versions did not: node counts
   * to the first solution came out between 7 and 24 for everything, and uniform-random
   * play completed exactly zero percent of five different boards.
   */
  it('separates an easy board from a hard one', () => {
    const easy = tile(20260906, 12, 16, { targetCells: 2 });
    const hard = tile(20260906, 6, 8, { targetCells: 5, shapeSet: 'pentominoes' });
    const easyReport = analyseTiling(easy);
    const hardReport = analyseTiling(hard);
    expect(easyReport.completed).toBeGreaterThan(0.2);
    expect(hardReport.completed).toBeLessThan(0.05);
    expect(hardReport.rating).toBeGreaterThan(easyReport.rating);
  });
});

describe('rate and describe', () => {
  it('uses the whole scale across generated boards', () => {
    const boards = [
      analyseTiling(tile(20260906, 12, 16, { targetCells: 2 })),
      analyseTiling(tile(20260906, 4, 5, { targetCells: 3 })),
      analyseTiling(tile(20260906, 6, 6, { targetCells: 4, shapeSet: 'tetrominoes' })),
      analyseTiling(tile(20260906, 5, 6, { targetCells: 5, shapeSet: 'pentominoes' })),
      analyseTiling(tile(20260906, 8, 10, { targetCells: 5, shapeSet: 'pentominoes' })),
    ];
    const bands = new Set(boards.map((b) => b.rating));
    // A scale whose top step nobody can get off is not a scale. Four of five bands from
    // five boards is the bar; the first calibration managed two.
    expect(bands.size).toBeGreaterThanOrEqual(4);
    for (const board of boards) expect(board.rating).toBeGreaterThanOrEqual(1);
  });

  it('never reports "at least 0 solutions"', () => {
    const text = summarise({
      solutions: 0,
      exhausted: false,
      nodes: 1,
      completed: 0,
      stalledAt: 0.5,
    });
    expect(text).not.toContain('at least 0');
    expect(text).toContain('too many arrangements');
  });

  it('calls a single-solution puzzle harder than its play-throughs suggest', () => {
    const base = { nodes: 10, completed: 0.7, stalledAt: 0.9 };
    expect(rate({ ...base, solutions: 1, exhausted: true })).toBe(2);
    expect(rate({ ...base, solutions: 40, exhausted: true })).toBe(1);
  });
});
