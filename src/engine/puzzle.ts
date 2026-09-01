/**
 * Puzzle state and the snap engine.
 *
 * Everything here is plain data and pure-ish functions over it. No DOM, no canvas,
 * no framework. That is what makes drag-and-snap testable at all: a browser driver
 * cannot meaningfully assert that releasing a piece 12 pixels from its neighbour
 * merges two clusters, but a Node test can, in a millisecond.
 */

import {
  angleDelta,
  computePivot,
  pieceWorldBounds,
  quantiseAngle,
  repivot,
  rotateAbout,
  toWorld,
  translate,
} from './clusters.js';
import { generateGeometry, type GeometryOptions } from './geometry.js';
import { deriveSeed, makeRng, range } from './rng.js';
import {
  DEFAULT_SETTINGS,
  type Cluster,
  type PieceGeometry,
  type Point,
  type PuzzleGeometry,
  type PuzzleSettings,
  type Side,
} from './types.js';

const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

export interface PuzzleState {
  readonly geometry: PuzzleGeometry;
  /** Replaceable: the player can turn rotation on or off during a puzzle. */
  settings: PuzzleSettings;
  /** Cluster id -> cluster. Ids are stable for the life of a cluster. */
  readonly clusters: Map<number, Cluster>;
  /** Piece id -> cluster id. */
  readonly clusterOfPiece: Int32Array;
  /** Cluster ids from back to front. */
  zOrder: number[];
  nextClusterId: number;
  /** Milliseconds of solving time accumulated in previous sessions. */
  elapsedMs: number;
}

export interface CreatePuzzleOptions extends GeometryOptions {
  readonly seed: number;
  readonly rows: number;
  readonly cols: number;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly settings?: Partial<PuzzleSettings>;
}

export function createPuzzle(options: CreatePuzzleOptions): PuzzleState {
  const { seed, rows, cols, imageWidth, imageHeight, settings, ...geomOpts } = options;
  const geometry = generateGeometry(seed, rows, cols, imageWidth, imageHeight, geomOpts);
  return stateFromGeometry(geometry, { ...DEFAULT_SETTINGS, ...settings });
}

/** One cluster per piece, each sitting exactly in its solved position. */
export function stateFromGeometry(
  geometry: PuzzleGeometry,
  settings: PuzzleSettings,
): PuzzleState {
  const clusters = new Map<number, Cluster>();
  const clusterOfPiece = new Int32Array(geometry.pieces.length);
  const zOrder: number[] = [];

  for (const piece of geometry.pieces) {
    const id = piece.id;
    clusters.set(id, {
      id,
      pieces: [piece.id],
      x: piece.solved.x,
      y: piece.solved.y,
      rotation: 0,
      pivotX: piece.solved.x,
      pivotY: piece.solved.y,
      name: null,
    });
    clusterOfPiece[piece.id] = id;
    zOrder.push(id);
  }

  return {
    geometry,
    settings,
    clusters,
    clusterOfPiece,
    zOrder,
    nextClusterId: geometry.pieces.length,
    elapsedMs: 0,
  };
}

/** World-space top-left of a piece's bounding box. */
export function pieceWorldOrigin(state: PuzzleState, pieceId: number): Point {
  const cluster = clusterOf(state, pieceId);
  return toWorld(cluster, state.geometry.pieces[pieceId]!.solved);
}

export function clusterOf(state: PuzzleState, pieceId: number): Cluster {
  const cid = state.clusterOfPiece[pieceId]!;
  const cluster = state.clusters.get(cid);
  if (!cluster) throw new Error(`piece ${pieceId} references missing cluster ${cid}`);
  return cluster;
}

/**
 * Scatter loose pieces across a region around the board.
 *
 * Deterministic from the seed, so "new puzzle with seed X" is fully reproducible
 * including the starting layout — which is what makes a shared puzzle identical on
 * two devices without shipping any coordinates.
 */
