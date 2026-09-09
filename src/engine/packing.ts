/**
 * How hard is a shape puzzle, actually?
 *
 * Until now "difficulty" was a star rating the player typed in afterwards. That is a
 * record of how it felt, worth keeping, but it cannot be shown *before* you start and it
 * cannot be compared between two people. For a classroom that is the whole problem: a
 * teacher handing the same puzzle to thirty students wants to know in advance whether it
 * is a five-minute warm-up or a fortnight of lunchtimes.
 *
 * Piece count is the obvious proxy and it is a bad one. A hundred-piece rectangle of
 * squares is trivial; a twelve-piece diamond of pentominoes can be brutal. What makes a
 * packing puzzle hard is how much of it is dead end — how far you get down a
 * plausible-looking arrangement before it fails.
 *
 * **The measure that did not work, and why it is worth recording.** The first version
 * counted search nodes before an exhaustive solver found its first solution. It looked
 * principled and it measured almost nothing. Across eight generated boards the answer was
 * 7, 8, 11, 12, 13 and 24 nodes — because the solver fills cells in reading order and the
 * *generator* also fills cells in reading order, so the solver walks more or less
 * straight back into the arrangement the board was cut from. It was measuring the
 * agreement between two pieces of my own code. Worse, on an 8x10 pentomino board it
 * found no solution at all inside four hundred thousand nodes, and reported a puzzle
 * known to be solvable — it was cut from a solution — as unjudgeable.
 *
 * **What replaced it.** Play the puzzle badly, many times, and see how often that works.
 * Each trial fills the lowest empty cell with a legal placement chosen at random and
 * keeps going until the board is full or nothing fits. That models the naive player
 * exactly: someone putting pieces where they happen to go, with no lookahead. The
 * fraction of trials that finish is a direct statement about the puzzle rather than about
 * the solver, it degrades gracefully on large boards where exhaustive search cannot go,
 * and it is bounded — a few hundred trials of a few dozen moves.
 *
 * The exact solution count is kept as a second, smaller fact: it is genuinely
 * interesting when the space is small enough to exhaust, and honestly reported as "at
 * least N" when it is not. It never gets rounded up into a number that looks exact.
 *
 * Two deliberate limits.
 *
 * **Rotations only, no reflections.** Not a simplification — the app lets you turn a
 * piece and not flip it, so counting reflected placements would count solutions the
 * player cannot reach. The measure has to describe the game as played.
 *
 * **Everything is seeded.** Two people opening the same challenge link must see the same
 * difficulty, or the number is worse than no number.
 *
 * Headless, like the rest of `src/engine`: arithmetic over cell indices, tested in Node
 * with no canvas anywhere near it.
 */

import { makeRng } from './rng.js';
import { rotations, silhouetteMask, type Cell, type Silhouette, type Tiling } from './polyomino.js';

/** One shape and how many copies of it the puzzle contains. */
export interface PieceType {
  /** Normalised cells, minimum row and col both zero. */
  readonly cells: readonly Cell[];
  readonly count: number;
}

export interface SolutionCount {
  /** Solutions found. A floor, not a total, unless `exhausted`. */
  readonly solutions: number;
  /** True when the whole space was searched: `solutions` is then exact. */
  readonly exhausted: boolean;
  /** Placements tried. Reported so a slow board can be recognised as slow. */
  readonly nodes: number;
}

export interface PackingReport extends SolutionCount, Playouts {
  /** How many trials the play-through figures came from. Small samples stay visible. */
  readonly trials: number;
  /** 1 (gentle) to 5 (punishing). */
  readonly rating: number;
  /** A phrase for the interface. Never claims precision the search did not earn. */
  readonly summary: string;
}

export interface PackingLimits {
  /** Stop counting at this many solutions. */
  readonly maxSolutions?: number;
  /** Stop searching after this many placements. */
  readonly maxNodes?: number;
  /** Random play-throughs used to estimate forgiveness. */
  readonly trials?: number;
  readonly seed?: number;
}

const DEFAULT_LIMITS: Required<PackingLimits> = {
  maxSolutions: 2000,
  maxNodes: 250_000,
  trials: 300,
  seed: 1,
};

