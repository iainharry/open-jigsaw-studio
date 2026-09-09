import { describe, expect, it } from 'vitest';
import {
  GLYPHS,
  GLYPH_GROUPS,
  LEGIBLE_COVERAGE,
  glyphCoverage,
  glyphGrid,
  glyphLabel,
  glyphMask,
  glyphMinGrid,
} from '../glyphs.js';
import { silhouetteGlyph, silhouetteMask, tile, tilingStats } from '../polyomino.js';

const names = Object.keys(GLYPHS);

/** Cells that are part of the glyph, as a fraction of the grid. */
const coverage = (mask: Uint8Array): number =>
  mask.reduce((n, v) => n + v, 0) / mask.length;

/** Sizes of every orthogonally connected run of glyph cells, largest first. */
function regions(mask: Uint8Array, rows: number, cols: number): number[] {
  const seen = new Uint8Array(mask.length);
  const found: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    let size = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const at = stack.pop()!;
      size++;
      const r = Math.floor(at / cols);
      const c = at % cols;
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const next = nr * cols + nc;
        if (mask[next] === 0 || seen[next] === 1) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    found.push(size);
  }
  return found.sort((a, b) => b - a);
}

const largestRegion = (mask: Uint8Array, rows: number, cols: number): number =>
  regions(mask, rows, cols)[0] ?? 0;