export interface Rectangle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScatterOptions {
  rotate?: boolean;
  /**
   * Keep pieces out of this rectangle — normally the board itself, so the player can
   * see where they are building instead of having to clear the assembly area first.
   */
  avoid?: Rectangle;
}

/** Pick a point in `area` but outside `avoid`, by choosing one of the four bands around it. */
function pointOutside(
  rng: () => number,
  area: Rectangle,
  avoid: Rectangle,
  w: number,
  h: number,
): Point {
  const bands: Rectangle[] = [
    { x: area.x, y: area.y, w: area.w, h: Math.max(0, avoid.y - area.y) },
    {
      x: area.x,
      y: avoid.y + avoid.h,
      w: area.w,
      h: Math.max(0, area.y + area.h - (avoid.y + avoid.h)),
    },
    { x: area.x, y: avoid.y, w: Math.max(0, avoid.x - area.x), h: avoid.h },
    {
      x: avoid.x + avoid.w,
      y: avoid.y,
      w: Math.max(0, area.x + area.w - (avoid.x + avoid.w)),
      h: avoid.h,
    },
  ].filter((b) => b.w > w && b.h > h);

  if (bands.length === 0) {
    // No room outside the avoid rect; fall back to the whole area.
    return {
      x: range(rng, area.x, Math.max(area.x, area.x + area.w - w)),
      y: range(rng, area.y, Math.max(area.y, area.y + area.h - h)),
    };
  }

  const total = bands.reduce((sum, b) => sum + b.w * b.h, 0);
  let pick = rng() * total;
  let band = bands[bands.length - 1]!;
  for (const b of bands) {
    pick -= b.w * b.h;
    if (pick <= 0) {
      band = b;
      break;
    }
  }
  return {
    x: range(rng, band.x, band.x + band.w - w),
    y: range(rng, band.y, band.y + band.h - h),
  };
}

export function scatter(
  state: PuzzleState,
  seed: number,
  area: Rectangle,
  options: ScatterOptions = {},
): void {
  const { geometry } = state;
  const rotate = options.rotate ?? state.settings.rotationEnabled;

  for (const cluster of state.clusters.values()) {
    const rng = makeRng(deriveSeed(seed, 7, cluster.id));
    const piece = geometry.pieces[cluster.pieces[0]!]!;
    const w = piece.bounds.w;
    const h = piece.bounds.h;
    const at = options.avoid
      ? pointOutside(rng, area, options.avoid, w, h)
      : {
          x: range(rng, area.x, Math.max(area.x, area.x + area.w - w)),
          y: range(rng, area.y, Math.max(area.y, area.y + area.h - h)),
        };
    cluster.rotation = rotate ? Math.round(range(rng, 0, 4)) * (Math.PI / 2) : 0;
    // `x`/`y` position the pivot; for a single piece the pivot is its solved origin,
    // so setting the pivot to (x, y) puts the piece's bbox origin there when unrotated.
    cluster.x = at.x;
    cluster.y = at.y;
  }

  // Shuffle draw order so the scatter does not look like a sorted stack.
  const rng = makeRng(deriveSeed(seed, 8));
  for (let i = state.zOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = state.zOrder[i]!;
    state.zOrder[i] = state.zOrder[j]!;
    state.zOrder[j] = a;
  }
}

export function bringToFront(state: PuzzleState, clusterId: number): void {
  const i = state.zOrder.indexOf(clusterId);
  if (i >= 0) state.zOrder.splice(i, 1);
  state.zOrder.push(clusterId);
}

export function moveCluster(state: PuzzleState, clusterId: number, dx: number, dy: number): void {
  const cluster = state.clusters.get(clusterId);
  if (!cluster) return;
  translate(cluster, dx, dy);
}

/**
 * Merge `absorbedId` into `keeperId`.
 *
 * The absorbed cluster adopts the keeper's transform exactly, which *is* the snap:
 * the moving assembly clicks into alignment with the stationary one. The keeper never
 * moves, so snapping a single piece onto a 200-piece assembly does not jolt the board.
 */
