/**
 * Undo and redo, by snapshot.
 *
 * Recorded in `ARCHITECTURE.md` as the app's largest known gap for twenty-one milestones:
 * **nothing in this app could be taken back.** Not a stray drag, not a shuffle, not a tray
 * tipped out. M21 added drag resistance so that the most expensive accident is harder to
 * have, which is a mitigation and not a fix — the accident still happens, and when it does
 * the only repair is to put forty joined pieces back by eye.
 *
 * ## Why snapshots rather than a command log
 *
 * A command log — "moved cluster 12 by (x, y)", inverted on undo — is smaller and is what
 * a drawing program would use. It is the wrong shape here for one reason: **a merge is not
 * invertible from the command alone.** Dropping a piece next to its neighbour destroys two
 * clusters and creates a third, redistributes a z-order, may pull both out of a tray, and
 * may rename the result. Inverting that needs the state from before it anyway, and every
 * new feature that touches state becomes a new inverse to write and to get wrong. A
 * snapshot is correct by construction and stays correct when somebody adds a feature in
 * M30 without reading this file.
 *
 * The usual objection to snapshots is size, and it does not apply here for the same reason
 * save files are a few kilobytes: **geometry is regenerated from the seed and never
 * stored**. What changes during play is where the pieces are, which is a handful of
 * numbers each. A 2,000-piece snapshot is about 70KB in typed arrays, so the whole
 * `CAP`-deep stack costs a couple of megabytes — less than one of the bundled pictures.
 *
 * ## What is and is not undoable
 *
 * In: piece and group moves, rotations, merges, shuffles, tray creation, deletion,
 * collapse and membership, group names.
 *
 * Out, deliberately:
 *
 * - **Zoom, pan and the reference panel.** Undo that rewound the view as well would make
 *   "undo" mean two things, and the view is already trivially reversible by looking.
 * - **Settings** — rotation on or off, ghost strength, hints. These are preferences, not
 *   moves; an undo that silently turned rotation back on would be a bug report.
 * - **Cutting a new puzzle.** The pieces are different pieces. The stack is cleared
 *   instead, because an undo across a recut would restore positions for a puzzle that no
 *   longer exists.
 * - **Elapsed time.** Time does not rewind.
 */

import { computePivot } from './clusters.js';
import type { PuzzleState } from './puzzle.js';
import type { Cluster, Tray } from './types.js';

/**
 * How many steps back you can go.
 *
 * Thirty rather than "unlimited", because the failure mode of unlimited is a tab that
 * quietly grows until a 2,000-piece puzzle on a tablet runs out of memory — and a person
 * who needs to undo thirty separate actions has not made a slip, they have changed their
 * mind about the last ten minutes, which is what saving and reopening is for.
 */
export const CAP = 30;

/**
 * One moment in the puzzle's life.
 *
 * Typed arrays rather than objects: the whole point is to keep many of these at once, and
 * an array of 2,000 little `{id, x, y}` objects costs several times what the numbers do.
 */
export interface Snapshot {
  /** What the next action was going to be, for "Undo move pieces". */
  readonly label: string;
  readonly clusterIds: Int32Array;
  /** Piece ids of cluster `i` are `pieceIds[offsets[i] .. offsets[i + 1]]`. */
  readonly offsets: Int32Array;
  readonly pieceIds: Int32Array;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly rotations: Float64Array;
  /** Only the clusters that have a name, which is nearly always none of them. */
  readonly names: ReadonlyMap<number, string>;
  readonly zOrder: Int32Array;
  readonly nextClusterId: number;
  readonly trays: readonly Tray[];
  readonly nextTrayId: number;
}

/** Everything about a state that a player could change. Geometry is not in here. */
export function snapshot(state: PuzzleState, label: string): Snapshot {
  const clusters = [...state.clusters.values()];
  const n = clusters.length;
  const clusterIds = new Int32Array(n);
  const offsets = new Int32Array(n + 1);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const rotations = new Float64Array(n);
  const names = new Map<number, string>();

  let total = 0;
  for (let i = 0; i < n; i++) total += clusters[i]!.pieces.length;
  const pieceIds = new Int32Array(total);

  let at = 0;
  for (let i = 0; i < n; i++) {
    const c = clusters[i]!;
    clusterIds[i] = c.id;
    offsets[i] = at;
    for (const p of c.pieces) pieceIds[at++] = p;
    xs[i] = c.x;
    ys[i] = c.y;
    rotations[i] = c.rotation;
    if (c.name !== null) names.set(c.id, c.name);
  }
  offsets[n] = at;

  return {
    label,
    clusterIds,
    offsets,
    pieceIds,
    xs,
    ys,
    rotations,
    names,
    zOrder: Int32Array.from(state.zOrder),
    nextClusterId: state.nextClusterId,
    // Trays are few and small, so plain objects are honest here. The cluster list has to
    // be copied or the snapshot holds a live reference to the tray's own array.
    trays: [...state.trays.values()].map((t) => ({ ...t, clusters: [...t.clusters] })),
    nextTrayId: state.nextTrayId,
  };
}

/**
 * Put a state back the way a snapshot found it.
 *
 * Mutates in place. `state.geometry`, `state.clusters`, `state.clusterOfPiece`,
 * `state.trays` and `state.trayOfCluster` are `readonly` references that the renderer,
 * the input layer and the session all hold, so replacing them would leave half the app
 * looking at the old ones.
 *
 * Pivots are recomputed rather than stored, exactly as loading a save file does. A pivot
 * is a pure function of which pieces are in the cluster, so storing it would be storing
 * something derivable — and something that could be restored inconsistent with the piece
 * list it belongs to.
 */
