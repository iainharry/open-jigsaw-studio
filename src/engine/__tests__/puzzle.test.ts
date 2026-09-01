import { describe, expect, it } from 'vitest';
import { rotateAbout, toWorld } from '../clusters.js';
import {
  bringToFront,
  clusterOf,
  createPuzzle,
  findSnap,
  isComplete,
  mergeClusters,
  moveCluster,
  nameCluster,
  pieceWorldOrigin,
  progress,
  releaseCluster,
  scatter,
  type PuzzleState,
} from '../puzzle.js';

const EPS = 1e-9;

function makeSolved(rows = 4, cols = 4): PuzzleState {
  return createPuzzle({ seed: 2024, rows, cols, imageWidth: 800, imageHeight: 800 });
}

function worldOrigins(state: PuzzleState): Map<number, { x: number; y: number }> {
  const m = new Map<number, { x: number; y: number }>();
  for (const p of state.geometry.pieces) m.set(p.id, pieceWorldOrigin(state, p.id));
  return m;
}

describe('initial state', () => {
  it('starts with one cluster per piece, each in its solved position', () => {
    const s = makeSolved();
    expect(s.clusters.size).toBe(16);
    for (const p of s.geometry.pieces) {
      const w = pieceWorldOrigin(s, p.id);
      expect(Math.abs(w.x - p.solved.x)).toBeLessThan(EPS);
      expect(Math.abs(w.y - p.solved.y)).toBeLessThan(EPS);
    }
    expect(isComplete(s)).toBe(false);
    expect(progress(s)).toBe(0);
  });
});

describe('mergeClusters', () => {
  it('leaves the keeper exactly where it was and snaps the absorbed cluster into its frame', () => {
    const s = makeSolved();
    const keeper = clusterOf(s, 0).id;
    const absorbed = clusterOf(s, 1).id;

    // Displace the piece that is about to be absorbed.
    moveCluster(s, absorbed, 137.5, -42.25);
    const keeperBefore = pieceWorldOrigin(s, 0);

    mergeClusters(s, keeper, absorbed);

    expect(s.clusters.size).toBe(15);
    expect(clusterOf(s, 1).id).toBe(keeper);

    const keeperAfter = pieceWorldOrigin(s, 0);
    expect(Math.abs(keeperAfter.x - keeperBefore.x)).toBeLessThan(1e-9);
    expect(Math.abs(keeperAfter.y - keeperBefore.y)).toBeLessThan(1e-9);

    // The absorbed piece is now exactly where it belongs relative to the keeper.
    const p1 = s.geometry.pieces[1]!;
    const w1 = pieceWorldOrigin(s, 1);
    expect(Math.abs(w1.x - p1.solved.x)).toBeLessThan(1e-9);
    expect(Math.abs(w1.y - p1.solved.y)).toBeLessThan(1e-9);
  });

  it('preserves the world position of every already-joined piece across repeated merges', () => {
    const s = makeSolved(3, 3);
    // Build a cluster of the top row, then displace it and absorb more.
    mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 1).id);
    mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 2).id);
    moveCluster(s, clusterOf(s, 0).id, -300, 220);

    const before = new Map([0, 1, 2].map((id) => [id, pieceWorldOrigin(s, id)]));
    mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 4).id);

    for (const id of [0, 1, 2]) {
      const a = before.get(id)!;
      const b = pieceWorldOrigin(s, id);
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9);
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-9);
    }
  });

  it('keeps a group name when an unnamed cluster is absorbed', () => {
    const s = makeSolved();
    nameCluster(s, clusterOf(s, 0).id, 'House roof');
    mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 1).id);
    expect(clusterOf(s, 0).name).toBe('House roof');
  });
});