export function mergeClusters(state: PuzzleState, keeperId: number, absorbedId: number): void {
  if (keeperId === absorbedId) return;
  const keeper = state.clusters.get(keeperId);
  const absorbed = state.clusters.get(absorbedId);
  if (!keeper || !absorbed) throw new Error('merge of missing cluster');

  for (const pieceId of absorbed.pieces) {
    keeper.pieces.push(pieceId);
    state.clusterOfPiece[pieceId] = keeperId;
  }
  keeper.pieces.sort((a, b) => a - b);

  // A named group survives absorbing an unnamed one.
  if (keeper.name === null && absorbed.name !== null) keeper.name = absorbed.name;

  const pivot = computePivot(state.geometry, keeper.pieces);
  repivot(keeper, pivot.x, pivot.y);

  state.clusters.delete(absorbedId);
  const zi = state.zOrder.indexOf(absorbedId);
  if (zi >= 0) state.zOrder.splice(zi, 1);
}

/**
 * Find a cluster that `clusterId` should snap to, or null.
 *
 * Checks every solved-neighbour relationship that crosses the cluster boundary and
 * asks: if that neighbour belonged to this cluster, would it be sitting roughly where
 * it actually is? That formulation is rotation-aware for free, which is why rotation
 * is in the model from day one even though the M1 UI does not expose it.
 */
export function findSnap(state: PuzzleState, clusterId: number): number | null {
  const cluster = state.clusters.get(clusterId);
  if (!cluster) return null;

  const { geometry, settings } = state;
  const tol = settings.snapTolerance * Math.min(geometry.cellWidth, geometry.cellHeight);
  const tolSq = tol * tol;

  let bestId: number | null = null;
  let bestDistSq = Infinity;

  for (const pieceId of cluster.pieces) {
    const piece = geometry.pieces[pieceId]!;
    for (const side of SIDES) {
      const neighbourId = piece.neighbours[side];
      if (neighbourId < 0) continue;
      const otherId = state.clusterOfPiece[neighbourId]!;
      if (otherId === clusterId) continue;
      const other = state.clusters.get(otherId);
      if (!other) continue;

      if (settings.rotationEnabled && angleDelta(cluster.rotation, other.rotation) > settings.angleTolerance) {
        continue;
      }

      const neighbour: PieceGeometry = geometry.pieces[neighbourId]!;
      const wanted = toWorld(cluster, neighbour.solved);
      const actual = toWorld(other, neighbour.solved);
      const dx = wanted.x - actual.x;
      const dy = wanted.y - actual.y;
      const dSq = dx * dx + dy * dy;
      if (dSq <= tolSq && dSq < bestDistSq) {
        bestDistSq = dSq;
        bestId = otherId;
      }
    }
  }

  return bestId;
}

/**
 * Resolve every snap available to a cluster after it is released.
 *
 * Loops because snapping into one neighbour can bring the assembly within tolerance of
 * others: dropping a piece into a hole surrounded on three sides should connect all
 * three, not one. Returns the id of the cluster the pieces ended up in.
 */
export function releaseCluster(state: PuzzleState, clusterId: number): { clusterId: number; merges: number } {
  let current = clusterId;
  let merges = 0;
  // Bounded to keep a pathological tolerance from looping forever.
  for (let guard = 0; guard < state.geometry.pieces.length + 1; guard++) {
    const target = findSnap(state, current);
    if (target === null) break;
    mergeClusters(state, target, current);
    current = target;
    merges++;
  }
  if (merges > 0) bringToFront(state, current);
  return { clusterId: current, merges };
}

// --- Operations on a set of clusters ---------------------------------------
//
// Selection lives in the interaction layer, not here: which pieces are highlighted is
// not part of a puzzle's state and does not belong in a save file. What the engine
// provides is the vocabulary for acting on several clusters at once, so that multi-piece
// moves, rotations and releases are one tested operation rather than a loop in the UI.

/** Move several clusters together. */
export function moveClusters(
  state: PuzzleState,
  clusterIds: Iterable<number>,
  dx: number,
  dy: number,
): void {
  for (const id of clusterIds) {
    const cluster = state.clusters.get(id);
    if (cluster) translate(cluster, dx, dy);
  }
}

