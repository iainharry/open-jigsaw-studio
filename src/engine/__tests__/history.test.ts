import { describe, expect, it } from 'vitest';
import { CAP, History, fingerprint, restoreSnapshot, snapshot } from '../history.js';
import { createPuzzle, mergeClusters, moveCluster, nameCluster } from '../puzzle.js';
import { addToTray, createTray } from '../trays.js';

function puzzle() {
  return createPuzzle({ seed: 7, rows: 4, cols: 4, imageWidth: 400, imageHeight: 400 });
}

describe('snapshot and restore', () => {
  it('puts moved pieces back exactly', () => {
    const state = puzzle();
    const before = snapshot(state, 'move');
    const id = [...state.clusters.keys()][0]!;
    moveCluster(state, id, 137.5, -92.25);
    restoreSnapshot(state, before);
    const c = state.clusters.get(id)!;
    const original = puzzle().clusters.get(id)!;
    expect(c.x).toBe(original.x);
    expect(c.y).toBe(original.y);
  });

  /**
   * The case a command log could not have handled without keeping the old state anyway:
   * a merge destroys two clusters and creates a third, and undoing it has to bring both
   * back with their piece lists, their pivots and their z-order.
   */
  it('brings back clusters that a merge destroyed', () => {
    const state = puzzle();
    const ids = [...state.clusters.keys()];
    const a = ids[0]!;
    const b = ids[1]!;
    const before = snapshot(state, 'join');
    const clustersBefore = state.clusters.size;

    mergeClusters(state, a, b);
    expect(state.clusters.size).toBe(clustersBefore - 1);

    restoreSnapshot(state, before);
    expect(state.clusters.size).toBe(clustersBefore);
    expect(state.clusters.get(a)!.pieces).toEqual([a]);
    expect(state.clusters.get(b)!.pieces).toEqual([b]);
    // clusterOfPiece has to come back too, or hit testing finds the cluster that is gone.
    expect(state.clusterOfPiece[a]).toBe(a);
    expect(state.clusterOfPiece[b]).toBe(b);
  });

  /**
   * A pivot is a pure function of the piece list, so it is recomputed rather than stored.
   * If it were restored independently it could come back describing a different set of
   * pieces than the cluster actually holds, and the cluster would draw in the wrong place
   * while every number in it looked plausible.
   */
  it('recomputes pivots so they always match the piece list', () => {
    const state = puzzle();
    const ids = [...state.clusters.keys()];
    mergeClusters(state, ids[0]!, ids[1]!);
    mergeClusters(state, ids[0]!, ids[2]!);
    const merged = snapshot(state, 'join');

    restoreSnapshot(state, merged);
    const c = state.clusters.get(state.clusterOfPiece[ids[0]!]!)!;
    let sx = 0;
    let sy = 0;
    for (const p of c.pieces) {
      sx += state.geometry.pieces[p]!.solved.x;
      sy += state.geometry.pieces[p]!.solved.y;
    }
    expect(c.pivotX).toBeCloseTo(sx / c.pieces.length, 9);
    expect(c.pivotY).toBeCloseTo(sy / c.pieces.length, 9);
  });

  it('restores trays and which cluster is in which', () => {
    const state = puzzle();
    const ids = [...state.clusters.keys()].slice(0, 3);
    const before = snapshot(state, 'tray');
    const tray = createTray(state, { x: 10, y: 10, clusters: [] });
    addToTray(state, tray.id, ids);
    expect(state.trays.size).toBe(1);
    expect(state.trayOfCluster.size).toBe(3);

    restoreSnapshot(state, before);
    expect(state.trays.size).toBe(0);
    expect(state.trayOfCluster.size).toBe(0);
  });

  it('restores names', () => {
    const state = puzzle();
    const id = [...state.clusters.keys()][0]!;
    nameCluster(state, id, 'Sky');
    const named = snapshot(state, 'name');
    nameCluster(state, id, null);
    restoreSnapshot(state, named);
    expect(state.clusters.get(id)!.name).toBe('Sky');
  });

  it('keeps the live objects the rest of the app holds', () => {
    const state = puzzle();
    const clusters = state.clusters;
    const trays = state.trays;
    const pieceMap = state.clusterOfPiece;
    restoreSnapshot(state, snapshot(state, 'x'));
    // Replacing these would leave the renderer and the input layer reading the old ones.
    expect(state.clusters).toBe(clusters);
    expect(state.trays).toBe(trays);
    expect(state.clusterOfPiece).toBe(pieceMap);
  });
});