describe('glyph masks', () => {
  it('has every glyph in exactly one menu group', () => {
    const grouped = GLYPH_GROUPS.flatMap((g) => g.names);
    expect([...grouped].sort()).toEqual([...names].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('returns null for a name it does not have', () => {
    // Null rather than an empty mask: an unknown name arrives from a stale save file or a
    // link, and a board with no cells in it is unplayable and unexplainable.
    expect(glyphMask('wombat', 10, 8)).toBeNull();
  });

  /**
   * The assertion the whole module exists to satisfy.
   *
   * A stroke thinner than about two cells can only be filled by single squares and
   * dominoes, which turns a letter into a queue of scraps rather than a puzzle. Measured
   * by tiling each glyph for real and counting what came out, because thickness in
   * normalised units is a proxy and this is the thing itself.
   */
  it('tiles every glyph into real pieces rather than scraps', () => {
    const poor: string[] = [];
    for (const name of names) {
      const { rows, cols } = glyphGrid(name, 90);
      const tiling = tile(20260906, rows, cols, {
        targetCells: 4,
        silhouette: `glyph:${name}`,
      });
      const stats = tilingStats(tiling);
      if (stats.chunky < 0.78 || stats.singles > 2) {
        poor.push(`${name}: chunky=${stats.chunky.toFixed(2)} singles=${stats.singles}`);
      }
    }
    expect(poor).toEqual([]);
  });

  /**
   * The assertion that would have caught the feature shipping broken.
   *
   * Stroke thickness has a floor of two and a half cells so pieces are pieces rather than
   * scraps, and on a small grid that floor swells the strokes until they meet. Asked for
   * forty cells, `8`, `6`, `9`, `B` and `E` came back at coverage **1.00** — solid
   * rectangles with the right piece count. They passed a hand-drawn contact sheet because
   * most glyphs looked fine, and passed the first version of this test because it asked
   * for coverage under 0.9, which a solid block misses only by being solid.
   *
   * Checked at the *smallest* grid the glyph will ever be given, because that is where it
   * breaks, and at the grid a caller asking for very few cells actually receives.
   */
  it('never lets a glyph swell into a solid block', () => {
    for (const name of names) {
      if (!GLYPHS[name]!.strokes) continue;
      for (const asked of [10, 40, 90]) {
        const { rows, cols } = glyphGrid(name, asked);
        expect(glyphCoverage(name, rows, cols), `${name} at ${asked}`).toBeLessThanOrEqual(
          LEGIBLE_COVERAGE,
        );
      }
    }
  });

  it('never returns a grid too coarse to draw the glyph on', () => {
    for (const name of names) {
      const { rows } = glyphGrid(name, 4);
      // A C on eight rows is a blob with a notch and a star is a lumpy cross; coverage
      // says nothing about either, because being too thin is the opposite failure.
      expect(rows, name).toBeGreaterThanOrEqual(GLYPHS[name]!.strokes ? 10 : 8);
    }
  });

  it('never shrinks below a glyph\'s own minimum, however few cells are asked for', () => {
    for (const name of names) {
      const minimum = glyphMinGrid(name);
      const tiny = glyphGrid(name, 1);
      expect(tiny.rows, name).toBeGreaterThanOrEqual(minimum.rows);
      expect(tiny.cols, name).toBeGreaterThanOrEqual(minimum.cols);
    }
  });

  it('keeps every glyph connected and a sensible size', () => {
    for (const name of names) {
      const { rows, cols } = glyphGrid(name, 90);
      const mask = glyphMask(name, rows, cols)!;
      const filled = mask.reduce((n, v) => n + v, 0);
      // Enough cells to be a puzzle at all, and not so many that the outline has
      // swallowed the whole rectangle and stopped being a shape.
      expect(filled, name).toBeGreaterThanOrEqual(17);
      expect(coverage(mask), name).toBeLessThan(0.9);
      // Drawn in exactly the number of pieces the glyph says it is. An unintended
      // second island means a stroke that does not reach what it should join -- the G's
      // crossbar floated clear of its curve and looked almost right on screen.
      expect(regions(mask, rows, cols).length, name).toBe(GLYPHS[name]!.parts ?? 1);
    }
  });

  /**
   * `=` is the case that made this necessary: two bars a fixed distance apart, which
   * merged into one solid block once the minimum stroke thickness grew past the gap. It
   * was wrong in a way no assertion about "a mask was produced" could see.
   */
  it('keeps the two bars of an equals sign apart', () => {
    const { rows, cols } = glyphGrid('equals', 90);
    const mask = glyphMask('equals', rows, cols)!;
    const filled = mask.reduce((n, v) => n + v, 0);
    const bars = regions(mask, rows, cols);
    expect(bars.length).toBe(2);
    // Two bars of roughly equal size, rather than one fat bar and a stray cell.
    expect(bars[1]!).toBeGreaterThan(filled * 0.4);
  });

  it('gives a glyph a grid with its own proportions', () => {
    // An I is narrow and a W is wide; a shared square grid would make one spindly and the
    // other cramped.
    const narrow = glyphGrid('I', 90);
    const wide = glyphGrid('W', 90);
    expect(narrow.cols / narrow.rows).toBeLessThan(wide.cols / wide.rows);
  });

  it('scales to any grid without losing the glyph', () => {
    for (const cells of [1, 30, 60, 150, 400]) {
      const { rows, cols } = glyphGrid('5', cells);
      const mask = glyphMask('5', rows, cols)!;
      expect(mask.reduce((n, v) => n + v, 0), `${cells}`).toBeGreaterThan(12);
      expect(largestRegion(mask, rows, cols)).toBe(mask.reduce((n, v) => n + v, 0));
    }
  });

  it('labels single characters as themselves and words in plain English', () => {
    expect(glyphLabel('5')).toBe('5');
    expect(glyphLabel('A')).toBe('A');
    expect(glyphLabel('triangle')).toBe('Triangle');
    expect(glyphLabel('plus')).toContain('+');
  });
});

describe('glyphs as silhouettes', () => {
  it('recognises a glyph silhouette and a plain one', () => {
    expect(silhouetteGlyph('glyph:5')).toBe('5');
    expect(silhouetteGlyph('diamond')).toBeNull();
  });

  it('produces the same mask through the silhouette route', () => {
    const direct = glyphMask('A', 11, 9)!;
    const viaSilhouette = silhouetteMask(11, 9, 'glyph:A');
    expect([...viaSilhouette]).toEqual([...direct]);
  });

  /**
   * An unknown glyph falls back to the full rectangle, not to an empty board.
   *
   * This is reached from a save file or a link naming a glyph this build does not have —
   * an older version opening a newer code. A playable rectangle is a comprehensible
   * outcome; a board with no cells is a puzzle that cannot be started or explained.
   */
  it('falls back to a rectangle for a glyph this build does not know', () => {
    const mask = silhouetteMask(8, 8, 'glyph:wombat');
    expect(mask.reduce((n, v) => n + v, 0)).toBe(64);
  });

  it('caches without returning the same array twice', () => {
    // Handing out the cached buffer would let one caller's edit change another's board.
    const a = silhouetteMask(10, 8, 'glyph:7');
    const b = silhouetteMask(10, 8, 'glyph:7');
    expect(a).not.toBe(b);
    expect([...a]).toEqual([...b]);
    a[0] = a[0] === 1 ? 0 : 1;
    expect([...silhouetteMask(10, 8, 'glyph:7')]).toEqual([...b]);
  });
});
