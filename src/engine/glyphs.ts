/**
 * Outlines shaped like letters, digits, shapes, operators and arrows.
 *
 * The puzzle already fills a named outline — a diamond, a cross, a frame — with L's,
 * T's and pentominoes. Making that outline a **5**, or a triangle, or the letter **A**
 * turns the same mechanic into something a five-year-old is doing for a reason: they are
 * not looking at a picture of a five, they are making one out of pieces.
 *
 * Deliberately untagged. An earlier plan for this content carried curriculum identifiers,
 * and they were a liability twice over: they date (Victoria replaced its mathematics
 * codes wholesale in 2025, so a resource citing the old ones is visibly stale), and they
 * are jurisdiction-locked — a Victorian code means nothing in New South Wales and less
 * again outside Australia. "Fill the outline of a 5" needs no maintenance and no
 * footnote.
 *
 * **Why strokes and polygons rather than a bitmap font.** The obvious approach is a small
 * pixel grid per glyph, scaled up. It fails on the thing that matters here: a stroke that
 * lands one cell wide can only be filled by single squares, so the letter becomes a line
 * of scraps instead of a puzzle. Thickness has to be a *parameter* that adapts to the
 * grid, and that means describing a glyph as geometry and rasterising it, not as pixels.
 * The rasteriser guarantees at least two cells of thickness at any size.
 *
 * Headless, like everything in `src/engine`: distances between points, tested in Node.
 */

/**
 * A point in the glyph's own box. Deliberately a tuple and deliberately not the engine's
 * `Point`, which is `{x, y}` in image space: these are normalised coordinates in a unit
 * square, and giving them the same name as pixels would invite exactly the confusion the
 * type system is there to prevent.
 */
export type GlyphPoint = readonly [number, number];

/**
 * One glyph, in a normalised box: x runs 0 (left) to 1 (right), y runs 0 (top) to 1
 * (bottom). Normalised rather than sized, because the grid it has to fill is not known
 * until someone chooses a puzzle size.
 */
export interface Glyph {
  /** Open polylines, drawn with thickness. Letters, digits and operators are these. */
  readonly strokes?: readonly (readonly GlyphPoint[])[];
  /** Closed polygons, filled. Shapes and arrowheads are these. */
  readonly fills?: readonly (readonly GlyphPoint[])[];
  /**
   * Width divided by height, for choosing a sensible grid.
   *
   * A letter squeezed into a square grid is a fat letter; the caller uses this to pick
   * rows and columns that suit the glyph rather than the window.
   */
  readonly aspect: number;
  /** Relative stroke weight. Heavier for glyphs that would otherwise look spindly. */
  readonly weight?: number;
  /**
   * Fewest rows this glyph survives.
   *
   * Not decoration: `=` is two bars a fixed distance apart, and once the minimum stroke
   * thickness grows past that gap the two bars merge into one solid block — a glyph that
   * is unmistakably wrong and silently so. A floor on rows is what keeps the gap wider
   * than the strokes either side of it.
   */
  readonly minRows?: number;
  /**
   * How many separate pieces the glyph is drawn in. One unless stated.
   *
   * Declared rather than inferred so a test can hold every glyph to it. A letter that
   * falls into two islands is a drawing mistake — the G did exactly that, its crossbar
   * floating clear of the curve — and without a declared number the only way to catch it
   * is to notice, which is the failure mode this project keeps repeating.
   */
  readonly parts?: number;
}

