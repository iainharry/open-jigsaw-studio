/**
 * Puzzle geometry generation.
 *
 * Design notes, because two decisions here are load-bearing for the whole project:
 *
 * 1. **Edges are shared objects, not per-piece drawings.** The boundary between two
 *    neighbouring pieces is generated exactly once and traversed forwards by one piece
 *    and backwards by the other. Complementary tabs are therefore true by construction
 *    rather than by matching two independent calculations. There is a test for it, but
 *    the test can only ever confirm what the data structure already guarantees.
 *
 * 2. **A piece is an outline plus a bounding box.** The bounding box doubles as the UV
 *    rect into the source image. That one representation serves both the Canvas2D
 *    renderer (bake the outline as a clip path, blit the image behind it) and a future
 *    WebGL renderer (triangulate the outline, use the bbox to compute texture
 *    coordinates). Nothing here assumes which renderer will consume it.
 */

import { deriveSeed, makeRng, range } from './rng.js';
import type { PathCommand, PieceGeometry, Point, PuzzleGeometry, Rect, Side } from './types.js';

/** One cubic segment; `from` is the previous point in the chain. */
export interface Seg {
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

export interface Edge {
  readonly from: Point;
  readonly segs: readonly Seg[];
}

export interface GeometryOptions {
  /** Grid vertex displacement, as a fraction of cell size. 0 gives a perfectly regular grid. */
  readonly vertexJitter?: number;
  /** Scales tab size. 1 is the default look. */
  readonly tabScale?: number;
  /** When false, every tab is the same size and only its direction varies. */
  readonly randomiseTabs?: boolean;
}

export const GEOMETRY_DEFAULTS = {
  vertexJitter: 0.06,
  tabScale: 1,
  randomiseTabs: true,
} as const;

/** Reverse an edge so it can be traversed from its far end. */
export function reverseEdge(edge: Edge): Edge {
  const pts: Point[] = [edge.from, ...edge.segs.map((s) => s.to)];
  const segs: Seg[] = [];
  for (let i = edge.segs.length - 1; i >= 0; i--) {
    const s = edge.segs[i]!;
    segs.push({ c1: s.c2, c2: s.c1, to: pts[i]! });
  }
  return { from: pts[pts.length - 1]!, segs };
}

/** A straight edge, expressed as a single cubic so all edges share one shape. */
export function straightEdge(a: Point, b: Point): Edge {
  return {
    from: a,
    segs: [
      {
        c1: { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
        c2: { x: a.x + ((b.x - a.x) * 2) / 3, y: a.y + ((b.y - a.y) * 2) / 3 },
        to: b,
      },
    ],
  };
}

/**
 * Build a tabbed edge from `a` to `b`.
 *
 * Work is done in (t, q) space — t along the edge, q along the normal — then mapped
 * into image space. `perp` is the perpendicular reference length (the smaller cell
 * dimension), so tabs stay round on non-square grids instead of being stretched.
 */
export function tabbedEdge(a: Point, b: Point, seed: number, opts: Required<GeometryOptions>, perp: number): Edge {
  const rng = makeRng(seed);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // Normal is the tangent rotated 90 degrees in a y-down coordinate system.
  const nx = -uy;
  const ny = ux;

  const P = perp * opts.tabScale;
  const sign = rng() < 0.5 ? -1 : 1;
  const jitter = opts.randomiseTabs ? 1 : 0;

  const tabHalf = (opts.randomiseTabs ? range(rng, 0.115, 0.145) : 0.13) * P;
  const neckHalf = (opts.randomiseTabs ? range(rng, 0.045, 0.065) : 0.055) * P;
  const tabHigh = (opts.randomiseTabs ? range(rng, 0.2, 0.27) : 0.235) * P;
  const centre = len * 0.5 + range(rng, -0.05, 0.05) * len * jitter;
  const wob1 = range(rng, -0.025, 0.025) * P * jitter;
  const wob2 = range(rng, -0.025, 0.025) * P * jitter;

  const map = (t: number, q: number): Point => ({
    x: a.x + ux * t + nx * q,
    y: a.y + uy * t + ny * q,
  });

  const neckL = centre - neckHalf;
  const neckR = centre + neckHalf;
  const apexQ = sign * tabHigh;

  const segs: Seg[] = [
    // Flat run into the neck, with a slight waviness so edges are not dead straight.
    {
      c1: map(neckL * 0.33, wob1),
      c2: map(neckL * 0.66, -wob1),
      to: map(neckL, 0),
    },
    // Left half of the bulb. The first control point swings back past the neck,
    // which is what produces the interlocking undercut.
    {
      c1: map(neckL - tabHalf * 0.45, apexQ * 0.3),
      c2: map(centre - tabHalf, apexQ * 1.1),
      to: map(centre, apexQ),
    },
    // Right half of the bulb, mirrored.
    {
      c1: map(centre + tabHalf, apexQ * 1.1),
      c2: map(neckR + tabHalf * 0.45, apexQ * 0.3),
      to: map(neckR, 0),
    },
    // Flat run out to the far vertex.
    {
      c1: map(neckR + (len - neckR) * 0.33, wob2),
      c2: map(neckR + (len - neckR) * 0.66, -wob2),
      to: map(len, 0),
    },
  ];

  return { from: a, segs };
}

/** Every point that bounds the path, including control points (convex hull of the curve). */
function edgePoints(edge: Edge): Point[] {
  const pts: Point[] = [edge.from];
  for (const s of edge.segs) pts.push(s.c1, s.c2, s.to);
  return pts;
}

export function generateGeometry(
  seed: number,
  rows: number,
  cols: number,
  imageWidth: number,
  imageHeight: number,
  options: GeometryOptions = {},
): PuzzleGeometry {
  if (rows < 1 || cols < 1) throw new Error(`invalid grid ${rows}x${cols}`);
  if (imageWidth <= 0 || imageHeight <= 0) throw new Error('invalid image dimensions');

  const opts: Required<GeometryOptions> = { ...GEOMETRY_DEFAULTS, ...options };
  const cellWidth = imageWidth / cols;
  const cellHeight = imageHeight / rows;
  const perp = Math.min(cellWidth, cellHeight);

  // --- Grid vertices, with deterministic jitter -----------------------------
  // Corners are pinned; border vertices slide only along their border, so the
  // pieces still tile the image exactly.
  const vertex: Point[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: Point[] = [];
    for (let c = 0; c <= cols; c++) {
      const rng = makeRng(deriveSeed(seed, 1, r, c));
      const onTopOrBottom = r === 0 || r === rows;
      const onLeftOrRight = c === 0 || c === cols;
      const jx = onLeftOrRight ? 0 : range(rng, -1, 1) * opts.vertexJitter * cellWidth;
      const jy = onTopOrBottom ? 0 : range(rng, -1, 1) * opts.vertexJitter * cellHeight;
      row.push({ x: c * cellWidth + jx, y: r * cellHeight + jy });
    }
    vertex.push(row);
  }

  // --- Shared edges ---------------------------------------------------------
  // hEdge[r][c] runs vertex(r,c) -> vertex(r,c+1); separates piece(r-1,c) from piece(r,c).
  // vEdge[r][c] runs vertex(r,c) -> vertex(r+1,c); separates piece(r,c-1) from piece(r,c).
  const hEdge: Edge[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: Edge[] = [];
    for (let c = 0; c < cols; c++) {
      const a = vertex[r]![c]!;
      const b = vertex[r]![c + 1]!;
      row.push(
        r === 0 || r === rows
          ? straightEdge(a, b)
          : tabbedEdge(a, b, deriveSeed(seed, 2, r, c), opts, perp),
      );
    }
    hEdge.push(row);
  }

  const vEdge: Edge[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Edge[] = [];
    for (let c = 0; c <= cols; c++) {
      const a = vertex[r]![c]!;
      const b = vertex[r + 1]![c]!;
      row.push(
        c === 0 || c === cols
          ? straightEdge(a, b)
          : tabbedEdge(a, b, deriveSeed(seed, 3, r, c), opts, perp),
      );
    }
    vEdge.push(row);
  }

  // --- Pieces ---------------------------------------------------------------
  const pieces: PieceGeometry[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Clockwise: top forward, right forward, bottom reversed, left reversed.
      const top = hEdge[r]![c]!;
      const right = vEdge[r]![c + 1]!;
      const bottom = reverseEdge(hEdge[r + 1]![c]!);
      const left = reverseEdge(vEdge[r]![c]!);
      const chain = [top, right, bottom, left];

      const all: Point[] = [];
      for (const e of chain) all.push(...edgePoints(e));

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of all) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const bounds: Rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

      const rel = (p: Point): Point => ({ x: p.x - bounds.x, y: p.y - bounds.y });
      const outline: PathCommand[] = [{ kind: 'move', to: rel(top.from) }];
      for (const e of chain) {
        for (const s of e.segs) {
          outline.push({ kind: 'cubic', c1: rel(s.c1), c2: rel(s.c2), to: rel(s.to) });
        }
      }
      outline.push({ kind: 'close' });

      const id = r * cols + c;
      const neighbours: Record<Side, number> = {
        top: r > 0 ? id - cols : -1,
        right: c < cols - 1 ? id + 1 : -1,
        bottom: r < rows - 1 ? id + cols : -1,
        left: c > 0 ? id - 1 : -1,
      };

      const sideSegmentCounts: Record<Side, number> = {
        top: top.segs.length,
        right: right.segs.length,
        bottom: bottom.segs.length,
        left: left.segs.length,
      };

      pieces.push({
        id,
        row: r,
        col: c,
        bounds,
        outline,
        solved: { x: bounds.x, y: bounds.y },
        neighbours,
        adjacent: ([neighbours.top, neighbours.right, neighbours.bottom, neighbours.left]
          .filter((n) => n >= 0)
          .sort((a, b) => a - b)),
        isBorder: r === 0 || c === 0 || r === rows - 1 || c === cols - 1,
        cells: [{ row: r, col: c }],
        sideSegmentCounts,
      });
    }
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
  };
}

