import { describe, expect, it } from 'vitest';
import { kMeansOklab, oklabDistanceSq, oklabToRgb, rgbToOklab } from '../colour.js';
import { clusterColour, groupByColour, liveMembers } from '../colourSort.js';
import { clusterOf, createPuzzle, mergeClusters, type PuzzleState } from '../puzzle.js';
import { addToTray, createTray } from '../trays.js';

function puzzle(rows = 6, cols = 6): PuzzleState {
  return createPuzzle({ seed: 7, rows, cols, imageWidth: 600, imageHeight: 600 });
}

/** Give the top half of the grid one colour and the bottom half another. */
function twoBandColours(state: PuzzleState, top: [number, number, number], bottom: [number, number, number]): Float32Array {
  const out = new Float32Array(state.geometry.pieces.length * 3);
  for (const piece of state.geometry.pieces) {
    const rgb = piece.row < state.geometry.rows / 2 ? top : bottom;
    const lab = rgbToOklab(rgb[0], rgb[1], rgb[2]);
    out[piece.id * 3] = lab[0];
    out[piece.id * 3 + 1] = lab[1];
    out[piece.id * 3 + 2] = lab[2];
  }
  return out;
}

describe('OKLab conversion', () => {
  it('round-trips primaries and greys within a rounding step', () => {
    for (const rgb of [
      [0, 0, 0],
      [255, 255, 255],
      [128, 128, 128],
      [255, 0, 0],
      [0, 128, 255],
      [34, 177, 76],
    ] as const) {
      const back = oklabToRgb(rgbToOklab(rgb[0], rgb[1], rgb[2]));
      expect(Math.abs(back[0] - rgb[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(back[1] - rgb[1])).toBeLessThanOrEqual(1);
      expect(Math.abs(back[2] - rgb[2])).toBeLessThanOrEqual(1);
    }
  });

  it('puts black at L=0 and white at L=1', () => {
    expect(rgbToOklab(0, 0, 0)[0]).toBeCloseTo(0, 5);
    expect(rgbToOklab(255, 255, 255)[0]).toBeCloseTo(1, 3);
  });

  it('is perceptually saner than raw RGB distance', () => {
    // Two blues versus a blue and a dark grey. In sRGB the grey can win; it must not here.
    const blueA = rgbToOklab(40, 90, 200);
    const blueB = rgbToOklab(70, 120, 230);
    const grey = rgbToOklab(90, 90, 90);
    expect(oklabDistanceSq(blueA, blueB)).toBeLessThan(oklabDistanceSq(blueA, grey));
  });

  it('clamps out-of-gamut results rather than returning nonsense', () => {
    const [r, g, b] = oklabToRgb([2, 0.5, 0.5]);
    for (const v of [r, g, b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });
});

describe('kMeansOklab', () => {
  it('separates two obvious colour bands', () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) => ({ item: i, colour: rgbToOklab(30 + i, 60, 200) })),
      ...Array.from({ length: 8 }, (_, i) => ({ item: 100 + i, colour: rgbToOklab(220, 140 + i, 40) })),
    ];
    const groups = kMeansOklab(items, 2, 1);
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const allBlue = group.members.every((m) => m < 100);
      const allOrange = group.members.every((m) => m >= 100);
      expect(allBlue || allOrange).toBe(true);
    }
  });

  it('is deterministic for a given seed', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      item: i,
      colour: rgbToOklab((i * 37) % 256, (i * 91) % 256, (i * 53) % 256),
    }));
    const a = kMeansOklab(items, 5, 99).map((g) => g.members.join(','));
    const b = kMeansOklab(items, 5, 99).map((g) => g.members.join(','));
    expect(a).toEqual(b);
  });

  it('never loses an item', () => {
    const items = Array.from({ length: 33 }, (_, i) => ({
      item: i,
      colour: rgbToOklab((i * 17) % 256, (i * 5) % 256, 128),
    }));
    const groups = kMeansOklab(items, 6, 3);
    const seen = groups.flatMap((g) => g.members).sort((x, y) => x - y);
    expect(seen).toEqual(items.map((i) => i.item));
  });

  it('returns no empty groups even when k exceeds the distinct colours', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ item: i, colour: rgbToOklab(10, 20, 30) }));
    const groups = kMeansOklab(items, 6, 4);
    for (const g of groups) expect(g.members.length).toBeGreaterThan(0);
  });

  it('handles an empty input', () => {
    expect(kMeansOklab([], 4, 1)).toEqual([]);
  });
});

