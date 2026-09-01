/**
 * Cluster transforms and merging.
 *
 * A cluster is *the* unit of movement in this engine. A loose single piece is a
 * cluster of one; four snapped-together pieces are a cluster of four; a user's named
 * subassembly will be a cluster with a name. There is deliberately no separate
 * "group" concept — adding one later would mean maintaining two parallel structures
 * that both have to move, rotate, serialise and snap correctly.
 *
 * Transform model: a cluster carries a rotation and a translation about a pivot, where
 * the pivot is the centroid of its pieces' *solved* positions. A cluster sitting in its
 * solved place has rotation 0 and translation equal to its pivot, so world == solved.
 */

import type { Cluster, PieceGeometry, Point, PuzzleGeometry } from './types.js';

/** Map a point from solved (image) space into world space under a cluster's transform. */
export function toWorld(cluster: Cluster, solved: Point): Point {
  const dx = solved.x - cluster.pivotX;
  const dy = solved.y - cluster.pivotY;
  if (cluster.rotation === 0) {
    return { x: dx + cluster.x, y: dy + cluster.y };
  }
  const cos = Math.cos(cluster.rotation);
  const sin = Math.sin(cluster.rotation);
  return {
    x: dx * cos - dy * sin + cluster.x,
    y: dx * sin + dy * cos + cluster.y,
  };
}

/** Inverse of `toWorld`. */
export function toSolved(cluster: Cluster, world: Point): Point {
  const dx = world.x - cluster.x;
  const dy = world.y - cluster.y;
  if (cluster.rotation === 0) {
    return { x: dx + cluster.pivotX, y: dy + cluster.pivotY };
  }
  const cos = Math.cos(-cluster.rotation);
  const sin = Math.sin(-cluster.rotation);
  return {
    x: dx * cos - dy * sin + cluster.pivotX,
    y: dx * sin + dy * cos + cluster.pivotY,
  };
}

/** Centroid of the solved positions of the given pieces. */
export function computePivot(
  geometry: PuzzleGeometry,
  pieceIds: readonly number[],
): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  for (const id of pieceIds) {
    const p = geometry.pieces[id]!;
    sx += p.solved.x;
    sy += p.solved.y;
  }
  const n = pieceIds.length;
  return { x: sx / n, y: sy / n };
}

/**
 * Move a cluster's pivot without moving the cluster on screen.
 *
 * Needed after a merge changes the membership (and therefore the centroid). If the
 * translation were not compensated, every merge would teleport the assembly.
 */
export function repivot(cluster: Cluster, newPivotX: number, newPivotY: number): void {
  const dx = newPivotX - cluster.pivotX;
  const dy = newPivotY - cluster.pivotY;
  const cos = Math.cos(cluster.rotation);
  const sin = Math.sin(cluster.rotation);
  cluster.x += dx * cos - dy * sin;
  cluster.y += dx * sin + dy * cos;
  cluster.pivotX = newPivotX;
  cluster.pivotY = newPivotY;
}

/** Translate a cluster in world space. */
export function translate(cluster: Cluster, dx: number, dy: number): void {
  cluster.x += dx;
  cluster.y += dy;
}

/** Rotate a cluster about an arbitrary world-space point. */
export function rotateAbout(cluster: Cluster, angle: number, about: Point): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = cluster.x - about.x;
  const dy = cluster.y - about.y;
  cluster.x = about.x + dx * cos - dy * sin;
  cluster.y = about.y + dx * sin + dy * cos;
  cluster.rotation = normaliseAngle(cluster.rotation + angle);
}

/** Wrap an angle into (-PI, PI]. */
export function normaliseAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r <= -Math.PI) r += twoPi;
  return r;
}

/** Smallest absolute difference between two angles. */
export function angleDelta(a: number, b: number): number {
  return Math.abs(normaliseAngle(a - b));
}

/** World-space bounding box of a piece under a cluster's transform. */
export function pieceWorldBounds(
  cluster: Cluster,
  piece: PieceGeometry,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const { x, y, w, h } = piece.bounds;
  const corners: Point[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const p = toWorld(cluster, c);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}
