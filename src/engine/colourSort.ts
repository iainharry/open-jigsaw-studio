/**
 * Grouping the pieces of a puzzle by colour.
 *
 * Deliberately produces *groups to step through*, not trays. Automatically creating six
 * named trays would be making a judgement about your picture that the algorithm is not
 * entitled to make — "Blues" might be three different things you wanted apart, or two you
 * wanted together. Selecting each group in turn and letting the player press New tray (or
 * not) keeps the decision where it belongs, and costs one extra click.
 */

import { kMeansOklab, type Oklab } from './colour.js';
import { isInTray } from './trays.js';
import type { PuzzleState } from './puzzle.js';

export interface ColourGroup {
  /** Clusters in this group, in cluster-id order. */
  clusterIds: number[];
  /** Mean colour, for the swatch shown beside the group. */
  centre: Oklab;
  pieces: number;
}

export interface ColourSortOptions {
  /** How many groups to aim for. */
  groups?: number;
  /** Skip clusters already filed in a tray. */
  skipTrayed?: boolean;
  seed?: number;
}

/** Mean colour of a cluster, from the per-piece colours. */
export function clusterColour(
  state: PuzzleState,
  pieceColours: Float32Array,
  clusterId: number,
): Oklab | null {
  const cluster = state.clusters.get(clusterId);
  if (!cluster || cluster.pieces.length === 0) return null;
  let l = 0;
  let a = 0;
  let b = 0;
  for (const pieceId of cluster.pieces) {
    l += pieceColours[pieceId * 3]!;
    a += pieceColours[pieceId * 3 + 1]!;
    b += pieceColours[pieceId * 3 + 2]!;
  }
  const n = cluster.pieces.length;
  return [l / n, a / n, b / n];
}

/**
 * Group the loose clusters by colour.
 *
 * Groups come back largest first: the biggest group is usually the one most worth filing
 * (all that sky), so it is the one to offer first.
 */
export function groupByColour(
  state: PuzzleState,
  pieceColours: Float32Array,
  options: ColourSortOptions = {},
): ColourGroup[] {
  const groups = Math.max(2, Math.min(options.groups ?? 6, 24));
  const skipTrayed = options.skipTrayed ?? true;
  const seed = options.seed ?? state.geometry.seed;

  const items: { item: number; colour: Oklab }[] = [];
  for (const clusterId of state.clusters.keys()) {
    if (skipTrayed && isInTray(state, clusterId)) continue;
    const colour = clusterColour(state, pieceColours, clusterId);
    if (colour) items.push({ item: clusterId, colour });
  }

  return kMeansOklab(items, groups, seed)
    .map((group) => ({
      clusterIds: [...group.members].sort((a, b) => a - b),
      centre: group.centre,
      pieces: group.members.reduce(
        (sum, id) => sum + (state.clusters.get(id)?.pieces.length ?? 0),
        0,
      ),
    }))
    .sort((a, b) => b.pieces - a.pieces);
}

/**
 * Drop cluster ids that have since disappeared or been filed away.
 *
 * Groups are computed once and then worked through, so by the time the player reaches
 * group four, groups one to three may have been trayed and some clusters may have merged
 * out of existence. Selecting a dead id would highlight nothing.
 */
export function liveMembers(
  state: PuzzleState,
  group: ColourGroup,
  options: { skipTrayed?: boolean } = {},
): number[] {
  const skipTrayed = options.skipTrayed ?? true;
  return group.clusterIds.filter(
    (id) => state.clusters.has(id) && !(skipTrayed && isInTray(state, id)),
  );
}
