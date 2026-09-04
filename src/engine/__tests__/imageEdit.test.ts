import { describe, expect, it } from 'vitest';
import {
  applyAspect,
  clampCrop,
  DEFAULT_EDIT,
  editFilter,
  editedSize,
  effectiveCrop,
  isUneditedImage,
  largestInscribedRect,
  turnedSize,
  usableArea,
  type ImageEdit,
} from '../imageEdit.js';

const edit = (over: Partial<ImageEdit> = {}): ImageEdit => ({ ...DEFAULT_EDIT, ...over });

describe('turnedSize', () => {
  it('swaps the sides on a quarter turn', () => {
    expect(turnedSize(4000, 3000, 0)).toEqual({ width: 4000, height: 3000 });
    expect(turnedSize(4000, 3000, 1)).toEqual({ width: 3000, height: 4000 });
    expect(turnedSize(4000, 3000, 2)).toEqual({ width: 4000, height: 3000 });
    expect(turnedSize(4000, 3000, 3)).toEqual({ width: 3000, height: 4000 });
  });
});

describe('largestInscribedRect', () => {
  it('returns the whole rectangle at zero rotation', () => {
    expect(largestInscribedRect(800, 600, 0)).toEqual({ width: 800, height: 600 });
  });

  it('shrinks as the angle grows', () => {
    const a = largestInscribedRect(800, 600, (2 * Math.PI) / 180);
    const b = largestInscribedRect(800, 600, (8 * Math.PI) / 180);
    expect(a.width).toBeLessThan(800);
    expect(b.width).toBeLessThan(a.width);
    expect(b.height).toBeLessThan(a.height);
  });

  it('is symmetric for equal positive and negative angles', () => {
    const p = largestInscribedRect(1000, 700, (5 * Math.PI) / 180);
    const n = largestInscribedRect(1000, 700, (-5 * Math.PI) / 180);
    expect(p.width).toBeCloseTo(n.width, 9);
    expect(p.height).toBeCloseTo(n.height, 9);
  });

  it('actually fits inside the rotated rectangle', () => {
    // Every corner of the result, rotated back, must sit within the original frame.
    for (const angleDeg of [1, 3, 7, 12, 20]) {
      const W = 1200;
      const H = 800;
      const a = (angleDeg * Math.PI) / 180;
      const { width: w, height: h } = largestInscribedRect(W, H, a);
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const x = (sx * w) / 2;
        const y = (sy * h) / 2;
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        expect(Math.abs(rx)).toBeLessThanOrEqual(W / 2 + 1e-6);
        expect(Math.abs(ry)).toBeLessThanOrEqual(H / 2 + 1e-6);
      }
    }
  });

  it('copes with a square, where the two constraint cases meet', () => {
    const r = largestInscribedRect(500, 500, (10 * Math.PI) / 180);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.width).toBeLessThan(500);
  });

  it('returns nothing for a degenerate rectangle', () => {
    expect(largestInscribedRect(0, 100, 0.2)).toEqual({ width: 0, height: 0 });
  });
});

describe('usableArea', () => {
  it('is the whole image when unedited', () => {
    expect(usableArea(1600, 900, edit())).toEqual({ x: 0, y: 0, w: 1600, h: 900 });
  });

  it('accounts for a quarter turn', () => {
    const area = usableArea(1600, 900, edit({ turns: 1 }));
    expect(area.w).toBe(900);
    expect(area.h).toBe(1600);
  });

  it('insets and stays centred when straightened', () => {
    const area = usableArea(1600, 900, edit({ straighten: 6 }));
    expect(area.w).toBeLessThan(1600);
    expect(area.h).toBeLessThan(900);
    expect(area.x).toBeCloseTo((1600 - area.w) / 2, 6);
    expect(area.y).toBeCloseTo((900 - area.h) / 2, 6);
  });
});

describe('clampCrop', () => {
  const bounds = { x: 0, y: 0, w: 1000, h: 800 };

  it('pushes a crop back inside', () => {
    const c = clampCrop({ x: 900, y: 700, w: 400, h: 300 }, bounds);
    expect(c.x + c.w).toBeLessThanOrEqual(1000);
    expect(c.y + c.h).toBeLessThanOrEqual(800);
  });

  it('shrinks a crop larger than the bounds', () => {
    const c = clampCrop({ x: -50, y: -50, w: 5000, h: 5000 }, bounds);
    expect(c).toEqual({ x: 0, y: 0, w: 1000, h: 800 });
  });

  it('respects a minimum size', () => {
    const c = clampCrop({ x: 10, y: 10, w: 1, h: 1 }, bounds, 20);
    expect(c.w).toBe(20);
    expect(c.h).toBe(20);
  });

  it('honours an offset bounds rectangle', () => {
    const inset = { x: 100, y: 50, w: 400, h: 300 };
    const c = clampCrop({ x: 0, y: 0, w: 200, h: 150 }, inset);
    expect(c.x).toBeGreaterThanOrEqual(100);
    expect(c.y).toBeGreaterThanOrEqual(50);
  });
});