describe('groupByColour', () => {
  it('splits a two-colour picture into the two bands', () => {
    const s = puzzle();
    const colours = twoBandColours(s, [40, 90, 200], [220, 150, 50]);
    const groups = groupByColour(s, colours, { groups: 2 });

    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const rows = new Set(
        group.clusterIds.map((id) => s.geometry.pieces[s.clusters.get(id)!.pieces[0]!]!.row < 3),
      );
      expect(rows.size).toBe(1);
    }
  });

  it('orders groups largest first', () => {
    const s = puzzle();
    const colours = twoBandColours(s, [40, 90, 200], [220, 150, 50]);
    // Make the top band bigger by recolouring one bottom row to the top colour.
    for (const piece of s.geometry.pieces) {
      if (piece.row === 3) {
        const lab = rgbToOklab(40, 90, 200);
        colours[piece.id * 3] = lab[0];
        colours[piece.id * 3 + 1] = lab[1];
        colours[piece.id * 3 + 2] = lab[2];
      }
    }
    const groups = groupByColour(s, colours, { groups: 2 });
    expect(groups[0]!.pieces).toBeGreaterThan(groups[1]!.pieces);
  });

  it('skips clusters already in a tray', () => {
    const s = puzzle();
    const colours = twoBandColours(s, [40, 90, 200], [220, 150, 50]);
    const trayed = [0, 1, 2].map((p) => clusterOf(s, p).id);
    const tray = createTray(s, { x: 2000, y: 2000 });
    addToTray(s, tray.id, trayed);

    const groups = groupByColour(s, colours, { groups: 2 });
    const listed = new Set(groups.flatMap((g) => g.clusterIds));
    for (const id of trayed) expect(listed.has(id)).toBe(false);
  });

  it('gives a joined cluster the mean colour of its pieces', () => {
    const s = puzzle();
    const colours = twoBandColours(s, [40, 90, 200], [220, 150, 50]);
    // Join a top-band piece to a bottom-band one: the result should sit between them.
    mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 30).id);
    const mixed = clusterColour(s, colours, clusterOf(s, 0).id)!;
    const blue = rgbToOklab(40, 90, 200);
    const orange = rgbToOklab(220, 150, 50);
    expect(mixed[0]).toBeGreaterThan(Math.min(blue[0], orange[0]));
    expect(mixed[0]).toBeLessThan(Math.max(blue[0], orange[0]));
  });

  it('reports a piece count, not just a cluster count', () => {
    const s = puzzle();
    const colours = twoBandColours(s, [40, 90, 200], [220, 150, 50]);
    mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 1).id);
    const groups = groupByColour(s, colours, { groups: 2 });
    const total = groups.reduce((sum, g) => sum + g.pieces, 0);
    expect(total).toBe(s.geometry.pieces.length);
  });

  it('is stable across repeated sorts of the same puzzle', () => {
    const s = puzzle();
    const colours = twoBandColours(s, [40, 90, 200], [220, 150, 50]);
    const a = groupByColour(s, colours, { groups: 4 }).map((g) => g.clusterIds.join(','));
    const b = groupByColour(s, colours, { groups: 4 }).map((g) => g.clusterIds.join(','));
    expect(a).toEqual(b);
  });
});

describe('liveMembers', () => {
  it('drops members that have been trayed or merged away since the sort', () => {
    const s = puzzle();
    const colours = twoBandColours(s, [40, 90, 200], [220, 150, 50]);
    const groups = groupByColour(s, colours, { groups: 2 });
    const group = groups[0]!;

    const trayed = group.clusterIds[0]!;
    const tray = createTray(s, { x: 3000, y: 3000 });
    addToTray(s, tray.id, [trayed]);

    const live = liveMembers(s, group);
    expect(live).not.toContain(trayed);
    expect(live.length).toBe(group.clusterIds.length - 1);
    for (const id of live) expect(s.clusters.has(id)).toBe(true);
  });
});
