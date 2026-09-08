/**
 * The polyomino cut: pieces that are L-shapes, crosses, T's and bars rather than one
 * grid cell each.
 *
 * This exists because of a decision made in M1 and not touched since: a piece is an
 * outline plus a UV rect. Nothing in the renderer, the snap engine, clusters, trays,
 * scatter, the save format or the assistance levels ever asked how many sides a piece
 * had. So a second cut is a second *generator*, not a second application — everything
 * downstream takes these pieces exactly as it takes the classic ones.
 *
 * Three things carry the design.
 *
 * **The lattice stays regular.** The classic cut jitters its grid vertices so pieces are
 * not a uniform lattice. Here that would work against the point: an L is recognisable as
 * an L because its corners are square, and wobbling them turns crisp shapes into vague
 * blobs. Variety comes from the shapes themselves instead.
 *
 * **Unit edges are shared, exactly as in the classic cut.** The boundary between two
 * pieces is a run of unit cell-edges, each generated once against a key derived from its
 * position in the lattice, then traversed forwards by one piece and backwards by the
 * other. Complementary tabs stay true by construction rather than by two calculations
 * agreeing, which is the same guarantee the classic cut has and for the same reason.
 *
 * **Placement is greedy, not backtracking.** A backtracking tiler can spend exponential
 * time proving a rectangle cannot be tiled by the shapes you gave it. Including the
 * single cell as a last resort makes failure impossible, so a greedy pass always
 * terminates and always produces a valid partition; the cost is the occasional small
 * piece where nothing bigger fitted, which is a fair price for a generator that cannot
 * hang. `tilingStats()` exists to keep that cost honest and is asserted in the tests.
 */

import {
  reverseEdge,
  straightEdge,
  tabbedEdge,
  type Edge,
  type GeometryOptions,
} from './geometry.js';
import { deriveSeed, makeRng } from './rng.js';
import type { PathCommand, PieceGeometry, Point, PuzzleGeometry } from './types.js';

export interface Cell {
  readonly row: number;
  readonly col: number;
}

/** A shape as offsets from its top-left, normalised so the minimum row and col are 0. */
export interface ShapeTemplate {
  readonly name: string;
  readonly cells: readonly Cell[];
}

/**
 * The shape vocabulary, smallest last.
 *
 * Named rather than grown at random because the request was for L-shapes and crosses,
 * and organic growth produces neither — it produces blobs that happen to be four cells
 * big. `single` and `domino` are the fallbacks that guarantee the tiler terminates.
 */
const c = (...pairs: [number, number][]): Cell[] =>
  pairs.map(([row, col]) => ({ row, col }));

export const SHAPES: readonly ShapeTemplate[] = [
  // The twelve free pentominoes, by their conventional letters. Having all of them is
  // what makes a pentominoes-only puzzle a real one rather than a plus sign repeated.
  { name: 'F', cells: c([0, 1], [0, 2], [1, 0], [1, 1], [2, 1]) },
  { name: 'I5', cells: c([0, 0], [1, 0], [2, 0], [3, 0], [4, 0]) },
  { name: 'L5', cells: c([0, 0], [1, 0], [2, 0], [3, 0], [3, 1]) },
  { name: 'N', cells: c([0, 1], [1, 1], [2, 0], [2, 1], [3, 0]) },
  { name: 'P', cells: c([0, 0], [0, 1], [1, 0], [1, 1], [2, 0]) },
  { name: 'T5', cells: c([0, 0], [0, 1], [0, 2], [1, 1], [2, 1]) },
  { name: 'U', cells: c([0, 0], [0, 2], [1, 0], [1, 1], [1, 2]) },
  { name: 'V', cells: c([0, 0], [1, 0], [2, 0], [2, 1], [2, 2]) },
  { name: 'W', cells: c([0, 0], [1, 0], [1, 1], [2, 1], [2, 2]) },
  { name: 'plus', cells: c([0, 1], [1, 0], [1, 1], [1, 2], [2, 1]) },
  { name: 'Y', cells: c([0, 1], [1, 0], [1, 1], [2, 1], [3, 1]) },
  { name: 'Z5', cells: c([0, 0], [0, 1], [1, 1], [2, 1], [2, 2]) },
  { name: 'L', cells: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 2, col: 0 }, { row: 2, col: 1 }] },
  { name: 'J', cells: [{ row: 0, col: 1 }, { row: 1, col: 1 }, { row: 2, col: 1 }, { row: 2, col: 0 }] },
  { name: 'T', cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 1 }] },
  { name: 'S', cells: [{ row: 0, col: 1 }, { row: 0, col: 2 }, { row: 1, col: 0 }, { row: 1, col: 1 }] },
  { name: 'Z', cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 1 }, { row: 1, col: 2 }] },
  { name: 'O', cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 }] },
  { name: 'I', cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 }] },
  { name: 'corner', cells: [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 1, col: 1 }] },
  { name: 'domino', cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }] },
  { name: 'single', cells: [{ row: 0, col: 0 }] },
];