/** Flatten an outline to a polyline. Used by tests and by a future WebGL triangulator. */
export function flattenOutline(
  outline: readonly PathCommand[],
  samplesPerCurve = 12,
): Point[] {
  const pts: Point[] = [];
  let cur: Point = { x: 0, y: 0 };
  for (const cmd of outline) {
    if (cmd.kind === 'move') {
      cur = cmd.to;
      pts.push(cur);
    } else if (cmd.kind === 'cubic') {
      for (let i = 1; i <= samplesPerCurve; i++) {
        const t = i / samplesPerCurve;
        const mt = 1 - t;
        const a = mt * mt * mt;
        const b = 3 * mt * mt * t;
        const d = 3 * mt * t * t;
        const e = t * t * t;
        pts.push({
          x: a * cur.x + b * cmd.c1.x + d * cmd.c2.x + e * cmd.to.x,
          y: a * cur.y + b * cmd.c1.y + d * cmd.c2.y + e * cmd.to.y,
        });
      }
      cur = cmd.to;
    }
  }
  return pts;
}

/**
 * Piece-count limits for an image.
 *
 * There are two different thresholds here and conflating them was a mistake.
 *
 * `comfortable` is a quality judgement: below this, pieces still carry enough image
 * detail to be matched by eye at a normal zoom. Above it the puzzle gets harder and
 * blurrier, which some people actively want. It is advice, not a rule.
 *
 * `maximum` is the point where a piece is mostly tab and carries almost no picture --
 * genuinely not solvable by anyone. That one is worth enforcing.
 *
 * The original single 60px threshold silently substituted a smaller count, so asking a
 * 1920x1080 image for 2,000 pieces quietly produced 576. Refusing is defensible;
 * refusing without saying so, and without letting the player overrule it, is not.
 */
