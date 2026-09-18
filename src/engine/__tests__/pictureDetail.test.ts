import { describe, expect, it } from 'vitest';
import {
  BLANKS_WITH_FLAT_EDGES,
  BLANKS_WITH_TABS,
  measureDetail,
} from '../pictureDetail.js';

/** Build an RGBA buffer from a function giving a colour per pixel. */
function picture(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y);
      const i = (y * width + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
  return out;
}

describe('measureDetail', () => {
  it('calls a picture of one flat colour entirely interchangeable', () => {
    const flat = picture(240, 240, () => [200, 120, 60]);
    const report = measureDetail(flat, 240, 240, 10, 10);
    expect(report.flat).toBe(1);
    expect(report.interchangeable).toBe(1);
  });

  it('finds nothing wrong with noise', () => {
    // Every cell is busy, so nothing is blank and nothing repeats.
    let seed = 7;
    const noise = picture(240, 240, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = seed % 256;
      return [v, (v * 7) % 256, (v * 13) % 256];
    });
    const report = measureDetail(noise, 240, 240, 10, 10);
    expect(report.flat).toBe(0);
    expect(report.interchangeable).toBe(0);
  });

  /**
   * The thing that makes a picture playable is texture, not smoothness.
   *
   * This started life as a test that a gradient is fine and a fill is not — and it failed,
   * correctly. A gradient shading down the picture gives rows of identical cells and is
   * every bit as interchangeable as a fill; the tight colour threshold does not and cannot
   * distinguish them, and claiming it did was a rationale invented to fit a number.
   *
   * What actually saves the app's demo landscape is that stars and tree silhouettes leave
   * most of its cells busy. So that is what is asserted: texture over a gradient rescues
   * it, and a bare gradient is not rescued.
   */
  it('counts a bare gradient as repetitive, and texture over it as not', () => {
    const size = 240;
    const shade = (y: number): [number, number, number] => {
      const t = y / size;
      return [Math.round(20 + 200 * t), Math.round(40 + 150 * t), Math.round(120 + 80 * t)];
    };
    const bare = picture(size, size, (_x, y) => shade(y));

    let seed = 11;
    const textured = picture(size, size, (_x, y) => {
      const [r, g, b] = shade(y);
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = (seed % 90) - 45;
      return [r + n, g + n, b + n];
    });

    expect(measureDetail(bare, size, size, 10, 10).interchangeable).toBeGreaterThan(0.8);
    expect(measureDetail(textured, size, size, 10, 10).interchangeable).toBe(0);
  });

  it('calls a flat fill entirely interchangeable however it is cut', () => {
    const fill = picture(240, 240, () => [120, 140, 190]);
    for (const [rows, cols] of [
      [4, 4],
      [10, 10],
      [16, 12],
    ] as const) {
      expect(measureDetail(fill, 240, 240, rows, cols).interchangeable).toBe(1);
    }
  });

  it('counts a crowd of identical pieces, not a lone pair', () => {
    // Two cells share a colour; the rest are busy. A pair is something to try both ways
    // round, not a region with no information in it.
    const size = 240;
    const cell = size / 10;
    let seed = 3;
    const mostlyBusy = picture(size, size, (x, y) => {
      const col = Math.floor(x / cell);
      const row = Math.floor(y / cell);
      if (row === 0 && (col === 0 || col === 5)) return [90, 90, 90];
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = seed % 256;
      return [v, (v * 5) % 256, (v * 11) % 256];
    });
    expect(measureDetail(mostlyBusy, size, size, 10, 10).interchangeable).toBe(0);
  });

  it('survives a grid with no pixels to sample', () => {
    expect(measureDetail(new Uint8ClampedArray(0), 0, 0, 4, 4)).toEqual({
      flat: 0,
      interchangeable: 0,
    });
  });

  /**
   * Flat edges take the picture's word for everything, tabs do not. The two thresholds
   * exist because the same board is two different puzzles, and if they ever converge the
   * distinction has quietly been lost.
   */
  it('asks much more of a picture when the edges are flat', () => {
    expect(BLANKS_WITH_FLAT_EDGES).toBeLessThan(BLANKS_WITH_TABS);
    // The demo landscape measures 27% at its default hundred pieces and is perfectly
    // playable with tabs, so the tabbed threshold must stay clear of it or the app warns
    // about its own front page.
    expect(BLANKS_WITH_TABS).toBeGreaterThan(0.3);
  });
});
