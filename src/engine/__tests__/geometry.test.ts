import { describe, expect, it } from 'vitest';
import {
  chooseGrid,
  flattenOutline,
  generateGeometry,
  pieceCountLimits,
  pieceEdgePixels,
} from '../geometry.js';
import type { PieceGeometry, Point, PuzzleGeometry, Side } from '../types.js';

const EPS = 1e-6;

/**
 * Absolute control/anchor points contributed by one side of a piece.
 * Layout of `outline` is: move, top cubics, right cubics, bottom cubics, left cubics, close.
 */
function sidePoints(piece: PieceGeometry, side: Side): Point[] {
  const order: Side[] = ['top', 'right', 'bottom', 'left'];
  let start = 1;
  for (const s of order) {
    if (s === side) break;
    start += piece.sideSegmentCounts[s];
  }
  const count = piece.sideSegmentCounts[side];

  const abs = (p: Point): Point => ({ x: p.x + piece.bounds.x, y: p.y + piece.bounds.y });

  const prev = piece.outline[start - 1]!;
  if (prev.kind === 'close') throw new Error('unexpected close');
  const pts: Point[] = [abs(prev.to)];
  for (let i = start; i < start + count; i++) {
    const cmd = piece.outline[i]!;
    if (cmd.kind !== 'cubic') throw new Error(`expected cubic at ${i}, got ${cmd.kind}`);
    pts.push(abs(cmd.c1), abs(cmd.c2), abs(cmd.to));
  }
  return pts;
}

function expectSamePoints(a: Point[], b: Point[]): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(Math.abs(a[i]!.x - b[i]!.x)).toBeLessThan(EPS);
    expect(Math.abs(a[i]!.y - b[i]!.y)).toBeLessThan(EPS);
  }
}

function pieceAt(g: PuzzleGeometry, row: number, col: number): PieceGeometry {
  return g.pieces[row * g.cols + col]!;
}

describe('generateGeometry', () => {
  it('produces rows * cols pieces with correct ids and neighbours', () => {
    const g = generateGeometry(1234, 5, 8, 1600, 1000);
    expect(g.pieces).toHaveLength(40);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 8; c++) {
        const p = pieceAt(g, r, c);
        expect(p.id).toBe(r * 8 + c);
        expect(p.row).toBe(r);
        expect(p.col).toBe(c);
        expect(p.neighbours.top).toBe(r > 0 ? p.id - 8 : -1);
        expect(p.neighbours.bottom).toBe(r < 4 ? p.id + 8 : -1);
        expect(p.neighbours.left).toBe(c > 0 ? p.id - 1 : -1);
        expect(p.neighbours.right).toBe(c < 7 ? p.id + 1 : -1);
      }
    }
  });

  it('is deterministic: the same seed gives byte-identical geometry', () => {
    const a = generateGeometry(987654, 6, 9, 1920, 1280);
    const b = generateGeometry(987654, 6, 9, 1920, 1280);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a different seed gives different geometry', () => {
    const a = generateGeometry(1, 6, 9, 1920, 1280);
    const b = generateGeometry(2, 6, 9, 1920, 1280);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('neighbouring pieces share exactly the same boundary curve', () => {
    const g = generateGeometry(42, 6, 7, 1400, 1200);

    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const p = pieceAt(g, r, c);

        if (c < g.cols - 1) {
          const right = pieceAt(g, r, c + 1);
          expectSamePoints([...sidePoints(p, 'right')].reverse(), sidePoints(right, 'left'));
        }
        if (r < g.rows - 1) {
          const below = pieceAt(g, r + 1, c);
          expectSamePoints([...sidePoints(p, 'bottom')].reverse(), sidePoints(below, 'top'));
        }
      }
    }
  });

  it('border edges lie exactly on the image boundary', () => {
    const W = 1200;
    const H = 800;
    const g = generateGeometry(7, 4, 6, W, H);

    for (let c = 0; c < g.cols; c++) {
      for (const p of sidePoints(pieceAt(g, 0, c), 'top')) expect(Math.abs(p.y)).toBeLessThan(EPS);
      for (const p of sidePoints(pieceAt(g, g.rows - 1, c), 'bottom')) {
        expect(Math.abs(p.y - H)).toBeLessThan(EPS);
      }
    }
    for (let r = 0; r < g.rows; r++) {
      for (const p of sidePoints(pieceAt(g, r, 0), 'left')) expect(Math.abs(p.x)).toBeLessThan(EPS);
      for (const p of sidePoints(pieceAt(g, r, g.cols - 1), 'right')) {
        expect(Math.abs(p.x - W)).toBeLessThan(EPS);
      }
    }
  });

  it('keeps every piece inside the image bounds', () => {
    const W = 1200;
    const H = 800;
    const g = generateGeometry(99, 5, 7, W, H);
    for (const p of g.pieces) {
      expect(p.bounds.x).toBeGreaterThanOrEqual(-EPS);
      expect(p.bounds.y).toBeGreaterThanOrEqual(-EPS);
      expect(p.bounds.x + p.bounds.w).toBeLessThanOrEqual(W + EPS);
      expect(p.bounds.y + p.bounds.h).toBeLessThanOrEqual(H + EPS);
      expect(p.bounds.w).toBeGreaterThan(0);
      expect(p.bounds.h).toBeGreaterThan(0);
    }
  });

  it('gives interior pieces tabs that overhang their nominal cell', () => {
    const g = generateGeometry(5, 5, 5, 1000, 1000);
    const middle = pieceAt(g, 2, 2);
    // Nominal cell is 200x200; with four tabbed sides the bbox must be meaningfully larger.
    expect(middle.bounds.w).toBeGreaterThan(220);
    expect(middle.bounds.h).toBeGreaterThan(220);
  });

  it('flattens outlines into closed polylines', () => {
    const g = generateGeometry(3, 3, 3, 600, 600);
    const pts = flattenOutline(g.pieces[4]!.outline);
    expect(pts.length).toBeGreaterThan(40);
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(EPS);
  });

  it('supports a perfectly regular grid when jitter and tab randomisation are off', () => {
    const g = generateGeometry(11, 4, 4, 800, 800, { vertexJitter: 0, randomiseTabs: false });
    // Every piece has the same nominal cell, so bounding boxes differ only by tab direction.
    const widths = new Set(g.pieces.map((p) => Math.round(p.bounds.w * 1000)));
    expect(widths.size).toBeLessThanOrEqual(4);
  });

  it('rejects degenerate inputs', () => {
    expect(() => generateGeometry(1, 0, 4, 100, 100)).toThrow();
    expect(() => generateGeometry(1, 4, 4, 0, 100)).toThrow();
  });
});