export function restoreSnapshot(state: PuzzleState, snap: Snapshot): void {
  state.clusters.clear();
  const n = snap.clusterIds.length;
  for (let i = 0; i < n; i++) {
    const id = snap.clusterIds[i]!;
    const pieces = Array.from(snap.pieceIds.subarray(snap.offsets[i]!, snap.offsets[i + 1]!));
    const pivot = computePivot(state.geometry, pieces);
    const cluster: Cluster = {
      id,
      pieces,
      x: snap.xs[i]!,
      y: snap.ys[i]!,
      rotation: snap.rotations[i]!,
      pivotX: pivot.x,
      pivotY: pivot.y,
      name: snap.names.get(id) ?? null,
    };
    state.clusters.set(id, cluster);
    for (const pieceId of pieces) state.clusterOfPiece[pieceId] = id;
  }

  state.zOrder = Array.from(snap.zOrder);
  state.nextClusterId = snap.nextClusterId;

  state.trays.clear();
  state.trayOfCluster.clear();
  for (const saved of snap.trays) {
    const tray: Tray = { ...saved, clusters: [...saved.clusters] };
    state.trays.set(tray.id, tray);
    for (const clusterId of tray.clusters) state.trayOfCluster.set(clusterId, tray.id);
  }
  state.nextTrayId = snap.nextTrayId;
}

/**
 * A number that changes whenever the puzzle does.
 *
 * Not a cryptographic hash and not trying to be: it exists so the app can ask "did that
 * actually change anything?" twice — once to throw away an undo entry for an action that
 * turned out to be a no-op, and once as a watchdog that catches a state change which
 * nobody recorded an undo step for. The second use is the important one, because the way
 * an undo feature rots is that somebody adds a feature in M30 and forgets to wrap it.
 *
 * Positions are rounded to a tenth of a pixel before mixing. Floating-point drift of
 * 1e-12 during a drag that ends where it began is not a change a person made.
 */
export function fingerprint(state: PuzzleState): number {
  // Each cluster is hashed on its own and the results are *added*, so the total does not
  // depend on the order they come out of the Map. That matters because a merge reorders
  // insertion order without the puzzle looking any different — and doing it this way
  // avoids sorting several thousand ids on a function that runs from the frame loop.
  let total = 0;
  const hash = (parts: readonly number[], text?: string | null): number => {
    let h = 0x811c9dc5;
    for (const v of parts) {
      h ^= v | 0;
      h = Math.imul(h, 0x01000193);
    }
    if (text) {
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    }
    return h >>> 0;
  };

  for (const c of state.clusters.values()) {
    total =
      (total +
        hash(
          [
            c.id,
            c.pieces.length,
            Math.round(c.x * 10),
            Math.round(c.y * 10),
            Math.round(c.rotation * 1000),
          ],
          c.name,
        )) >>>
      0;
  }
  for (const t of state.trays.values()) {
    total =
      (total +
        // Offset so a tray can never hash identically to a cluster with the same numbers.
        hash([~t.id, t.clusters.length, Math.round(t.x * 10), Math.round(t.y * 10), t.collapsed ? 1 : 0], t.name)) >>>
      0;
  }
  return total;
}

/** An undo entry with the label shown to the player. */
export interface Step {
  readonly label: string;
}

/**
 * The stack.
 *
 * Kept in the engine rather than the UI so it can be tested in Node, and so that the rule
 * "a redo stack dies the moment you do something new" lives in one place rather than
 * being re-derived at each call site.
 */
export class History {
  private readonly past: Snapshot[] = [];
  private readonly future: Snapshot[] = [];

  constructor(private readonly cap: number = CAP) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** What undo would take back, for the button's tooltip. */
  get undoLabel(): string | null {
    return this.past[this.past.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.future[this.future.length - 1]?.label ?? null;
  }

  get depth(): number {
    return this.past.length;
  }

  /** Record where the puzzle was before `label` happens. */
  push(snap: Snapshot): void {
    this.past.push(snap);
    // Doing something new makes the future unreachable. This is the behaviour every
    // editor has, and the alternative -- a tree -- is a user interface problem nobody
    // asked for.
    this.future.length = 0;
    if (this.past.length > this.cap) this.past.shift();
  }

  /**
   * Throw away the entry just pushed.
   *
   * For an action that turned out to change nothing: a drag that ended where it started,
   * a tray rename cancelled. Without this the stack fills with steps that appear to do
   * nothing when undone, which reads as a broken undo.
   */
  discard(): void {
    this.past.pop();
  }

  /** Step back. `now` is a snapshot of the current state, kept for redo. */
  undo(now: Snapshot): Snapshot | null {
    const snap = this.past.pop();
    if (!snap) return null;
    this.future.push({ ...now, label: snap.label });
    return snap;
  }

  /** Step forward again. `now` is a snapshot of the current state, kept for undo. */
  redo(now: Snapshot): Snapshot | null {
    const snap = this.future.pop();
    if (!snap) return null;
    this.past.push({ ...now, label: snap.label });
    return snap;
  }

  /** After cutting a new puzzle: the old positions describe pieces that no longer exist. */
  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }
}
