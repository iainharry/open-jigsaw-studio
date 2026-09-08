import { describe, expect, it } from 'vitest';
import {
  PALETTE_SIZE,
  assignPieceColours,
  paletteColour,
  perceptualDistance,
  worstNeighbourGap,
} from '../pieceColouring.js';
import { generatePolyominoGeometry } from '../polyomino.js';
import { generateGeometry } from '../geometry.js';

/**
 * 40 on a 0-441 RGB scale is the line this palette was designed against: below it, two
 * fills read as the same colour at a glance on a board of a hundred pieces.
 */
const LEGIBLE = 40;

describe('perceptualDistance', () => {
  it('reports the least favourable vision, not the average', () => {
    // A red and a green that are vivid normally and near-identical to a deuteranope.
    const red: [number, number, number] = [200, 80, 80];
    const green: [number, number, number] = [120, 140, 80];
    expect(perceptualDistance(red, green)).toBeLessThan(
      Math.hypot(200 - 120, 80 - 140, 80 - 80),
    );
  });

  it('is zero for a colour against itself', () => {
    expect(perceptualDistance([12, 34, 56], [12, 34, 56])).toBe(0);
  });

  it('is symmetric', () => {
    const a: [number, number, number] = [10, 200, 90];
    const b: [number, number, number] = [180, 40, 220];
    expect(perceptualDistance(a, b)).toBeCloseTo(perceptualDistance(b, a), 6);
  });
});

describe('paletteColour', () => {
  it('stays inside the byte range', () => {
    for (let i = 0; i < PALETTE_SIZE; i++) {
      for (const channel of paletteColour(i)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });

  it('separates consecutive entries even under colour blindness', () => {
    // The specific failure that shipped: entries next to each other were 6.6 apart to a
    // deuteranope. Lightness now carries the separation, and lightness survives every
    // form of colour vision deficiency.
    for (let i = 0; i + 1 < PALETTE_SIZE; i++) {
      expect(perceptualDistance(paletteColour(i), paletteColour(i + 1))).toBeGreaterThan(
        LEGIBLE,
      );
    }
  });
});

describe('assignPieceColours', () => {
  const shapes = generatePolyominoGeometry(2026, 10, 14, 1400, 1000, { targetCells: 4 });
  const classic = generateGeometry(7, 12, 16, 1600, 1200, {});

  it('gives every piece a colour', () => {
    const colours = assignPieceColours(shapes);
    expect(colours).toHaveLength(shapes.pieces.length);
    for (const c of colours) expect(c).toHaveLength(3);
  });

  it('no two touching pieces are hard to tell apart, for any vision', () => {
    // The property the by-id palette could not provide at all: ids run in reading order,
    // so vertical neighbours are many apart and collided badly.
    expect(worstNeighbourGap(shapes, assignPieceColours(shapes))).toBeGreaterThan(LEGIBLE);
  });

  it('holds for the classic cut too', () => {
    expect(worstNeighbourGap(classic, assignPieceColours(classic))).toBeGreaterThan(LEGIBLE);
  });

  it('holds across many different tilings', () => {
    for (const seed of [1, 5, 42, 900]) {
      for (const targetCells of [2, 4, 5]) {
        const g = generatePolyominoGeometry(seed, 9, 12, 1200, 900, { targetCells });
        expect(worstNeighbourGap(g, assignPieceColours(g))).toBeGreaterThan(LEGIBLE);
      }
    }
  });

  it('is deterministic', () => {
    expect(assignPieceColours(shapes)).toEqual(assignPieceColours(shapes));
  });

  it('a by-id palette would have failed this, which is why the test exists', () => {
    // Guard against anyone "simplifying" the assignment back to colour = f(id).
    const byId = shapes.pieces.map((p) => paletteColour(p.id % PALETTE_SIZE));
    expect(worstNeighbourGap(shapes, byId)).toBeLessThan(LEGIBLE);
  });
});

describe('colour variety', () => {
  it('uses most of the palette rather than the same few entries', () => {
    // The guarantee is about neighbours, but a board legible and dull is still dull: an
    // earlier greedy pass painted thirty pieces in five colours.
    const g = generatePolyominoGeometry(17, 11, 13, 1300, 1100, { targetCells: 4 });
    const used = new Set(assignPieceColours(g).map((c) => c.join(',')));
    expect(used.size).toBeGreaterThan(8);
  });

  it('and still never puts two of the same beside each other', () => {
    for (const seed of [17, 60, 123]) {
      const g = generatePolyominoGeometry(seed, 11, 13, 1300, 1100, { targetCells: 4 });
      expect(worstNeighbourGap(g, assignPieceColours(g))).toBeGreaterThan(LEGIBLE);
    }
  });
});