describe('fingerprint', () => {
  it('changes when a piece moves and not otherwise', () => {
    const state = puzzle();
    const before = fingerprint(state);
    expect(fingerprint(state)).toBe(before);
    moveCluster(state, [...state.clusters.keys()][0]!, 5, 0);
    expect(fingerprint(state)).not.toBe(before);
  });

  /**
   * A drag that ends where it began is not a change a person made. Without the rounding,
   * floating-point drift of 1e-12 would fill the undo stack with steps that do nothing.
   */
  it('ignores drift far below a pixel', () => {
    const state = puzzle();
    const before = fingerprint(state);
    const id = [...state.clusters.keys()][0]!;
    moveCluster(state, id, 1e-9, -1e-9);
    expect(fingerprint(state)).toBe(before);
  });

  it('does not change merely because a merge reordered the map', () => {
    const a = puzzle();
    const b = puzzle();
    const ids = [...a.clusters.keys()];
    mergeClusters(a, ids[0]!, ids[1]!);
    mergeClusters(b, ids[0]!, ids[1]!);
    // Same moves, so the same fingerprint, whatever order the map ended up in.
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

describe('History', () => {
  it('walks back and forward over several steps', () => {
    const state = puzzle();
    const history = new History();
    const id = [...state.clusters.keys()][0]!;
    const marks: number[] = [fingerprint(state)];

    for (let i = 0; i < 3; i++) {
      history.push(snapshot(state, `move ${i}`));
      moveCluster(state, id, 10, 10);
      marks.push(fingerprint(state));
    }

    for (let i = 2; i >= 0; i--) {
      const snap = history.undo(snapshot(state, 'now'))!;
      restoreSnapshot(state, snap);
      expect(fingerprint(state)).toBe(marks[i]);
    }
    expect(history.canUndo).toBe(false);

    for (let i = 1; i <= 3; i++) {
      const snap = history.redo(snapshot(state, 'now'))!;
      restoreSnapshot(state, snap);
      expect(fingerprint(state)).toBe(marks[i]);
    }
    expect(history.canRedo).toBe(false);
  });

  it('drops the redo stack as soon as something new happens', () => {
    const state = puzzle();
    const history = new History();
    const id = [...state.clusters.keys()][0]!;

    history.push(snapshot(state, 'a'));
    moveCluster(state, id, 10, 0);
    restoreSnapshot(state, history.undo(snapshot(state, 'now'))!);
    expect(history.canRedo).toBe(true);

    history.push(snapshot(state, 'b'));
    expect(history.canRedo).toBe(false);
  });

  it('keeps the labels the right way round', () => {
    const state = puzzle();
    const history = new History();
    history.push(snapshot(state, 'shuffle'));
    expect(history.undoLabel).toBe('shuffle');
    history.undo(snapshot(state, 'now'));
    expect(history.undoLabel).toBe(null);
    expect(history.redoLabel).toBe('shuffle');
  });

  it('discards an entry for an action that changed nothing', () => {
    const state = puzzle();
    const history = new History();
    history.push(snapshot(state, 'drag that went nowhere'));
    history.discard();
    expect(history.canUndo).toBe(false);
  });

  it('forgets the oldest step rather than growing without limit', () => {
    const state = puzzle();
    const history = new History(4);
    for (let i = 0; i < 10; i++) history.push(snapshot(state, `step ${i}`));
    expect(history.depth).toBe(4);
    // The four kept are the four most recent.
    expect(history.undoLabel).toBe('step 9');
  });

  it('caps at a size that will not exhaust a tablet', () => {
    // 30 snapshots of a 2,000-piece puzzle is a couple of megabytes. Unlimited is the
    // version that eventually fails on the device this app is mostly used on.
    expect(CAP).toBeGreaterThan(10);
    expect(CAP).toBeLessThanOrEqual(50);
  });

  it('is emptied when a new puzzle is cut', () => {
    const state = puzzle();
    const history = new History();
    history.push(snapshot(state, 'a'));
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
