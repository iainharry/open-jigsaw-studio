/**
 * How many pieces a picture can actually carry.
 *
 * `pieceCountLimits()` answers a different question — how small a piece may get before it
 * is more tab than picture — and it only looks at resolution. A 1536×1024 poster passes
 * that test at two thousand pieces. Cut one, though, and dozens of pieces are a single
 * flat colour with nothing on them at all.
 *
 * The number that matters is not how many pieces are blank; it is how many are blank **and
 * identical to another blank piece**. Those are interchangeable: nothing about the picture
 * distinguishes them, so there is no way to place one by looking. Measured across seven
 * classroom posters at five hundred pieces, that ran from 6% to 38% — the worst being a
 * sheet whose background is a third of its area.
 *
 * **Why this is advice and not a cap, and why it is not a recommended piece count
 * either.** The first version of this picked a "comfortable" count from the menu. Then it
 * was pointed at the app's own demo landscape — and rated it the worst picture in the
 * project: 27% interchangeable at a hundred pieces, 53% at five hundred, because its
 * hills are large flat silhouettes. That image has shipped as the default for eighteen
 * milestones and nobody has complained about it, so either the measurement is wrong or
 * the prescription was. The measurement is right; a 500-piece cut of that landscape really
 * would be a lot of identical near-black pieces. What was wrong was presuming to name a
 * number, and doing it loudly enough to fire on the default picture at the default count —
 * a warning nobody reads twice.
 *
 * So this reports a fact and leaves the judgement alone: *this many of your pieces are
 * blank and have identical twins*. And it matters enormously which cut is in use. With
 * tabs an interchangeable piece is tedious rather than impossible — exactly one socket
 * accepts it, so the geometry settles what the picture cannot. With flat edges there is no
 * geometry to fall back on and the picture is the only clue there is. The same board is
 * two different propositions, so it takes two different thresholds.
 *
 * Deliberately measured rather than tagged onto the bundled samples. A number recorded in
 * a manifest only protects the pictures somebody remembered to measure; this protects the
 * photograph a person imports on a Tuesday, which is most of them.
 *
 * Headless: it takes pixels and returns numbers, so it is tested in Node.
 */

/** Below this standard deviation in luminance, a piece has nothing on it. */
const FEATURELESS = 7;

/**
 * Two flat pieces closer than this in mean colour count as the same colour.
 *
 * Tight, so that "the same colour" means the same colour rather than merely similar.
 *
 * A note against a plausible mistake, because it was nearly made here: tightening this is
 * *not* what distinguishes a gradient sky from a flat fill. A gradient that shades from
 * navy to orange down the picture gives cells that are identical along each row — ten
 * pieces of one colour, ten of the next — and this rightly counts every one of them.
 * Tightening the threshold from 10 to 4 changed the demo landscape's rating not at all.
 * What makes that picture playable is texture: stars and tree silhouettes leave most cells
 * busy, so only about a quarter of them repeat.
 */
const SAME_COLOUR = 4;

/**
 * How many pieces must share a colour before it is a problem.
 *
 * Two pieces the same is a pair to try both ways round. Thirty the same is a region of the
 * puzzle with no information in it at all, and that is the thing worth warning about.
 */
const CROWD = 4;

/**
 * When to say something, by cut.
 *
 * Calibrated against eight real pictures rather than chosen. With tabs, the demo landscape
 * sits at 27% at its default hundred pieces and is perfectly playable, so the tabbed
 * threshold has to be well clear of that; 0.35 leaves eight points of margin and still
 * catches the alphabet poster at five hundred pieces (40%) and the landscape at two
 * hundred (43%), both of which are a slog. With flat edges the picture is all you have, so
 * the same 27% is worth a word.
 *
 * The tabbed number is the softer judgement of the two and is offered as such: between
 * about a third and a half of the pieces being blank repeats is tedious rather than
 * broken, and where exactly that tips is a matter of taste. The flat-edge number is not a
 * matter of taste — without tabs those pieces genuinely cannot be placed by looking.
 */
export const BLANKS_WITH_TABS = 0.35;
export const BLANKS_WITH_FLAT_EDGES = 0.22;

export interface DetailReport {
  /** Fraction of pieces with nothing on them. */
  readonly flat: number;
  /** Fraction of pieces that are blank *and* match another blank piece. */
  readonly interchangeable: number;
}

/**
 * Split a picture into a grid and see how much of it carries no information.
 *
 * `pixels` is RGBA, as `getImageData` hands it over. The grid is the one the cut would
 * use, so the answer is about the puzzle rather than about the picture in the abstract.
 */
export function measureDetail(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  rows: number,
  cols: number,
): DetailReport {
  const cells = rows * cols;
  if (cells === 0 || width === 0 || height === 0) return { flat: 0, interchangeable: 0 };

  const means: number[] = [];
  const flatIndex: number[] = [];

  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / rows));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * width) / cols));

      let n = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumL = 0;
      let sumL2 = 0;
      // Every fourth row and column. A flat region is flat wherever it is sampled, and
      // this is run for several candidate piece counts on a picture that may be five
      // thousand pixels across.
      for (let y = y0; y < y1; y += 4) {
        for (let x = x0; x < x1; x += 4) {
          const i = (y * width + x) * 4;
          const red = pixels[i]!;
          const green = pixels[i + 1]!;
          const blue = pixels[i + 2]!;
          const lum = 0.299 * red + 0.587 * green + 0.114 * blue;
          sumR += red;
          sumG += green;
          sumB += blue;
          sumL += lum;
          sumL2 += lum * lum;
          n++;
        }
      }
      if (n === 0) continue;
      const mean = sumL / n;
      const variance = Math.max(0, sumL2 / n - mean * mean);
      means.push(sumR / n, sumG / n, sumB / n);
      if (Math.sqrt(variance) < FEATURELESS) flatIndex.push(means.length / 3 - 1);
    }
  }

  // A piece counts as interchangeable when it belongs to a *crowd* of pieces sharing its
  // colour, not merely when one other piece resembles it.
  let interchangeable = 0;
  for (let a = 0; a < flatIndex.length; a++) {
    const ia = flatIndex[a]! * 3;
    let alike = 0;
    for (let b = 0; b < flatIndex.length; b++) {
      if (a === b) continue;
      const ib = flatIndex[b]! * 3;
      const d = Math.hypot(
        means[ia]! - means[ib]!,
        means[ia + 1]! - means[ib + 1]!,
        means[ia + 2]! - means[ib + 2]!,
      );
      if (d < SAME_COLOUR && ++alike >= CROWD - 1) {
        interchangeable++;
        break;
      }
    }
  }

  return { flat: flatIndex.length / cells, interchangeable: interchangeable / cells };
}
