/**
 * Colours for a puzzle played without a picture.
 *
 * The first version of this spaced hues by the golden angle and keyed them to piece id.
 * Measured under simulated red-green colour vision deficiency, pieces whose ids differed
 * by one came out **6.6 apart** on a 0-441 scale — indistinguishable. Nine of a hundred
 * and seventy-four near-neighbour pairs fell below legibility. In colours-only mode,
 * telling pieces apart by colour *is* the game, so for roughly one man in twelve that
 * shipped somewhere between frustrating and unplayable.
 *
 * Two things were wrong, and the second is the interesting one.
 *
 * **Hue was carrying all the information.** Under deuteranopia the hue circle collapses
 * towards a single blue-yellow axis, so "far apart in hue" guarantees nothing. Lightness
 * survives every form of colour blindness, so the palette now steps through widely
 * separated lightness levels and treats hue as decoration.
 *
 * **Colour was keyed to id, but adjacency is not.** Ids are assigned in reading order, so
 * two pieces touching vertically can be eight or more apart — and at that distance even
 * the repaired palette collapses to 3.0. No amount of palette tuning fixes that, because
 * the palette does not know which pieces touch. So colours are assigned by a greedy pass
 * over the actual adjacency graph, each piece taking whichever palette entry is furthest
 * from the ones its neighbours already hold. That is what makes the guarantee hold for
 * neighbours rather than merely for consecutive numbers.
 *
 * Headless on purpose: this is arithmetic over numbers, so it is tested in Node. The
 * canvas work that paints the result lives in `src/render/colourBoard.ts`.
 */

import { oklabToRgb } from './colour.js';
import type { PuzzleGeometry } from './types.js';

export type Rgb = readonly [number, number, number];

/**
 * Lightness levels, cycled.
 *
 * Chosen by search rather than taste: this is the four-level cycle whose worst pair
 * within three ids scores 40.6 across normal, deuteranope, protanope and tritanope
 * vision. A three-level cycle scores 12.4, because ids three apart then share a level
 * *and* sit only 52 degrees apart in hue. Four levels put the repeat at 190 degrees.
 */
const LEVELS = [0.3, 0.92, 0.55, 0.75] as const;

/** How many distinct colours the palette offers. */
export const PALETTE_SIZE = 16;

/** One palette entry. Chroma is reduced at the extremes, where it would clip. */
export function paletteColour(index: number): Rgb {
  const hue = (index * 137.508 * Math.PI) / 180;
  const L = LEVELS[index % LEVELS.length]!;
  const chroma = L > 0.78 ? 0.05 : L < 0.45 ? 0.075 : 0.115;
  return oklabToRgb([L, chroma * Math.cos(hue), chroma * Math.sin(hue)]);
}

/**
 * Linear approximations of how the three common colour vision deficiencies transform a
 * colour. Standard simulation matrices, applied in linear light.
 */
const SIMULATIONS: readonly (readonly (readonly number[])[])[] = [
  [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [0.625, 0.375, 0],
    [0.7, 0.3, 0],
    [0, 0.3, 0.7],
  ],
  [
    [0.567, 0.433, 0],
    [0.558, 0.442, 0],
    [0, 0.242, 0.758],
  ],
  [
    [0.95, 0.05, 0],
    [0, 0.433, 0.567],
    [0, 0.475, 0.525],
  ],
];

const toLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const toByte = (c: number): number => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};

function simulate(rgb: Rgb, matrix: readonly (readonly number[])[]): Rgb {
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  return [
    toByte(matrix[0]![0]! * r + matrix[0]![1]! * g + matrix[0]![2]! * b),
    toByte(matrix[1]![0]! * r + matrix[1]![1]! * g + matrix[1]![2]! * b),
    toByte(matrix[2]![0]! * r + matrix[2]![1]! * g + matrix[2]![2]! * b),
  ];
}

/**
 * How different two colours look to the *least* favourable kind of vision.
 *
 * Taking the minimum across the simulations rather than the average is the point: a pair
 * that is vivid to most people and identical to a deuteranope is not a usable pair, and
 * an average would hide that behind three good scores.
 */
export function perceptualDistance(a: Rgb, b: Rgb): number {
  let worst = Infinity;
  for (const matrix of SIMULATIONS) {
    const [ar, ag, ab] = simulate(a, matrix);
    const [br, bg, bb] = simulate(b, matrix);
    const d = Math.hypot(ar - br, ag - bg, ab - bb);
    if (d < worst) worst = d;
  }
  return worst;
}

/**
 * Give every piece a colour that differs from all of its neighbours'.
 *
 * Greedy graph colouring: work through the pieces most-connected first, and give each one
 * the palette entry whose worst-case distance from its already-coloured neighbours is
 * largest. Greedy is enough here — the adjacency graph of a tiling is planar and sparse,
 * so with sixteen entries there is always a comfortable choice — and it runs in one pass
 * rather than searching.
 */
export function assignPieceColours(geometry: PuzzleGeometry): Rgb[] {
  const palette: Rgb[] = [];
  for (let i = 0; i < PALETTE_SIZE; i++) palette.push(paletteColour(i));

  // Pairwise distances once, rather than inside the inner loop.
  const gap: number[][] = palette.map((a) => palette.map((b) => perceptualDistance(a, b)));

  const chosen = new Int32Array(geometry.pieces.length).fill(-1);
  const order = [...geometry.pieces]
    .map((p) => p.id)
    .sort((a, b) => geometry.pieces[b]!.adjacent.length - geometry.pieces[a]!.adjacent.length);

  for (const id of order) {
    const neighbours = geometry.pieces[id]!.adjacent
      .map((n) => chosen[n]!)
      .filter((c) => c >= 0);

    let best = 0;
    let bestScore = -1;
    for (let entry = 0; entry < PALETTE_SIZE; entry++) {
      // The worst neighbour is what decides a candidate; a colour that is excellent
      // against three neighbours and identical to the fourth is a bad colour.
      let score = Infinity;
      for (const used of neighbours) score = Math.min(score, gap[entry]![used]!);
      if (neighbours.length === 0) score = 1000 - entry; // no constraint: keep it stable
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    chosen[id] = best;
  }

  return [...chosen].map((entry) => palette[entry]!);
}

/** The smallest gap between any two touching pieces. The number worth asserting. */
export function worstNeighbourGap(geometry: PuzzleGeometry, colours: readonly Rgb[]): number {
  let worst = Infinity;
  for (const piece of geometry.pieces) {
    for (const other of piece.adjacent) {
      const d = perceptualDistance(colours[piece.id]!, colours[other]!);
      if (d < worst) worst = d;
    }
  }
  return worst === Infinity ? 0 : worst;
}