function normalise(cells: readonly Cell[]): Cell[] {
  const minR = Math.min(...cells.map((c) => c.row));
  const minC = Math.min(...cells.map((c) => c.col));
  return cells
    .map((c) => ({ row: c.row - minR, col: c.col - minC }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

function key(cells: readonly Cell[]): string {
  return cells.map((c) => `${c.row},${c.col}`).join(' ');
}

/** The four rotations of a shape, with duplicates removed (a square has one). */
export function rotations(shape: ShapeTemplate): Cell[][] {
  const out: Cell[][] = [];
  const seen = new Set<string>();
  let cells = normalise(shape.cells);
  for (let i = 0; i < 4; i++) {
    const k = key(cells);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(cells);
    }
    // Rotate 90 degrees clockwise: (row, col) -> (col, -row).
    cells = normalise(cells.map((c) => ({ row: c.col, col: -c.row })));
  }
  return out;
}

/** Which shapes the tiler may use. */
export type ShapeSet = 'mixed' | 'tetrominoes' | 'pentominoes';

/**
 * The outline the pieces have to fill.
 *
 * Named rather than passed as a predicate, because these options are stored in the save
 * file and regenerated from it — a function cannot survive JSON, and a puzzle that could
 * not be reopened would be worse than no silhouettes at all.
 */
export type Silhouette = 'rectangle' | 'diamond' | 'ellipse' | 'cross' | 'frame';

export interface PolyominoOptions extends GeometryOptions {
  /** Average cells per piece the tiler aims for. Larger means fewer, chunkier pieces. */
  readonly targetCells?: number;
  /** Flat cuts instead of interlocking tabs. */
  readonly flatEdges?: boolean;
  readonly shapeSet?: ShapeSet;
  readonly silhouette?: Silhouette;
}

/** Is this cell part of the puzzle, or outside the silhouette? */
export function inSilhouette(
  row: number,
  col: number,
  rows: number,
  cols: number,
  shape: Silhouette = 'rectangle',
): boolean {
  const midR = (rows - 1) / 2;
  const midC = (cols - 1) / 2;
  const dr = rows <= 1 ? 0 : (row - midR) / (rows / 2);
  const dc = cols <= 1 ? 0 : (col - midC) / (cols / 2);
  switch (shape) {
    case 'diamond':
      return Math.abs(dr) + Math.abs(dc) <= 1.02;
    case 'ellipse':
      return dr * dr + dc * dc <= 1.02;
    case 'cross': {
      const armR = Math.max(1, Math.floor(rows / 3));
      const armC = Math.max(1, Math.floor(cols / 3));
      return (
        (row >= armR && row < rows - armR) || (col >= armC && col < cols - armC)
      );
    }
    case 'frame': {
      const inR = Math.max(1, Math.floor(rows / 4));
      const inC = Math.max(1, Math.floor(cols / 4));
      return row < inR || row >= rows - inR || col < inC || col >= cols - inC;
    }
    default:
      return true;
  }
}

/** Cells that make up a silhouette, as a flat blocked/free map. */
export function silhouetteMask(
  rows: number,
  cols: number,
  shape: Silhouette = 'rectangle',
): Uint8Array {
  const mask = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      mask[r * cols + col] = inSilhouette(r, col, rows, cols, shape) ? 1 : 0;
    }
  }
  return mask;
}

const NEIGHBOURS = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
] as const;

export interface Tiling {
  readonly rows: number;
  readonly cols: number;
  /** Cell index (row * cols + col) -> piece index. */
  readonly owner: Int32Array;
  /** Cells of each piece, in the order the tiler placed them. */
  readonly pieces: readonly (readonly Cell[])[];
}

