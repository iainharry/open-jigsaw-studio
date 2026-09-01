/**
 * Deterministic pseudo-random number generation.
 *
 * `Math.random()` must never appear in the engine: puzzle geometry has to be
 * reproducible from a seed alone, so that save files can store the seed instead
 * of the geometry and a shared puzzle regenerates identically on another device.
 */

/** mulberry32 — small, fast, good enough distribution for geometry jitter. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive a stable child seed from a parent seed and coordinates.
 *
 * This lets every edge in the puzzle draw from its own independent stream, so
 * geometry does not depend on the order edges happen to be generated in. That
 * property matters: it means we can later generate geometry lazily, or in
 * parallel, without changing the result.
 */
export function deriveSeed(seed: number, ...coords: number[]): number {
  // FNV-1a over the seed and coordinates.
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (const c of coords) {
    let v = c | 0;
    for (let i = 0; i < 4; i++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      v >>>= 8;
    }
  }
  return h >>> 0;
}

/** Uniform float in [min, max). */
export function range(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Convert an arbitrary user-supplied string into a numeric seed. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A fresh random seed, for when the user has not supplied one. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