describe('findSnap', () => {
  it('snaps a piece released just inside the tolerance', () => {
    const s = makeSolved();
    const cell = Math.min(s.geometry.cellWidth, s.geometry.cellHeight);
    const tol = s.settings.snapTolerance * cell;

    const cid = clusterOf(s, 1).id;
    moveCluster(s, cid, tol * 0.7, 0);

    // Piece 1 has three neighbours (0, 2, 5), all still solved and all equally within
    // tolerance, so which one findSnap names first is arbitrary and unimportant --
    // releaseCluster merges every one of them. Assert the contract, not the ordering.
    const neighbours = [0, 2, 5].map((id) => clusterOf(s, id).id);
    expect(neighbours).toContain(findSnap(s, cid));

    releaseCluster(s, cid);
    // Every other piece is still sitting solved, so the merge cascades outward from
    // the first join and consumes the whole board. That is the release loop working:
    // in play the rest of the pieces are scattered and no cascade happens.
    expect(clusterOf(s, 1).pieces).toContain(0);
    expect(clusterOf(s, 1).pieces).toContain(2);
    expect(clusterOf(s, 1).pieces).toContain(5);
    expect(s.clusters.size).toBe(1);
  });

  it('snaps to the one neighbour that is actually in range', () => {
    const s = makeSolved();
    const cell = Math.min(s.geometry.cellWidth, s.geometry.cellHeight);
    const tol = s.settings.snapTolerance * cell;

    // Push every neighbour of piece 1 far away except piece 0.
    for (const id of [2, 5]) moveCluster(s, clusterOf(s, id).id, 900, 900);

    const cid = clusterOf(s, 1).id;
    moveCluster(s, cid, 0, tol * 0.6);
    expect(findSnap(s, cid)).toBe(clusterOf(s, 0).id);
  });

  it('does not snap a piece released outside the tolerance', () => {
    const s = makeSolved();
    const cell = Math.min(s.geometry.cellWidth, s.geometry.cellHeight);
    const tol = s.settings.snapTolerance * cell;

    const cid = clusterOf(s, 1).id;
    moveCluster(s, cid, tol * 1.4, 0);
    expect(findSnap(s, cid)).toBeNull();
  });

  it('never snaps to a non-neighbour, however close it is', () => {
    const s = makeSolved(4, 4);
    // Move piece 15 (bottom-right corner) directly on top of piece 0 (top-left).
    const p0 = s.geometry.pieces[0]!;
    const p15 = s.geometry.pieces[15]!;
    const cid = clusterOf(s, 15).id;
    moveCluster(s, cid, p0.solved.x - p15.solved.x, p0.solved.y - p15.solved.y);
    expect(findSnap(s, cid)).toBeNull();
  });

  it('respects rotation when rotation is enabled', () => {
    const s = createPuzzle({
      seed: 5,
      rows: 3,
      cols: 3,
      imageWidth: 600,
      imageHeight: 600,
      settings: { rotationEnabled: true },
    });
    const cid = clusterOf(s, 1).id;
    const cluster = s.clusters.get(cid)!;
    cluster.rotation = Math.PI / 2;
    expect(findSnap(s, cid)).toBeNull();

    cluster.rotation = 0;
    expect(findSnap(s, cid)).not.toBeNull();
  });

  it('snaps a rotated assembly to an equally rotated neighbour', () => {
    const s = createPuzzle({
      seed: 5,
      rows: 3,
      cols: 3,
      imageWidth: 600,
      imageHeight: 600,
      settings: { rotationEnabled: true },
    });
    // Rotate pieces 0 and 1 identically about the same world point: they are still
    // correctly positioned relative to each other, so they must still snap.
    const about = { x: 100, y: 100 };
    for (const id of [0, 1]) {
      rotateAbout(s.clusters.get(clusterOf(s, id).id)!, Math.PI / 3, about);
    }
    expect(findSnap(s, clusterOf(s, 1).id)).toBe(clusterOf(s, 0).id);

    releaseCluster(s, clusterOf(s, 1).id);
    expect(clusterOf(s, 1).pieces).toEqual([0, 1]);
    expect(clusterOf(s, 1).rotation).toBeCloseTo(Math.PI / 3, 10);
  });
});