/**
 * Partition a grid into polyominoes.
 *
 * Greedy and seeded: walk the cells in reading order, and at the first unfilled one try
 * shapes in a seeded order until one fits with that cell inside it. Every cell of a
 * candidate shape is tried as the anchor, which is what lets an L reach into a notch
 * rather than only ever being placed from its corner.
 */
export function tile(
  seed: number,
  rows: number,
  cols: number,
  options: PolyominoOptions = {},
): Tiling {
  const target = Math.max(1, Math.min(5, Math.round(options.targetCells ?? 4)));
  const mask = silhouetteMask(rows, cols, options.silhouette ?? 'rectangle');
  // -2 marks a cell outside the silhouette: never free, never assigned, and not counted
  // as covered. Using the owner map for it keeps every "is this cell available" check in
  // one place rather than threading a second grid through the whole tiler.
  const owner = new Int32Array(rows * cols).fill(-1);
  for (let i = 0; i < owner.length; i++) if (mask[i] === 0) owner[i] = -2;
  const pieces: Cell[][] = [];

  // A shape set restricts the vocabulary, but the domino and the single stay in it
  // whatever is chosen: without a guaranteed fallback the greedy pass could fail to
  // place anything at all, and a pentominoes-only puzzle that sometimes refuses to
  // generate would be worse than one with the occasional small piece in it.
  const set = options.shapeSet ?? 'mixed';
  const allowed = SHAPES.filter((shape) => {
    if (shape.cells.length <= 2) return true;
    if (set === 'pentominoes') return shape.cells.length === 5;
    if (set === 'tetrominoes') return shape.cells.length === 4;
    return true;
  });

  // Shapes near the target size first, so the dial actually changes the result rather
  // than only changing which shapes are theoretically allowed.
  const ordered = [...allowed].sort(
    (a, b) =>
      Math.abs(a.cells.length - target) - Math.abs(b.cells.length - target) ||
      b.cells.length - a.cells.length,
  );
  const variants = ordered.map((shape) => ({ shape, forms: rotations(shape) }));

  const free = (r: number, c: number): boolean =>
    r >= 0 && c >= 0 && r < rows && c < cols && owner[r * cols + c] === -1;

  /**
   * Would this placement leave a free cell with no free neighbour?
   *
   * Such a cell can only ever become a one-cell piece. Measured on a 10x16 grid, asking
   * for five-cell pieces without this check produced fifteen single-cell scraps out of
   * forty-eight pieces — the big shapes fit first and left holes behind them, so the
   * size dial made the result *worse* the further you turned it up. Rejecting a
   * placement that strands a cell costs one cheap look around and is the difference
   * between a board of crosses and a board of crosses littered with dropped squares.
   */
  const strands = (cells: readonly Cell[]): boolean => {
    const taken = new Set(cells.map((cell) => `${cell.row},${cell.col}`));
    const isFree = (r: number, c: number): boolean =>
      free(r, c) && !taken.has(`${r},${c}`);

    for (const cell of cells) {
      for (const [dr, dc] of NEIGHBOURS) {
        const r = cell.row + dr;
        const c = cell.col + dc;
        if (!isFree(r, c)) continue;
        const hasRoom = NEIGHBOURS.some(([r2, c2]) => isFree(r + r2, c + c2));
        if (!hasRoom) return true;
      }
    }
    return false;
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (owner[r * cols + c] !== -1) continue;

      const rng = makeRng(deriveSeed(seed, 11, r * cols + c));
      let placed: Cell[] | null = null;

      for (const { forms } of variants) {
        // A seeded rotation offset, so a run of identical shapes is not all one way up.
        const start = Math.floor(rng() * forms.length);
        for (let f = 0; f < forms.length && !placed; f++) {
          const form = forms[(start + f) % forms.length]!;
          const anchorStart = Math.floor(rng() * form.length);
          for (let a = 0; a < form.length && !placed; a++) {
            const anchor = form[(anchorStart + a) % form.length]!;
            const dr = r - anchor.row;
            const dc = c - anchor.col;
            const cells = form.map((cell) => ({ row: cell.row + dr, col: cell.col + dc }));
            if (!cells.every((cell) => free(cell.row, cell.col))) continue;
            if (strands(cells)) continue;
            placed = cells;
          }
        }
        if (placed) break;
      }

      // `single` is in the vocabulary, so this can only be null if the cell were already
      // taken, which the loop guard above rules out.
      const cells = placed ?? [{ row: r, col: c }];
      const index = pieces.length;
      for (const cell of cells) owner[cell.row * cols + cell.col] = index;
      pieces.push(cells);
    }
  }

  return { rows, cols, owner, pieces };
}