/** Rotate several clusters as a rigid body about one shared world point. */
export function rotateClusters(
  state: PuzzleState,
  clusterIds: Iterable<number>,
  angle: number,
  about: Point,
): void {
  for (const id of clusterIds) {
    const cluster = state.clusters.get(id);
    if (cluster) rotateAbout(cluster, angle, about);
  }
}

/** Snap each cluster's rotation to the nearest multiple of `step`, in place. */
export function quantiseClusterRotations(
  state: PuzzleState,
  clusterIds: Iterable<number>,
  step: number = Math.PI / 2,
): void {
  for (const id of clusterIds) {
    const cluster = state.clusters.get(id);
    if (cluster) cluster.rotation = quantiseAngle(cluster.rotation, step);
  }
}

/**
 * Release several clusters, resolving snaps for each.
 *
 * Order matters and ids are not stable across this call: releasing one cluster can
 * absorb another that is still waiting in the list. Hence the `has` check on every
 * iteration and the filter at the end — returning a dead id would leave the UI holding
 * a selection that no longer exists.
 */
export function releaseClusters(
  state: PuzzleState,
  clusterIds: Iterable<number>,
): { clusterIds: number[]; merges: number } {
  let merges = 0;
  const landed = new Set<number>();
  for (const id of clusterIds) {
    if (!state.clusters.has(id)) continue;
    const result = releaseCluster(state, id);
    merges += result.merges;
    landed.add(result.clusterId);
  }
  return {
    clusterIds: [...landed].filter((id) => state.clusters.has(id)),
    merges,
  };
}

/** World-space bounding box of an entire cluster. */
export function clusterWorldBounds(
  state: PuzzleState,
  clusterId: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const cluster = state.clusters.get(clusterId);
  if (!cluster) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pieceId of cluster.pieces) {
    const b = pieceWorldBounds(cluster, state.geometry.pieces[pieceId]!);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return { minX, minY, maxX, maxY };
}

/** Clusters whose bounding box overlaps a world-space rectangle. For rubber-band select. */
export function clustersIntersecting(
  state: PuzzleState,
  rect: { x: number; y: number; w: number; h: number },
): number[] {
  const minX = Math.min(rect.x, rect.x + rect.w);
  const maxX = Math.max(rect.x, rect.x + rect.w);
  const minY = Math.min(rect.y, rect.y + rect.h);
  const maxY = Math.max(rect.y, rect.y + rect.h);

  const hits: number[] = [];
  for (const id of state.clusters.keys()) {
    const b = clusterWorldBounds(state, id);
    if (!b) continue;
    if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) continue;
    hits.push(id);
  }
  return hits;
}

/** Centre of the combined bounding box of several clusters. The pivot for group rotation. */
export function selectionCentre(state: PuzzleState, clusterIds: Iterable<number>): Point | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const id of clusterIds) {
    const b = clusterWorldBounds(state, id);
    if (!b) continue;
    any = true;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return any ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : null;
}

export function isComplete(state: PuzzleState): boolean {
  if (state.clusters.size !== 1) return false;
  if (!state.settings.rotationEnabled) return true;
  const only = state.clusters.values().next().value as Cluster;
  return angleDelta(only.rotation, 0) < 1e-6;
}

/** Fraction of pieces that are joined to at least one neighbour, for a progress readout. */
export function progress(state: PuzzleState): number {
  const total = state.geometry.pieces.length;
  if (total <= 1) return 1;
  let joined = 0;
  for (const cluster of state.clusters.values()) {
    if (cluster.pieces.length > 1) joined += cluster.pieces.length;
  }
  return joined / total;
}

/** Assign or clear a user-visible name on a cluster. The hook for named groups. */
export function nameCluster(state: PuzzleState, clusterId: number, name: string | null): void {
  const cluster = state.clusters.get(clusterId);
  if (cluster) cluster.name = name;
}
