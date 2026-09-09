/**
 * Challenge codes: one short string that is a whole puzzle.
 *
 * A class of thirty needs the *same* board, not thirty similar ones — otherwise nobody
 * can compare, help each other, or be told "try the top-left corner". The app has no
 * server and no accounts, so there is nowhere to put a shared puzzle. Fortunately it does
 * not need one: a shape puzzle played without a picture is entirely determined by its
 * seed and a handful of settings, and geometry is regenerated from the seed rather than
 * stored — the decision from M1 that has now paid for itself three times.
 *
 * So the whole puzzle fits in a URL fragment, and a fragment is never sent to a server
 * even when the page is fetched. `#1-k3j9x-6x8-pd5fa` is the board.
 *
 * **Only picture-free puzzles can be shared this way, and that is not a limitation to
 * apologise for — it is the boundary of what is honest.** A photo cannot go in a URL, and
 * a link that quietly produced *a* puzzle rather than *the* puzzle would be worse than no
 * link at all.
 *
 * **The code is checksummed.** A single mistyped character would otherwise produce a
 * different but perfectly valid board, and one student would spend the lesson on a puzzle
 * nobody else can see. That is the exact failure this codebase keeps running into — being
 * wrong quietly — so one character of the code exists to make a typo say so.
 *
 * **Every field is range-checked on the way in.** This arrives from a URL a person typed
 * or edited, so a decoder that trusted it would be reading hostile input. A code that
 * does not parse returns null and the app says so; it never half-applies.
 */

import type { ShapeSet, Silhouette } from './polyomino.js';

export interface Challenge {
  readonly seed: number;
  readonly rows: number;
  readonly cols: number;
  readonly shapeSet: ShapeSet;
  readonly silhouette: Silhouette;
  /** Average cells per piece, 1-5. */
  readonly targetCells: number;
  readonly flatEdges: boolean;
  readonly rules: 'match' | 'anyfit';
  readonly rotate: boolean;
}

/**
 * Pixels per cell for a puzzle that has no picture.
 *
 * The geometry generator sizes cells from the image it is cutting, and a shared puzzle
 * has no image — so the canvas is invented from the grid instead, at a fixed size. Fixed
 * rather than derived from the window: two people on different screens must get
 * identical geometry, and a board whose cell coordinates depended on a tablet's width
 * would not be the same puzzle at all.
 */
export const CHALLENGE_CELL = 100;

const SETS: Readonly<Record<string, ShapeSet>> = { m: 'mixed', t: 'tetrominoes', p: 'pentominoes' };
const SHAPES: Readonly<Record<string, Silhouette>> = {
  r: 'rectangle',
  d: 'diamond',
  e: 'ellipse',
  c: 'cross',
  f: 'frame',
};

const codeFor = <T extends string>(table: Readonly<Record<string, T>>, value: T): string =>
  Object.keys(table).find((key) => table[key] === value) ?? Object.keys(table)[0]!;

/** Grid limits. Wide enough for any board the app will cut, narrow enough to reject junk. */
const MIN_SIDE = 2;
const MAX_SIDE = 60;

/**
 * One character over the payload, in base 36.
 *
 * Position-weighted so that transposing two characters — the other common typing error —
 * changes the result, which a plain sum would not.
 */
function checksum(payload: string): string {
  let total = 0;
  for (let i = 0; i < payload.length; i++) total += payload.charCodeAt(i) * (i + 1);
  return (total % 36).toString(36);
}

export function encodeChallenge(challenge: Challenge): string {
  const seed = (challenge.seed >>> 0).toString(36);
  const flags =
    codeFor(SETS, challenge.shapeSet) +
    codeFor(SHAPES, challenge.silhouette) +
    String(Math.max(1, Math.min(5, Math.round(challenge.targetCells)))) +
    (challenge.flatEdges ? 'f' : 't') +
    (challenge.rules === 'anyfit' ? 'a' : 'm') +
    (challenge.rotate ? 'r' : '');
  const payload = `1-${seed}-${challenge.rows}x${challenge.cols}-${flags}`;
  return `${payload}-${checksum(payload)}`;
}

/**
 * Read a code back, from a bare code or from anywhere in a URL.
 *
 * Accepting a whole pasted URL matters more than it looks: the person sharing will copy
 * the address bar, and a decoder that only took the bare code would put the burden of
 * editing a URL on a room full of people who are about to blame themselves for it.
 */
export function decodeChallenge(text: string): Challenge | null {
  const trimmed = text.trim();
  const hash = trimmed.includes('#') ? trimmed.slice(trimmed.lastIndexOf('#') + 1) : trimmed;
  const code = hash.trim().toLowerCase();

  const parts = code.split('-');
  if (parts.length !== 5) return null;
  const [version, seedText, grid, flags, check] = parts as [string, string, string, string, string];
  if (version !== '1') return null;
  if (checksum(`1-${seedText}-${grid}-${flags}`) !== check) return null;

  const seed = Number.parseInt(seedText, 36);
  if (!Number.isFinite(seed) || seed < 0 || !/^[0-9a-z]+$/.test(seedText)) return null;

  const dims = /^(\d+)x(\d+)$/.exec(grid);
  if (!dims) return null;
  const rows = Number(dims[1]);
  const cols = Number(dims[2]);
  if (rows < MIN_SIDE || cols < MIN_SIDE || rows > MAX_SIDE || cols > MAX_SIDE) return null;

  if (flags.length < 5 || flags.length > 6) return null;
  const shapeSet = SETS[flags[0]!];
  const silhouette = SHAPES[flags[1]!];
  const targetCells = Number(flags[2]);
  if (!shapeSet || !silhouette) return null;
  if (!Number.isInteger(targetCells) || targetCells < 1 || targetCells > 5) return null;
  if (flags[3] !== 'f' && flags[3] !== 't') return null;
  if (flags[4] !== 'a' && flags[4] !== 'm') return null;
  if (flags.length === 6 && flags[5] !== 'r') return null;

  return {
    seed,
    rows,
    cols,
    shapeSet,
    silhouette,
    targetCells,
    flatEdges: flags[3] === 'f',
    rules: flags[4] === 'a' ? 'anyfit' : 'match',
    rotate: flags.length === 6,
  };
}

/** The address to hand out, given wherever the app is being served from. */
export function challengeUrl(base: string, challenge: Challenge): string {
  const withoutHash = base.split('#')[0] ?? base;
  return `${withoutHash}#${encodeChallenge(challenge)}`;
}

/**
 * A name to put on a challenge, so a class can talk about it.
 *
 * Derived from the code rather than stored, so the same code always produces the same
 * name for everyone — the point of the whole exercise. Deliberately not random-looking:
 * "Cross of 12" is something a teacher can say out loud, and a hex string is not.
 */
export function challengeName(challenge: Challenge, pieces?: number): string {
  const shape =
    challenge.silhouette === 'rectangle'
      ? challenge.shapeSet === 'pentominoes'
        ? 'Pentomino board'
        : challenge.shapeSet === 'tetrominoes'
          ? 'Tetromino board'
          : 'Shape board'
      : challenge.silhouette[0]!.toUpperCase() + challenge.silhouette.slice(1);
  return pieces ? `${shape} of ${pieces}` : shape;
}