/** Points along an elliptical arc. Angles in degrees, clockwise from three o'clock. */
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  steps = 16,
): GlyphPoint[] {
  const out: GlyphPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/** A regular polygon, first vertex pointing up. */
function regular(sides: number, cx = 0.5, cy = 0.52, r = 0.47): GlyphPoint[] {
  const out: GlyphPoint[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

function star(points = 5, cx = 0.5, cy = 0.54, outer = 0.5, inner = 0.245): GlyphPoint[] {
  const out: GlyphPoint[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** An arrow pointing up, as one polygon. Rotated by the caller for the other three. */
const ARROW_UP: GlyphPoint[] = [
  [0.5, 0.04],
  [0.96, 0.5],
  [0.68, 0.5],
  [0.68, 0.96],
  [0.32, 0.96],
  [0.32, 0.5],
  [0.04, 0.5],
];

/** Turn a polygon by quarter turns about the centre of the box. */
function turn(points: readonly GlyphPoint[], quarters: number): GlyphPoint[] {
  let out = points.map(([x, y]) => [x, y] as GlyphPoint);
  for (let i = 0; i < ((quarters % 4) + 4) % 4; i++) {
    out = out.map(([x, y]) => [1 - y, x] as GlyphPoint);
  }
  return out;
}

const LETTERS: Readonly<Record<string, Glyph>> = {
  A: { aspect: 0.8, strokes: [[[0.06, 1], [0.5, 0], [0.94, 1]], [[0.22, 0.66], [0.78, 0.66]]] },
  B: {
    aspect: 0.78,
    strokes: [
      [[0.16, 0], [0.16, 1]],
      [[0.16, 0], [0.62, 0], [0.86, 0.14], [0.86, 0.35], [0.62, 0.5], [0.16, 0.5]],
      [[0.16, 0.5], [0.68, 0.5], [0.92, 0.66], [0.92, 0.86], [0.68, 1], [0.16, 1]],
    ],
  },
  C: { aspect: 0.85, strokes: [arc(0.52, 0.5, 0.44, 0.5, -55, -305, 20)] },
  D: {
    aspect: 0.82,
    strokes: [
      [[0.16, 0], [0.16, 1]],
      [[0.16, 0], [0.58, 0], [0.9, 0.26], [0.9, 0.74], [0.58, 1], [0.16, 1]],
    ],
  },
  E: {
    aspect: 0.72,
    strokes: [
      [[0.18, 0], [0.18, 1]],
      [[0.18, 0], [0.88, 0]],
      [[0.18, 0.5], [0.74, 0.5]],
      [[0.18, 1], [0.88, 1]],
    ],
  },
  F: {
    aspect: 0.7,
    strokes: [[[0.18, 0], [0.18, 1]], [[0.18, 0], [0.88, 0]], [[0.18, 0.5], [0.74, 0.5]]],
  },
  G: {
    aspect: 0.86,
    // One stroke, not an arc plus a floating bar. Drawn as two the crossbar never
    // reached the curve, and the letter was two disconnected islands -- which reads as a
    // slightly odd G on screen and is a puzzle in two unrelated halves.
    strokes: [
      [...arc(0.52, 0.5, 0.44, 0.5, -55, -305, 20), [0.94, 0.78], [0.94, 0.5], [0.58, 0.5]],
    ],
  },
  H: {
    aspect: 0.8,
    strokes: [[[0.16, 0], [0.16, 1]], [[0.84, 0], [0.84, 1]], [[0.16, 0.5], [0.84, 0.5]]],
  },
  I: {
    aspect: 0.55,
    strokes: [[[0.5, 0], [0.5, 1]], [[0.18, 0], [0.82, 0]], [[0.18, 1], [0.82, 1]]],
  },
  J: { aspect: 0.62, strokes: [[[0.74, 0], [0.74, 0.74], [0.52, 0.97], [0.24, 0.84]]] },
  K: {
    aspect: 0.78,
    strokes: [[[0.18, 0], [0.18, 1]], [[0.9, 0], [0.2, 0.54]], [[0.38, 0.42], [0.92, 1]]],
  },
  L: { aspect: 0.66, strokes: [[[0.2, 0], [0.2, 1], [0.88, 1]]] },
  M: { aspect: 0.95, strokes: [[[0.1, 1], [0.1, 0], [0.5, 0.58], [0.9, 0], [0.9, 1]]] },
  N: { aspect: 0.85, strokes: [[[0.15, 1], [0.15, 0], [0.85, 1], [0.85, 0]]] },
  O: { aspect: 0.9, strokes: [arc(0.5, 0.5, 0.44, 0.5, 0, 360, 24)] },
  P: {
    aspect: 0.76,
    strokes: [
      [[0.18, 0], [0.18, 1]],
      [[0.18, 0], [0.66, 0], [0.9, 0.16], [0.9, 0.4], [0.66, 0.56], [0.18, 0.56]],
    ],
  },
  Q: {
    aspect: 0.9,
    strokes: [arc(0.5, 0.48, 0.42, 0.48, 0, 360, 24), [[0.6, 0.68], [0.94, 1]]],
  },
  R: {
    aspect: 0.8,
    strokes: [
      [[0.18, 0], [0.18, 1]],
      [[0.18, 0], [0.66, 0], [0.9, 0.16], [0.9, 0.4], [0.66, 0.56], [0.18, 0.56]],
      [[0.46, 0.56], [0.92, 1]],
    ],
  },
  S: {
    aspect: 0.76,
    strokes: [
      [
        [0.9, 0.16],
        [0.66, 0.02],
        [0.3, 0.04],
        [0.14, 0.2],
        [0.2, 0.4],
        [0.5, 0.5],
        [0.8, 0.6],
        [0.88, 0.78],
        [0.72, 0.96],
        [0.34, 0.98],
        [0.12, 0.86],
      ],
    ],
  },
  T: { aspect: 0.8, strokes: [[[0.5, 0], [0.5, 1]], [[0.1, 0], [0.9, 0]]] },
  U: {
    aspect: 0.82,
    strokes: [[[0.15, 0], [0.15, 0.68], [0.36, 0.96], [0.64, 0.96], [0.85, 0.68], [0.85, 0]]],
  },
  V: { aspect: 0.85, strokes: [[[0.08, 0], [0.5, 1], [0.92, 0]]] },
  W: { aspect: 1.05, strokes: [[[0.04, 0], [0.28, 1], [0.5, 0.42], [0.72, 1], [0.96, 0]]] },
  X: { aspect: 0.82, strokes: [[[0.1, 0], [0.9, 1]], [[0.9, 0], [0.1, 1]]] },
  Y: {
    aspect: 0.82,
    strokes: [[[0.1, 0], [0.5, 0.5]], [[0.9, 0], [0.5, 0.5]], [[0.5, 0.5], [0.5, 1]]],
  },
  Z: { aspect: 0.78, strokes: [[[0.12, 0], [0.88, 0], [0.12, 1], [0.88, 1]]] },
};

const DIGITS: Readonly<Record<string, Glyph>> = {
  '0': { aspect: 0.72, strokes: [arc(0.5, 0.5, 0.36, 0.5, 0, 360, 24)] },
  '1': { aspect: 0.6, strokes: [[[0.24, 0.22], [0.52, 0.02], [0.52, 1]], [[0.18, 1], [0.86, 1]]] },
  '2': {
    aspect: 0.72,
    strokes: [
      [[0.12, 0.24], [0.3, 0.03], [0.66, 0.03], [0.88, 0.24], [0.82, 0.5], [0.12, 1], [0.9, 1]],
    ],
  },
  '3': {
    aspect: 0.72,
    strokes: [
      [[0.12, 0.14], [0.36, 0.02], [0.7, 0.05], [0.86, 0.24], [0.62, 0.46]],
      [[0.48, 0.46], [0.84, 0.6], [0.88, 0.82], [0.62, 0.99], [0.18, 0.9]],
    ],
  },
  '4': { aspect: 0.78, strokes: [[[0.7, 0], [0.1, 0.7], [0.94, 0.7]], [[0.7, 0.36], [0.7, 1]]] },
  '5': {
    aspect: 0.72,
    strokes: [
      [
        [0.86, 0.03],
        [0.24, 0.03],
        [0.18, 0.42],
        [0.54, 0.34],
        [0.86, 0.54],
        [0.84, 0.84],
        [0.54, 1],
        [0.16, 0.9],
      ],
    ],
  },
  '6': {
    aspect: 0.72,
    strokes: [
      [[0.82, 0.06], [0.44, 0.06], [0.18, 0.36], [0.14, 0.7]],
      arc(0.5, 0.7, 0.36, 0.3, 180, 540, 20),
    ],
  },
  '7': { aspect: 0.72, strokes: [[[0.1, 0.03], [0.9, 0.03], [0.42, 1]]] },
  '8': {
    aspect: 0.72,
    strokes: [arc(0.5, 0.24, 0.32, 0.24, 0, 360, 18), arc(0.5, 0.74, 0.38, 0.26, 0, 360, 18)],
  },
  '9': {
    aspect: 0.72,
    strokes: [
      arc(0.5, 0.3, 0.36, 0.3, 0, 360, 20),
      [[0.86, 0.3], [0.82, 0.66], [0.56, 0.94], [0.18, 0.94]],
    ],
  },
};

const SHAPES: Readonly<Record<string, Glyph>> = {
  triangle: { aspect: 1.05, fills: [[[0.5, 0.04], [0.98, 0.94], [0.02, 0.94]]] },
  square: { aspect: 1, fills: [[[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]]] },
  pentagon: { aspect: 1, fills: [regular(5)] },
  hexagon: { aspect: 1, fills: [regular(6)] },
  octagon: { aspect: 1, fills: [regular(8)] },
  rhombus: { aspect: 1, fills: [[[0.5, 0.03], [0.97, 0.5], [0.5, 0.97], [0.03, 0.5]]] },
  trapezium: { aspect: 1.15, fills: [[[0.26, 0.1], [0.74, 0.1], [0.97, 0.9], [0.03, 0.9]]] },
  circle: { aspect: 1, fills: [arc(0.5, 0.5, 0.48, 0.48, 0, 360, 40)] },
  semicircle: { aspect: 1.6, fills: [[...arc(0.5, 0.92, 0.48, 0.84, 180, 360, 28)]] },
  star: { aspect: 1, fills: [star()] },
  heart: {
    aspect: 1.05,
    fills: [
      [
        [0.5, 0.99],
        [0.16, 0.64],
        [0.04, 0.44],
        [0.06, 0.24],
        [0.2, 0.12],
        [0.38, 0.14],
        [0.5, 0.3],
        [0.62, 0.14],
        [0.8, 0.12],
        [0.94, 0.24],
        [0.96, 0.44],
        [0.84, 0.64],
      ],
    ],
  },
};

const SYMBOLS: Readonly<Record<string, Glyph>> = {
  plus: { aspect: 1, strokes: [[[0.5, 0.1], [0.5, 0.9]], [[0.1, 0.5], [0.9, 0.5]]] },
  minus: { aspect: 1.6, strokes: [[[0.06, 0.5], [0.94, 0.5]]] },
  equals: {
    aspect: 1.3,
    minRows: 12,
    parts: 2,
    strokes: [[[0.08, 0.26], [0.92, 0.26]], [[0.08, 0.74], [0.92, 0.74]]],
  },
  times: { aspect: 1, strokes: [[[0.14, 0.14], [0.86, 0.86]], [[0.86, 0.14], [0.14, 0.86]]] },
  less: { aspect: 0.95, strokes: [[[0.84, 0.08], [0.16, 0.5], [0.84, 0.92]]] },
  greater: { aspect: 0.95, strokes: [[[0.16, 0.08], [0.84, 0.5], [0.16, 0.92]]] },
  up: { aspect: 1, fills: [ARROW_UP] },
  right: { aspect: 1, fills: [turn(ARROW_UP, 1)] },
  down: { aspect: 1, fills: [turn(ARROW_UP, 2)] },
  left: { aspect: 1, fills: [turn(ARROW_UP, 3)] },
};

export const GLYPHS: Readonly<Record<string, Glyph>> = {
  ...LETTERS,
  ...DIGITS,
  ...SHAPES,
  ...SYMBOLS,
};

/**
 * Glyph names, grouped for a menu.
 *
 * A flat list of fifty-two entries is a menu nobody reads to the end of.
 */
export const GLYPH_GROUPS: ReadonlyArray<{ label: string; names: readonly string[] }> = [
  { label: 'Numbers', names: Object.keys(DIGITS) },
  { label: 'Letters', names: Object.keys(LETTERS) },
  { label: 'Shapes', names: Object.keys(SHAPES) },
  { label: 'Signs and arrows', names: Object.keys(SYMBOLS) },
];

/** How a glyph is written for people: the character itself, or a capitalised word. */
export function glyphLabel(name: string): string {
  if (name.length === 1) return name;
  const words: Readonly<Record<string, string>> = {
    plus: 'Plus +',
    minus: 'Minus −',
    equals: 'Equals =',
    times: 'Times ×',
    less: 'Less than <',
    greater: 'Greater than >',
    up: 'Arrow up',
    down: 'Arrow down',
    left: 'Arrow left',
    right: 'Arrow right',
  };
  return words[name] ?? name[0]!.toUpperCase() + name.slice(1);
}

function pointInPolygon(x: number, y: number, poly: readonly GlyphPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x: number, y: number, a: GlyphPoint, b: GlyphPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/**
 * Turn a glyph into a grid of cells that are part of the puzzle.
 *
 * The interesting number is the thickness. It is the larger of a fixed proportion of the
 * box and **two and a half cells**, and the floor is the whole point: a stroke thinner
 * than about two cells can only be filled by single squares and dominoes, so the letter
 * stops being a puzzle and becomes a queue of scraps. Half a cell of margin on top of
 * two, because a diagonal stroke measured perpendicular to itself is thinner than it
 * looks along the grid.
 *
 * Returns null for an unknown name rather than an empty mask, so a bad name from a save
 * file or a link is a failure the caller has to answer for rather than a puzzle with no
 * cells in it.
 */
export function glyphMask(name: string, rows: number, cols: number): Uint8Array | null {
  const glyph = GLYPHS[name];
  if (!glyph || rows < 1 || cols < 1) return null;

  const cellX = 1 / cols;
  const cellY = 1 / rows;
  // Applied once. An earlier version multiplied by weight twice, which is the sort of
  // mistake that looks like a tuning decision rather than a bug.
  const weight = glyph.weight ?? 1;
  const thickness = Math.max(0.13, 2.5 * cellX, 2.5 * cellY) * weight;
  const half = thickness / 2;

  const mask = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cellX;
      const y = (r + 0.5) * cellY;
      let on = false;

      for (const poly of glyph.fills ?? []) {
        if (pointInPolygon(x, y, poly)) {
          on = true;
          break;
        }
      }
      if (!on) {
        outer: for (const line of glyph.strokes ?? []) {
          for (let i = 1; i < line.length; i++) {
            if (distanceToSegment(x, y, line[i - 1]!, line[i]!) <= half) {
              on = true;
              break outer;
            }
          }
        }
      }
      mask[r * cols + c] = on ? 1 : 0;
    }
  }
  return mask;
}

/**
 * The fraction of the grid a legible stroked glyph covers, at most.
 *
 * The number that stopped this feature shipping broken. Stroke thickness has a floor of
 * two and a half cells so that pieces are pieces rather than scraps — and on a small grid
 * that floor is an enormous fraction of the glyph, so the strokes swell until they touch
 * and the letter fills its box. Measured: at forty cells, `8`, `6`, `9`, `B` and `E` came
 * out at **coverage 1.00** — solid rectangles. They passed a hand-drawn contact sheet
 * because most glyphs looked fine and passed the tests because the assertion was a
 * generous "under 0.9".
 *
 * Coverage is the tell. A legible letter sits near 0.45–0.6; a blob approaches 1.
 */
const LEGIBLE_COVERAGE = 0.62;

/**
 * Rows below which a glyph is too coarse to read, whatever its coverage says.
 *
 * Coverage is a one-sided test: it catches a letter whose strokes have swollen into a
 * blob, and says nothing about the opposite failure. A C drawn on eight rows has low
 * coverage and is a blob with a notch in it; a star on seven rows is a lumpy cross. So
 * the search starts from a floor rather than from the smallest grid that is not solid.
 * Stroked glyphs need more of it than filled ones, because a curve quantised onto a
 * coarse grid loses the very feature that distinguishes it.
 */
const COARSE_ROWS = { stroked: 10, filled: 8 } as const;

/** Smallest grid at which a glyph still reads as itself. Searched once, then remembered. */
const minGridCache = new Map<string, { rows: number; cols: number }>();

export function glyphMinGrid(name: string): { rows: number; cols: number } {
  const cached = minGridCache.get(name);
  if (cached) return cached;

  const glyph = GLYPHS[name];
  const aspect = glyph?.aspect ?? 1;
  const floor = Math.max(
    glyph?.strokes ? COARSE_ROWS.stroked : COARSE_ROWS.filled,
    glyph?.minRows ?? 0,
  );
  let best = { rows: floor, cols: Math.max(5, Math.round(floor * aspect)) };

  // A filled shape has no strokes to swell, so coverage says nothing about it: a square
  // covers most of its box by definition. Only stroked glyphs are searched.
  if (glyph?.strokes) {
    for (let rows = floor; rows <= 30; rows++) {
      const cols = Math.max(5, Math.round(rows * aspect));
      const mask = glyphMask(name, rows, cols);
      if (!mask) break;
      best = { rows, cols };
      if (mask.reduce((n, v) => n + v, 0) / mask.length <= LEGIBLE_COVERAGE) break;
    }
  }
  minGridCache.set(name, best);
  return best;
}

/**
 * A grid that suits a glyph, given roughly how many cells are wanted.
 *
 * Two things are being reconciled and the glyph wins both.
 *
 * **Proportions.** Letters have them; forcing an I and a W into the same square grid
 * makes one spindly and the other cramped. The requested count is honoured only
 * approximately, because hitting it exactly means distorting the letter.
 *
 * **Legibility.** Below a glyph's own minimum the strokes merge and it stops being a
 * glyph, so a request for fewer cells than that is raised to it. This means asking for a
 * twelve-piece `8` gets rather more than twelve pieces — an `8` has three horizontal
 * strokes and two holes and cannot be drawn in twelve squares. Better to hand back a
 * legible 8 and say how many pieces it took than a solid rectangle with the right piece
 * count.
 */
export function glyphGrid(name: string, cells: number): { rows: number; cols: number } {
  const aspect = GLYPHS[name]?.aspect ?? 1;
  const minimum = glyphMinGrid(name);
  const rows = Math.max(minimum.rows, Math.round(Math.sqrt(cells / aspect)));
  return { rows, cols: Math.max(minimum.cols, Math.round(rows * aspect)) };
}

/** Fraction of the grid a glyph fills. Exposed because it is the legibility measure. */
export function glyphCoverage(name: string, rows: number, cols: number): number {
  const mask = glyphMask(name, rows, cols);
  if (!mask) return 0;
  return mask.reduce((n, v) => n + v, 0) / mask.length;
}

export { LEGIBLE_COVERAGE };