/** How chunky a tiling actually came out. Greedy placement has to be kept honest. */
export function tilingStats(tiling: Tiling): {
  pieces: number;
  meanCells: number;
  singles: number;
  /** Fraction of cells living in pieces of three or more. */
  chunky: number;
} {
  // Counted from the pieces, not rows x cols: with a silhouette most of the rectangle
  // may not be part of the puzzle at all.
  const total = tiling.pieces.reduce((n, cells) => n + cells.length, 0);
  let singles = 0;
  let inChunky = 0;
  for (const cells of tiling.pieces) {
    if (cells.length === 1) singles++;
    if (cells.length >= 3) inChunky += cells.length;
  }
  return {
    pieces: tiling.pieces.length,
    meanCells: total / tiling.pieces.length,
    singles,
    chunky: inChunky / total,
  };
}

/** Directed unit edges around a piece, in clockwise order, as lattice keys. */
interface UnitStep {
  /** Shared key for the lattice edge, so both owners generate the same curve. */
  readonly key: string;
  /** True when this piece walks the shared edge in its canonical direction. */
  readonly forward: boolean;
  readonly from: Point;
  readonly to: Point;
}

/**
 * Walk the boundary of a set of cells clockwise.
 *
 * Each cell contributes a directed unit edge for every side with no same-piece cell
 * behind it, oriented so the piece is on the right. Those directed edges chain head to
 * tail into exactly one closed loop for any shape without a hole — which none of the
 * templates has, and which a leftover gap cannot create because a gap becomes its own
 * piece rather than a hole in someone else's.
 */
function traceBoundary(cells: readonly Cell[]): UnitStep[] {
  const owned = new Set(cells.map((c) => `${c.row},${c.col}`));
  const has = (r: number, c: number): boolean => owned.has(`${r},${c}`);

  const steps: UnitStep[] = [];
  for (const { row: r, col: c } of cells) {
    // Lattice point (col, row) is the top-left corner of cell (row, col).
    if (!has(r - 1, c)) {
      steps.push({ key: `h:${r}:${c}`, forward: true, from: { x: c, y: r }, to: { x: c + 1, y: r } });
    }
    if (!has(r, c + 1)) {
      steps.push({ key: `v:${r}:${c + 1}`, forward: true, from: { x: c + 1, y: r }, to: { x: c + 1, y: r + 1 } });
    }
    if (!has(r + 1, c)) {
      steps.push({ key: `h:${r + 1}:${c}`, forward: false, from: { x: c + 1, y: r + 1 }, to: { x: c, y: r + 1 } });
    }
    if (!has(r, c - 1)) {
      steps.push({ key: `v:${r}:${c}`, forward: false, from: { x: c, y: r + 1 }, to: { x: c, y: r } });
    }
  }

  // Chain them into one loop by matching each step's end to the next step's start.
  const byStart = new Map<string, UnitStep[]>();
  for (const step of steps) {
    const k = `${step.from.x},${step.from.y}`;
    const list = byStart.get(k);
    if (list) list.push(step);
    else byStart.set(k, [step]);
  }

  const loop: UnitStep[] = [];
  let current = steps[0]!;
  const used = new Set<UnitStep>();
  for (let i = 0; i < steps.length; i++) {
    loop.push(current);
    used.add(current);
    const candidates = byStart.get(`${current.to.x},${current.to.y}`) ?? [];
    const next = candidates.find((s) => !used.has(s));
    if (!next) break;
    current = next;
  }
  return loop;
}

/**
 * Build the pieces for a polyomino cut.
 *
 * The shape of this function deliberately mirrors `generateGeometry`: same options, same
 * output type, same guarantees. A caller chooses a cut; nothing else changes.
 */