function normalise(cells: readonly Cell[]): Cell[] {
  const minR = Math.min(...cells.map((c) => c.row));
  const minC = Math.min(...cells.map((c) => c.col));
  return cells
    .map((c) => ({ row: c.row - minR, col: c.col - minC }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

function shapeKey(cells: readonly Cell[]): string {
  return normalise(cells)
    .map((c) => `${c.row},${c.col}`)
    .join(' ');
}

/**
 * Group a tiling's pieces into shapes and counts.
 *
 * Identical shapes are interchangeable — swapping two L's produces the same picture, not
 * a second solution — so the solver treats them as one type with a multiplicity. Counting
 * them separately would multiply every solution by the factorials of the repeat counts,
 * which for twenty pieces is a number with no meaning at all.
 */
export function pieceTypes(tiling: Tiling): PieceType[] {
  const byKey = new Map<string, { cells: Cell[]; count: number }>();
  for (const cells of tiling.pieces) {
    const key = shapeKey(cells);
    const existing = byKey.get(key);
    if (existing) existing.count++;
    else byKey.set(key, { cells: normalise(cells), count: 1 });
  }
  // Largest first: big pieces are the most constrained, so placing them early prunes
  // hardest. Ordering does not change the solution count, only the work to reach it.
  return [...byKey.values()].sort((a, b) => b.cells.length - a.cells.length);
}

/**
 * Every legal placement, grouped by the lowest cell index it covers.
 *
 * Both the counter and the play-throughs fill the lowest empty cell, so only placements
 * whose own lowest cell is that cell can ever be legal — everything before it is already
 * covered. Grouping them once up front turns the inner loop from a filter over all
 * placements into a short list lookup, and both consumers get it for free.
 */
function placementIndex(
  mask: Uint8Array,
  rows: number,
  cols: number,
  types: readonly PieceType[],
): { buckets: number[][][]; cellsOf: number[][] } {
  const size = rows * cols;
  const buckets: number[][][] = Array.from({ length: size }, () => types.map(() => []));
  const cellsOf: number[][] = [];

  types.forEach((type, typeIndex) => {
    const seen = new Set<string>();
    for (const form of rotations({ name: '', cells: type.cells })) {
      const height = Math.max(...form.map((c) => c.row)) + 1;
      const width = Math.max(...form.map((c) => c.col)) + 1;
      for (let r = 0; r + height <= rows; r++) {
        for (let c = 0; c + width <= cols; c++) {
          const indices: number[] = [];
          let fits = true;
          for (const cell of form) {
            const index = (cell.row + r) * cols + cell.col + c;
            if (mask[index] === 0) {
              fits = false;
              break;
            }
            indices.push(index);
          }
          if (!fits) continue;
          indices.sort((a, b) => a - b);
          // A shape with a symmetry produces the same placement from two of its
          // rotations. Keeping both would double-count every solution using it.
          const key = indices.join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          const id = cellsOf.length;
          cellsOf.push(indices);
          buckets[indices[0]!]![typeIndex]!.push(id);
        }
      }
    }
  });

  return { buckets, cellsOf };
}

/**
 * Count the ways a set of shapes fills an outline.
 *
 * Always filling the lowest-numbered empty cell is what makes this a count of
 * arrangements rather than of orderings: each cell is covered by exactly one decision, so
 * every arrangement is reached down exactly one path and no solution is counted twice.
 */
export function countPackings(
  mask: Uint8Array,
  rows: number,
  cols: number,
  types: readonly PieceType[],
  limits: PackingLimits = {},
): SolutionCount {
  const { maxSolutions, maxNodes } = { ...DEFAULT_LIMITS, ...limits };
  const size = rows * cols;
  const { buckets, cellsOf } = placementIndex(mask, rows, cols, types);

  const filled = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (mask[i] === 0) filled[i] = 1;
  const remaining = types.map((t) => t.count);

  let solutions = 0;
  let nodes = 0;
  let exhausted = true;

  /**
   * `from` is where the scan for the lowest empty cell may begin. Passing it down rather
   * than keeping a shared cursor matters: a shared one must be saved and restored at
   * every level, and one missed restore makes the count silently wrong rather than
   * loudly broken.
   */
  const search = (from: number): void => {
    if (solutions >= maxSolutions || nodes >= maxNodes) {
      exhausted = false;
      return;
    }
    let cell = from;
    while (cell < size && filled[cell] === 1) cell++;
    if (cell >= size) {
      solutions++;
      return;
    }

    for (let typeIndex = 0; typeIndex < types.length; typeIndex++) {
      if (remaining[typeIndex] === 0) continue;
      for (const id of buckets[cell]![typeIndex]!) {
        const indices = cellsOf[id]!;
        let free = true;
        for (const index of indices) {
          if (filled[index] === 1) {
            free = false;
            break;
          }
        }
        if (!free) continue;

        nodes++;
        for (const index of indices) filled[index] = 1;
        remaining[typeIndex]!--;
        search(cell + 1);
        remaining[typeIndex]!++;
        for (const index of indices) filled[index] = 0;

        if (solutions >= maxSolutions || nodes >= maxNodes) {
          exhausted = false;
          return;
        }
      }
    }
  };

  search(0);
  return { solutions, exhausted, nodes };
}

export interface Playouts {
  /** Fraction of trials that filled the board. */
  readonly completed: number;
  /** Mean fraction of the outline covered when a trial ended, over failed trials only. */
  readonly stalledAt: number;
}

/**
 * How well the puzzle goes for someone playing it without a plan.
 *
 * One trial is a whole game: fill the lowest empty cell with a legal placement, repeat,
 * and see whether you reach the end or run into a hole nothing fits. No backtracking,
 * because the point is to model a player who has not yet realised they need to.
 *
 * The player modelled is careless but not blind. Moves that leave a single free cell with
 * no free neighbour are skipped, because a person *does* see an obvious one-square hole
 * opening up and puts the piece somewhere else. Uniform-random over every legal move was
 * tried first and was too pessimistic to be useful: it rated five of nine generated
 * boards "punishing" and reported completion rates of exactly zero, which separates
 * nothing from nothing. It is the same check the generator uses to avoid stranding cells,
 * for the same reason, and it is deliberately shallow — anything deeper starts measuring
 * the search rather than the board.
 *
 * `stalledAt` exists because completion rate saturates: once a puzzle is hard enough that
 * careless play essentially never finishes, the rate is zero for everything, and how far
 * you *get* is the only thing still carrying information. Stalling at 95% full is a
 * different puzzle from stalling at 40%, and it is also the more useful thing to tell
 * someone: it is the difference between one bad decision and a board that fights you.
 */
export function playouts(
  mask: Uint8Array,
  rows: number,
  cols: number,
  types: readonly PieceType[],
  trials = DEFAULT_LIMITS.trials,
  seed = DEFAULT_LIMITS.seed,
): Playouts {
  const size = rows * cols;
  const { buckets, cellsOf } = placementIndex(mask, rows, cols, types);
  const rng = makeRng(seed);
  const filled = new Uint8Array(size);
  const blocked = new Uint8Array(size);
  let cells = 0;
  for (let i = 0; i < size; i++) {
    if (mask[i] === 0) blocked[i] = 1;
    else cells++;
  }
  const smallest = types.reduce((n, t) => Math.min(n, t.cells.length), Infinity);

  /** Would this placement leave a free cell that nothing can ever reach? */
  const strands = (indices: readonly number[]): boolean => {
    if (smallest <= 1) return false;
    const free = (index: number, row: number, col: number): boolean =>
      row >= 0 && col >= 0 && row < rows && col < cols && filled[index] === 0;
    for (const index of indices) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const r = row + dr;
        const c = col + dc;
        if (!free((r * cols + c) as number, r, c)) continue;
        const open =
          free(((r - 1) * cols + c) as number, r - 1, c) ||
          free(((r + 1) * cols + c) as number, r + 1, c) ||
          free((r * cols + c - 1) as number, r, c - 1) ||
          free((r * cols + c + 1) as number, r, c + 1);
        if (!open) return true;
      }
    }
    return false;
  };

  let wins = 0;
  let stalledTotal = 0;
  let stalls = 0;
  const legal: number[] = [];
  const fallback: number[] = [];

  for (let trial = 0; trial < trials; trial++) {
    filled.set(blocked);
    const remaining = types.map((t) => t.count);
    let covered = 0;
    let cell = 0;

    for (;;) {
      while (cell < size && filled[cell] === 1) cell++;
      if (cell >= size) {
        wins++;
        break;
      }

      legal.length = 0;
      fallback.length = 0;
      for (let typeIndex = 0; typeIndex < types.length; typeIndex++) {
        if (remaining[typeIndex] === 0) continue;
        for (const id of buckets[cell]![typeIndex]!) {
          const indices = cellsOf[id]!;
          let free = true;
          for (const index of indices) {
            if (filled[index] === 1) {
              free = false;
              break;
            }
          }
          if (!free) continue;
          // The type rides along so the chosen move can decrement the right count;
          // packing both into one number keeps the hot list a flat array.
          const packed = id * types.length + typeIndex;
          fallback.push(packed);
          // Applied and undone rather than simulated, so the check sees exactly the
          // board the move would produce.
          for (const index of indices) filled[index] = 1;
          const bad = strands(indices);
          for (const index of indices) filled[index] = 0;
          if (!bad) legal.push(packed);
        }
      }

      // Every move leaves a hole: the player is cornered and picks one anyway rather
      // than conceding a move early, which would flatter the board.
      const choices = legal.length > 0 ? legal : fallback;
      if (choices.length === 0) {
        stalledTotal += cells === 0 ? 0 : covered / cells;
        stalls++;
        break;
      }

      const packed = choices[Math.floor(rng() * choices.length)]!;
      const typeIndex = packed % types.length;
      const indices = cellsOf[(packed - typeIndex) / types.length]!;
      for (const index of indices) filled[index] = 1;
      covered += indices.length;
      remaining[typeIndex]!--;
    }
  }

  return {
    completed: trials === 0 ? 0 : wins / trials,
    stalledAt: stalls === 0 ? 1 : stalledTotal / stalls,
  };
}

/**
 * Turn the measurements into something worth showing a player.
 *
 * The bands come from measuring nine generated boards rather than from taste, and the
 * scale is deliberately coarse — five steps, because the underlying numbers do not
 * support finer resolution and pretending otherwise would be false precision. The 0.6
 * stall threshold is where those boards actually separated: the zero-completion ones ran
 * from 0.46 to 0.65, so a cut at 0.85 (the first guess) put every one of them in the same
 * band and the scale had a top step nobody could get off.
 *
 * A puzzle with exactly one solution is bumped up a band regardless: every recovery from
 * a wrong turn has to find that single arrangement again, which is a different experience
 * from one of a thousand.
 */
export function rate(report: SolutionCount & Playouts): number {
  const f = report.completed;
  // Below about one in twenty the completion rate stops separating boards, so how far a
  // failed attempt gets takes over as the discriminator.
  let band =
    f >= 0.6
      ? 1
      : f >= 0.25
        ? 2
        : f >= 0.05
          ? 3
          : report.stalledAt >= 0.6
            ? 4
            : 5;
  if (report.exhausted && report.solutions === 1) band = Math.min(5, band + 1);
  return band;
}

const BANDS = ['', 'gentle', 'easy-going', 'a fair challenge', 'hard', 'punishing'] as const;

export function describe(report: SolutionCount & Playouts): string {
  const band = BANDS[rate(report)]!;
  const chance =
    report.completed >= 0.05
      ? `${Math.round(report.completed * 100)}% of careless attempts finish`
      : `careless play usually stalls around ${Math.round(report.stalledAt * 100)}% full`;
  // "At least 0 solutions" is not a fact about the puzzle, it is a fact about the search
  // giving up, and saying it as though it described the board would be a lie of format.
  const solutions = report.exhausted
    ? report.solutions === 1
      ? 'exactly one solution'
      : `${report.solutions} solutions`
    : report.solutions === 0
      ? 'too many arrangements to search'
      : `at least ${report.solutions} solutions`;
  return `${band} · ${chance} · ${solutions}`;
}

/** The whole measurement, for a tiling that has already been generated. */
export function analyseTiling(
  tiling: Tiling,
  silhouette: Silhouette = 'rectangle',
  limits: PackingLimits = {},
): PackingReport {
  const settings = { ...DEFAULT_LIMITS, ...limits };
  const mask = silhouetteMask(tiling.rows, tiling.cols, silhouette);
  const types = pieceTypes(tiling);
  const counted = countPackings(mask, tiling.rows, tiling.cols, types, settings);
  const played = playouts(mask, tiling.rows, tiling.cols, types, settings.trials, settings.seed);
  const partial = { ...counted, ...played };
  return {
    ...partial,
    trials: settings.trials,
    rating: rate(partial),
    summary: describe(partial),
  };
}