export function pieceCountLimits(
  imageWidth: number,
  imageHeight: number,
): { comfortable: number; maximum: number } {
  const area = imageWidth * imageHeight;
  const at = (edge: number): number => Math.max(4, Math.floor(area / (edge * edge)));
  return { comfortable: at(40), maximum: at(20) };
}

/** Approximate source pixels along one edge of a piece at the given count. */
export function pieceEdgePixels(
  imageWidth: number,
  imageHeight: number,
  pieceCount: number,
): number {
  return Math.sqrt((imageWidth * imageHeight) / Math.max(1, pieceCount));
}

/**
 * Choose a rows x cols grid that hits `target` pieces as closely as possible while
 * keeping pieces near-square for the given image aspect ratio.
 */
export function chooseGrid(
  imageWidth: number,
  imageHeight: number,
  target: number,
): { rows: number; cols: number } {
  const aspect = imageWidth / imageHeight;
  let best = { rows: 1, cols: 1 };
  let bestScore = Infinity;
  const limit = Math.max(2, Math.ceil(Math.sqrt(target * Math.max(aspect, 1 / aspect))) + 4);
  for (let cols = 1; cols <= limit; cols++) {
    for (const rows of [Math.floor(target / cols), Math.ceil(target / cols)]) {
      if (rows < 1) continue;
      const count = rows * cols;
      const cellAspect = imageWidth / cols / (imageHeight / rows);
      // Weight count error heavily; squareness is the tie-breaker.
      const score =
        Math.abs(count - target) / target + Math.abs(Math.log(cellAspect)) * 0.6;
      if (score < bestScore) {
        bestScore = score;
        best = { rows, cols };
      }
    }
  }
  return best;
}