describe('chooseGrid', () => {
  it('lands close to the requested piece count', () => {
    for (const target of [20, 50, 100, 250, 500, 1000, 2000]) {
      const { rows, cols } = chooseGrid(6000, 4000, target);
      const count = rows * cols;
      expect(Math.abs(count - target) / target).toBeLessThan(0.12);
    }
  });

  it('keeps pieces roughly square for a wide image', () => {
    const { rows, cols } = chooseGrid(4000, 1000, 200);
    const cellAspect = 4000 / cols / (1000 / rows);
    expect(cellAspect).toBeGreaterThan(0.7);
    expect(cellAspect).toBeLessThan(1.45);
  });
});

describe('pieceCountLimits', () => {
  it('separates the comfortable threshold from the hard maximum', () => {
    const { comfortable, maximum } = pieceCountLimits(1920, 1080);
    expect(maximum).toBeGreaterThan(comfortable);
    // A 1920x1080 image should still be *allowed* 2,000 pieces, just warned about.
    expect(comfortable).toBeLessThan(2000);
    expect(maximum).toBeGreaterThan(2000);
  });

  it('lets a DSLR image have 2,000 pieces comfortably', () => {
    expect(pieceCountLimits(6000, 4000).comfortable).toBeGreaterThan(2000);
  });

  it('refuses counts that would make pieces mostly tab', () => {
    // A small image genuinely cannot support thousands of pieces.
    expect(pieceCountLimits(640, 480).maximum).toBeLessThan(1000);
  });

  it('never returns fewer than four', () => {
    expect(pieceCountLimits(10, 10).maximum).toBeGreaterThanOrEqual(4);
    expect(pieceCountLimits(10, 10).comfortable).toBeGreaterThanOrEqual(4);
  });
});

describe('pieceEdgePixels', () => {
  it('reports roughly the source pixels along a piece edge', () => {
    expect(pieceEdgePixels(1920, 1080, 576)).toBeCloseTo(60, 0);
    expect(pieceEdgePixels(6000, 4000, 1000)).toBeCloseTo(155, 0);
  });
});
