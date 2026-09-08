/**
 * Save-file serialisation.
 *
 * Geometry is *never* stored. A save file carries the seed and the grid, and the
 * geometry is regenerated on load. A 2,000-piece save is therefore a few kilobytes
 * rather than several megabytes, and a puzzle shared as a seed reproduces exactly.
 * This only works because generation is deterministic — see `rng.ts`.
 *
 * Adding a field here is a schema change: bump `SAVE_VERSION` and add a migration.
 */

import { computePivot } from './clusters.js';
import { generateGeometry, type GeometryOptions } from './geometry.js';
import { generatePolyominoGeometry, type PolyominoOptions } from './polyomino.js';
import { stateFromGeometry, type PuzzleState } from './puzzle.js';
import {
  DEFAULT_SETTINGS,
  type Cluster,
  type PuzzleSettings,
  type Tray,
  type Viewport,
} from './types.js';

export const SAVE_FORMAT = 'open-jigsaw-studio/puzzle-state';
/** v2 added trays. A v1 file loads with no trays, which is exactly what it had. */
export const SAVE_VERSION = 2;

export interface SavedCluster {
  id: number;
  pieces: number[];
  x: number;
  y: number;
  rotation: number;
  name: string | null;
}

export interface SavedPuzzle {
  format: typeof SAVE_FORMAT;
  version: number;
  puzzle: {
    seed: number;
    rows: number;
    cols: number;
    imageWidth: number;
    imageHeight: number;
    geometryOptions: GeometryOptions;
    /**
     * Which generator cuts the pieces. Absent on every save written before the polyomino
     * cut existed, and those are all classic — which is why the field is optional rather
     * than the format being versioned. Geometry is regenerated rather than stored, so a
     * save is only as portable as the generator it names.
     */
    cut?: 'classic' | 'polyomino';
    polyominoOptions?: PolyominoOptions;
  };
  settings: PuzzleSettings;
  clusters: SavedCluster[];
  zOrder: number[];
  nextClusterId: number;
  elapsedMs: number;
  viewport: Viewport | null;
  /** Added in v2. Absent in v1 files. */
  trays?: Tray[];
  nextTrayId?: number;
}

export function serialize(
  state: PuzzleState,
  geometryOptions: GeometryOptions,
  viewport: Viewport | null = null,
): SavedPuzzle {
  const g = state.geometry;
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    puzzle: {
      seed: g.seed,
      rows: g.rows,
      cols: g.cols,
      imageWidth: g.imageWidth,
      imageHeight: g.imageHeight,
      geometryOptions,
      ...(g.cut === 'polyomino'
        ? { cut: 'polyomino' as const, polyominoOptions: g.polyominoOptions }
        : {}),
    },
    settings: state.settings,
    clusters: [...state.clusters.values()].map((c) => ({
      id: c.id,
      pieces: [...c.pieces],
      x: c.x,
      y: c.y,
      rotation: c.rotation,
      name: c.name,
    })),
    zOrder: [...state.zOrder],
    nextClusterId: state.nextClusterId,
    elapsedMs: state.elapsedMs,
    viewport,
    trays: [...state.trays.values()].map((t) => ({ ...t, clusters: [...t.clusters] })),
    nextTrayId: state.nextTrayId,
  };
}

export function deserialize(saved: SavedPuzzle): { state: PuzzleState; viewport: Viewport | null } {
  if (saved.format !== SAVE_FORMAT) throw new Error(`unrecognised save format: ${saved.format}`);
  if (saved.version > SAVE_VERSION) {
    throw new Error(
      `save was written by a newer version of the app (v${saved.version} > v${SAVE_VERSION})`,
    );
  }

  const p = saved.puzzle;
  const geometry =
    p.cut === 'polyomino'
      ? generatePolyominoGeometry(
          p.seed,
          p.rows,
          p.cols,
          p.imageWidth,
          p.imageHeight,
          p.polyominoOptions ?? {},
        )
      : generateGeometry(
    p.seed,
    p.rows,
    p.cols,
    p.imageWidth,
    p.imageHeight,
    p.geometryOptions,
  );
  const state = stateFromGeometry(geometry, { ...DEFAULT_SETTINGS, ...saved.settings });

  state.clusters.clear();
  for (const sc of saved.clusters) {
    const pivot = computePivot(geometry, sc.pieces);
    const cluster: Cluster = {
      id: sc.id,
      pieces: [...sc.pieces],
      x: sc.x,
      y: sc.y,
      rotation: sc.rotation,
      pivotX: pivot.x,
      pivotY: pivot.y,
      name: sc.name,
    };
    state.clusters.set(sc.id, cluster);
    for (const pieceId of sc.pieces) state.clusterOfPiece[pieceId] = sc.id;
  }

  state.zOrder = saved.zOrder.filter((id) => state.clusters.has(id));
  // Defensive: any cluster missing from the stored z-order goes on top rather than
  // silently becoming invisible.
  for (const id of state.clusters.keys()) {
    if (!state.zOrder.includes(id)) state.zOrder.push(id);
  }
  state.nextClusterId = saved.nextClusterId;
  state.elapsedMs = saved.elapsedMs;

  // v1 files have no trays; the loop simply does nothing, which is the correct migration.
  for (const saved_tray of saved.trays ?? []) {
    const tray: Tray = { ...saved_tray, clusters: [] };
    state.trays.set(tray.id, tray);
    for (const clusterId of saved_tray.clusters) {
      // Skip ids that no longer exist, so a corrupt or hand-edited file cannot leave the
      // tray holding phantom members that break packing.
      if (!state.clusters.has(clusterId)) continue;
      tray.clusters.push(clusterId);
      state.trayOfCluster.set(clusterId, tray.id);
    }
  }
  state.nextTrayId = Math.max(
    saved.nextTrayId ?? 1,
    ...[...state.trays.keys()].map((id) => id + 1),
    1,
  );

  return { state, viewport: saved.viewport };
}
