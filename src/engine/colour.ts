/**
 * Colour maths for sorting pieces.
 *
 * Grouping happens in OKLab, not RGB. Euclidean distance in sRGB does not match what the
 * eye considers "similar" — it will happily put a mid-blue closer to a dark grey than to
 * another blue — and the whole value of a colour sort is that the groups look like groups
 * to a person. OKLab is near-perceptually-uniform, so plain distance in it behaves.
 *
 * Pure maths over plain numbers, so it tests in Node with no canvas. Sampling the actual
 * image needs a canvas and therefore lives in `src/render/pieceColours.ts`.
 */

import { makeRng } from './rng.js';

export type Oklab = readonly [L: number, a: number, b: number];

function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function fromLinear(v: number): number {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

/** sRGB (0-255) to OKLab. */
export function rgbToOklab(r: number, g: number, b: number): Oklab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

/** OKLab back to sRGB (0-255), clamped. Used for the swatch beside each group. */
export function oklabToRgb(colour: Oklab): [number, number, number] {
  const [L, A, B] = colour;
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export function oklabDistanceSq(a: Oklab, b: Oklab): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

export interface ColourCluster<T> {
  members: T[];
  centre: Oklab;
}

/**
 * k-means with k-means++ seeding, in OKLab.
 *
 * Seeded rather than using `Math.random()`, so pressing "sort by colour" twice on the same
 * puzzle gives the same groups. A sort that reshuffled every time would be maddening when
 * you are working through the groups one at a time.
 *
 * Empty clusters are re-seeded to the point furthest from its own centre, which is what
 * stops a bad initial pick collapsing k groups into k-1.
 */
export function kMeansOklab<T>(
  items: readonly { item: T; colour: Oklab }[],
  k: number,
  seed: number,
  maxIterations = 40,
): ColourCluster<T>[] {
  if (items.length === 0) return [];
  const groups = Math.max(1, Math.min(k, items.length));
  const rng = makeRng(seed);

  // --- k-means++ seeding ---
  const centres: Oklab[] = [items[Math.floor(rng() * items.length)]!.colour];
  while (centres.length < groups) {
    const distances = items.map((it) =>
      Math.min(...centres.map((c) => oklabDistanceSq(it.colour, c))),
    );
    const total = distances.reduce((sum, d) => sum + d, 0);
    if (total <= 0) {
      centres.push(items[Math.floor(rng() * items.length)]!.colour);
      continue;
    }
    let pick = rng() * total;
    let chosen = items.length - 1;
    for (let i = 0; i < distances.length; i++) {
      pick -= distances[i]!;
      if (pick <= 0) {
        chosen = i;
        break;
      }
    }
    centres.push(items[chosen]!.colour);
  }

  // --- Lloyd iterations ---
  let assignment = new Int32Array(items.length).fill(-1);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;
    const next = new Int32Array(items.length);

    for (let i = 0; i < items.length; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = oklabDistanceSq(items[i]!.colour, centres[c]!);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      next[i] = best;
      if (assignment[i] !== best) changed = true;
    }
    assignment = next;
    if (!changed && iteration > 0) break;

    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < items.length; i++) {
      const bucket = sums[assignment[i]!]!;
      const colour = items[i]!.colour;
      bucket[0]! += colour[0];
      bucket[1]! += colour[1];
      bucket[2]! += colour[2];
      bucket[3]! += 1;
    }
    for (let c = 0; c < centres.length; c++) {
      const bucket = sums[c]!;
      if (bucket[3]! > 0) {
        centres[c] = [bucket[0]! / bucket[3]!, bucket[1]! / bucket[3]!, bucket[2]! / bucket[3]!];
      } else {
        // Nothing landed here. Re-seed on the worst-served point rather than leaving a
        // dead group, which would silently give the user fewer groups than they asked for.
        let worst = 0;
        let worstDistance = -1;
        for (let i = 0; i < items.length; i++) {
          const d = oklabDistanceSq(items[i]!.colour, centres[assignment[i]!]!);
          if (d > worstDistance) {
            worstDistance = d;
            worst = i;
          }
        }
        centres[c] = items[worst]!.colour;
      }
    }
  }

  const out: ColourCluster<T>[] = centres.map((centre) => ({ members: [], centre }));
  for (let i = 0; i < items.length; i++) out[assignment[i]!]!.members.push(items[i]!.item);
  return out.filter((g) => g.members.length > 0);
}