describe('releaseCluster', () => {
  it('connects to every available neighbour in one release', () => {
    const s = makeSolved(3, 3);
    // Assemble everything except the centre piece (id 4).
    const ids = [0, 1, 2, 3, 5, 6, 7, 8];
    let keeper = clusterOf(s, 0).id;
    for (const id of ids.slice(1)) {
      mergeClusters(s, keeper, clusterOf(s, id).id);
      keeper = clusterOf(s, 0).id;
    }
    expect(s.clusters.size).toBe(2);

    // Drop the centre piece into the hole, slightly off.
    const centre = clusterOf(s, 4).id;
    moveCluster(s, centre, 3, -2);
    const result = releaseCluster(s, centre);

    expect(result.merges).toBeGreaterThanOrEqual(1);
    expect(s.clusters.size).toBe(1);
    expect(isComplete(s)).toBe(true);
    expect(progress(s)).toBe(1);
  });

  it('leaves a stray piece alone', () => {
    const s = makeSolved();
    const cid = clusterOf(s, 5).id;
    moveCluster(s, cid, 400, 400);
    const result = releaseCluster(s, cid);
    expect(result.merges).toBe(0);
    expect(result.clusterId).toBe(cid);
    expect(s.clusters.size).toBe(16);
  });

  it('solves the whole puzzle piece by piece', () => {
    const s = makeSolved(4, 5);
    scatter(s, 999, { x: -400, y: -400, w: 1800, h: 1800 });
    expect(s.clusters.size).toBe(20);

    // Put every piece back in its solved place and release it.
    for (const piece of s.geometry.pieces) {
      const cluster = clusterOf(s, piece.id);
      const current = toWorld(cluster, piece.solved);
      moveCluster(s, cluster.id, piece.solved.x - current.x, piece.solved.y - current.y);
      releaseCluster(s, cluster.id);
    }

    expect(s.clusters.size).toBe(1);
    expect(isComplete(s)).toBe(true);
  });
});

describe('scatter', () => {
  it('is deterministic for a given seed and moves pieces off their solved spots', () => {
    const area = { x: -200, y: -200, w: 1400, h: 1400 };
    const a = makeSolved();
    const b = makeSolved();
    scatter(a, 77, area);
    scatter(b, 77, area);
    expect([...worldOrigins(a)]).toEqual([...worldOrigins(b)]);

    const c = makeSolved();
    scatter(c, 78, area);
    expect([...worldOrigins(c)]).not.toEqual([...worldOrigins(a)]);

    let moved = 0;
    for (const p of a.geometry.pieces) {
      const w = pieceWorldOrigin(a, p.id);
      if (Math.hypot(w.x - p.solved.x, w.y - p.solved.y) > 1) moved++;
    }
    expect(moved).toBe(a.geometry.pieces.length);
  });

  it('keeps pieces off the board when given an avoid rectangle', () => {
    const s = makeSolved(5, 5);
    const board = { x: 0, y: 0, w: 800, h: 800 };
    scatter(s, 3, { x: -600, y: -600, w: 2000, h: 2000 }, { avoid: board });

    for (const p of s.geometry.pieces) {
      const w = pieceWorldOrigin(s, p.id);
      const overlapsX = w.x < board.x + board.w && w.x + p.bounds.w > board.x;
      const overlapsY = w.y < board.y + board.h && w.y + p.bounds.h > board.y;
      expect(overlapsX && overlapsY).toBe(false);
    }
  });

  it('falls back gracefully when there is no room outside the avoid rectangle', () => {
    const s = makeSolved(3, 3);
    const board = { x: 0, y: 0, w: 800, h: 800 };
    // Scatter area is the board itself: every band is empty.
    expect(() => scatter(s, 4, board, { avoid: board })).not.toThrow();
    for (const p of s.geometry.pieces) {
      const w = pieceWorldOrigin(s, p.id);
      expect(Number.isFinite(w.x)).toBe(true);
      expect(Number.isFinite(w.y)).toBe(true);
    }
  });

  it('keeps scattered pieces inside the requested area', () => {
    const area = { x: 0, y: 0, w: 2000, h: 1500 };
    const s = makeSolved(5, 5);
    scatter(s, 1, area);
    for (const p of s.geometry.pieces) {
      const w = pieceWorldOrigin(s, p.id);
      expect(w.x).toBeGreaterThanOrEqual(area.x - 1);
      expect(w.y).toBeGreaterThanOrEqual(area.y - 1);
      expect(w.x + p.bounds.w).toBeLessThanOrEqual(area.x + area.w + 1);
      expect(w.y + p.bounds.h).toBeLessThanOrEqual(area.y + area.h + 1);
    }
  });
});

describe('z-order', () => {
  it('brings a cluster to the front and keeps every cluster represented once', () => {
    const s = makeSolved();
    bringToFront(s, clusterOf(s, 3).id);
    expect(s.zOrder[s.zOrder.length - 1]).toBe(clusterOf(s, 3).id);
    expect(new Set(s.zOrder).size).toBe(s.clusters.size);
  });

  it('drops the absorbed cluster from the z-order on merge', () => {
    const s = makeSolved();
    const absorbed = clusterOf(s, 1).id;
    mergeClusters(s, clusterOf(s, 0).id, absorbed);
    expect(s.zOrder).not.toContain(absorbed);
    expect(s.zOrder.length).toBe(s.clusters.size);
  });
});