export function generatePolyominoGeometry(
  seed: number,
  rows: number,
  cols: number,
  imageWidth: number,
  imageHeight: number,
  options: PolyominoOptions = {},
): PuzzleGeometry {
  const opts = {
    vertexJitter: 0,
    tabScale: options.tabScale ?? 1,
    randomiseTabs: options.randomiseTabs ?? true,
  };
  const cellWidth = imageWidth / cols;
  const cellHeight = imageHeight / rows;
  const perp = Math.min(cellWidth, cellHeight);
  const flat = options.flatEdges ?? false;

  const tiling = tile(seed, rows, cols, options);

  // Every lattice edge is built once and shared, so the two pieces either side of it are
  // complementary by construction rather than by agreement.
  const edges = new Map<string, Edge>();
  const point = (x: number, y: number): Point => ({ x: x * cellWidth, y: y * cellHeight });
  const edgeFor = (step: UnitStep): Edge => {
    const existing = edges.get(step.key);
    if (existing) return step.forward ? existing : reverseEdge(existing);

    // Canonical direction: left to right for horizontal, top to bottom for vertical.
    const [kind, a, b] = step.key.split(':');
    const r = Number(a);
    const c = Number(b);
    const from = point(kind === 'h' ? c : c, kind === 'h' ? r : r);
    const to = point(kind === 'h' ? c + 1 : c, kind === 'h' ? r : r + 1);

    // An edge is an outer edge when either side of it is off the grid *or* outside the
    // silhouette. A tab there would stick out into nothing.
    const solid = (rr: number, cc: number): boolean =>
      rr >= 0 && cc >= 0 && rr < rows && cc < cols && tiling.owner[rr * cols + cc]! >= 0;
    const onBorder =
      kind === 'h' ? !solid(r - 1, c) || !solid(r, c) : !solid(r, c - 1) || !solid(r, c);
    const built =
      flat || onBorder
        ? straightEdge(from, to)
        : tabbedEdge(from, to, deriveSeed(seed, 12, hashKey(step.key)), opts, perp);
    edges.set(step.key, built);
    return step.forward ? built : reverseEdge(built);
  };

  const pieces: PieceGeometry[] = [];
  for (const [index, cells] of tiling.pieces.entries()) {
    const loop = traceBoundary(cells);
    const chain = loop.map(edgeFor);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const see = (p: Point): void => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    };
    for (const edge of chain) {
      see(edge.from);
      for (const s of edge.segs) {
        see(s.c1);
        see(s.c2);
        see(s.to);
      }
    }

    const bounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    const rel = (p: Point): Point => ({ x: p.x - bounds.x, y: p.y - bounds.y });
    const outline: PathCommand[] = [{ kind: 'move', to: rel(chain[0]!.from) }];
    for (const edge of chain) {
      for (const s of edge.segs) {
        outline.push({ kind: 'cubic', c1: rel(s.c1), c2: rel(s.c2), to: rel(s.to) });
      }
    }
    outline.push({ kind: 'close' });

    // Neighbours: any different owner across a shared cell side.
    const adjacent = new Set<number>();
    let isBorder = false;
    for (const cell of cells) {
      for (const [dr, dc] of NEIGHBOURS) {
        const r = cell.row + dr;
        const c = cell.col + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) {
          isBorder = true;
          continue;
        }
        const other = tiling.owner[r * cols + c]!;
        // -2 is outside the silhouette. It is an outside edge, not a neighbour.
        if (other === -2) {
          isBorder = true;
          continue;
        }
        if (other !== index) adjacent.add(other);
      }
    }

    const first = cells[0]!;
    pieces.push({
      id: index,
      row: first.row,
      col: first.col,
      bounds,
      outline,
      solved: { x: bounds.x, y: bounds.y },
      // A polyomino has no meaningful four-side record; `adjacent` is what everything
      // downstream consults, and this stays as a stub so the type is uniform.
      neighbours: { top: -1, right: -1, bottom: -1, left: -1 },
      adjacent: [...adjacent].sort((a, b) => a - b),
      isBorder,
      cells,
      sideSegmentCounts: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  }

  return {
    seed,
    rows,
    cols,
    imageWidth,
    imageHeight,
    pieces,
    cellWidth,
    cellHeight,
    cut: 'polyomino',
    // Kept verbatim so a reload regenerates this exact tiling rather than a similar one.
    polyominoOptions: { ...options },
  };
}

/** FNV-1a over the lattice key, so each shared edge gets its own stable tab. */
function hashKey(k: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) {
    h ^= k.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