describe('applyAspect', () => {
  const bounds = { x: 0, y: 0, w: 1600, h: 900 };

  it('reshapes to the requested ratio', () => {
    const c = applyAspect({ x: 200, y: 200, w: 600, h: 600 }, 16 / 9, bounds);
    expect(c.w / c.h).toBeCloseTo(16 / 9, 4);
  });

  it('keeps the crop inside the bounds', () => {
    const c = applyAspect({ x: 0, y: 0, w: 1600, h: 900 }, 3 / 4, bounds);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(1600 + 1e-6);
    expect(c.y + c.h).toBeLessThanOrEqual(900 + 1e-6);
    expect(c.w / c.h).toBeCloseTo(3 / 4, 4);
  });

  it('keeps the centre where it was', () => {
    const before = { x: 400, y: 300, w: 400, h: 400 };
    const c = applyAspect(before, 1, bounds);
    expect(c.x + c.w / 2).toBeCloseTo(before.x + before.w / 2, 4);
    expect(c.y + c.h / 2).toBeCloseTo(before.y + before.h / 2, 4);
  });

  it('leaves the shape alone for Free', () => {
    const before = { x: 10, y: 20, w: 300, h: 111 };
    expect(applyAspect(before, null, bounds)).toEqual(before);
  });

  it('handles a ratio the bounds cannot fit widthwise', () => {
    const tall = { x: 0, y: 0, w: 400, h: 2000 };
    const c = applyAspect({ x: 0, y: 0, w: 400, h: 400 }, 16 / 9, tall);
    expect(c.w).toBeLessThanOrEqual(400 + 1e-6);
    expect(c.w / c.h).toBeCloseTo(16 / 9, 4);
  });
});

describe('editedSize', () => {
  it('is the source size when unedited and under the cap', () => {
    expect(editedSize(1600, 900, edit(), 5000)).toEqual({ width: 1600, height: 900 });
  });

  it('caps the long edge', () => {
    const s = editedSize(6000, 4000, edit(), 5000);
    expect(Math.max(s.width, s.height)).toBe(5000);
    expect(s.width / s.height).toBeCloseTo(1.5, 3);
  });

  it('a crop can bring a big photo under the cap', () => {
    const s = editedSize(6000, 4000, edit({ crop: { x: 0, y: 0, w: 2000, h: 1500 } }), 5000);
    expect(s).toEqual({ width: 2000, height: 1500 });
  });

  it('swaps sides on a quarter turn', () => {
    const s = editedSize(1600, 900, edit({ turns: 1 }), 5000);
    expect(s).toEqual({ width: 900, height: 1600 });
  });
});

describe('effectiveCrop', () => {
  it('falls back to the whole usable area', () => {
    expect(effectiveCrop(800, 600, edit())).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('clamps a stored crop that no longer fits after straightening', () => {
    const full = { x: 0, y: 0, w: 800, h: 600 };
    const c = effectiveCrop(800, 600, edit({ crop: full, straighten: 10 }));
    const area = usableArea(800, 600, edit({ straighten: 10 }));
    expect(c.x).toBeGreaterThanOrEqual(area.x - 1e-6);
    expect(c.y).toBeGreaterThanOrEqual(area.y - 1e-6);
    expect(c.x + c.w).toBeLessThanOrEqual(area.x + area.w + 1e-6);
    expect(c.y + c.h).toBeLessThanOrEqual(area.y + area.h + 1e-6);
  });
});

describe('editFilter', () => {
  it('is empty when nothing is adjusted', () => {
    expect(editFilter(edit())).toBe('');
  });

  it('builds a CSS filter for each adjustment', () => {
    const f = editFilter(edit({ brightness: 10, contrast: -20, saturation: 50 }));
    expect(f).toContain('brightness(1.1)');
    expect(f).toContain('contrast(0.8)');
    expect(f).toContain('saturate(1.5)');
  });
});

describe('isUneditedImage', () => {
  it('recognises an untouched edit and any change to it', () => {
    expect(isUneditedImage(edit())).toBe(true);
    expect(isUneditedImage(edit({ turns: 1 }))).toBe(false);
    expect(isUneditedImage(edit({ straighten: 0.5 }))).toBe(false);
    expect(isUneditedImage(edit({ flipH: true }))).toBe(false);
    expect(isUneditedImage(edit({ brightness: 1 }))).toBe(false);
    expect(isUneditedImage(edit({ crop: { x: 0, y: 0, w: 10, h: 10 } }))).toBe(false);
  });
});
