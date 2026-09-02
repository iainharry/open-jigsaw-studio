import { describe, expect, it } from 'vitest';
import { angleDelta, quantiseAngle, toWorld } from '../clusters.js';
import {
  clusterOf,
  clusterWorldBounds,
  clustersIntersecting,
  createPuzzle,
  edgeClusters,
  mergeClusters,
  moveCluster,
  moveClusters,
  pieceWorldOrigin,
  quantiseClusterRotations,
  releaseClusters,
  rotateClusters,
  scatter,
  selectionCentre,
  type PuzzleState,
} from '../puzzle.js';

function puzzle(rows = 4, cols = 4, rotationEnabled = false): PuzzleState {
  return createPuzzle({
    seed: 4242,
    rows,
    cols,
    imageWidth: 800,
    imageHeight: 800,
    settings: { rotationEnabled },
  });
}

describe('moveClusters', () => {
  it('moves every listed cluster by the same amount and leaves others alone', () => {
    const s = puzzle();
    const moving = [0, 1, 2].map((id) => clusterOf(s, id).id);
    const before = s.geometry.pieces.map((p) => pieceWorldOrigin(s, p.id));

    moveClusters(s, moving, 40, -25);

    for (const p of s.geometry.pieces) {
      const now = pieceWorldOrigin(s, p.id);
      const was = before[p.id]!;
      if (p.id <= 2) {
        expect(now.x - was.x).toBeCloseTo(40, 9);
        expect(now.y - was.y).toBeCloseTo(-25, 9);
      } else {
        expect(now.x).toBeCloseTo(was.x, 9);
        expect(now.y).toBeCloseTo(was.y, 9);
      }
    }
  });

  it('ignores ids that no longer exist', () => {
    const s = puzzle();
    const gone = clusterOf(s, 1).id;
    mergeClusters(s, clusterOf(s, 0).id, gone);
    expect(() => moveClusters(s, [gone, 99999], 10, 10)).not.toThrow();
  });
});

describe('rotateClusters', () => {
  it('rotates a selection rigidly about a shared point, preserving relative positions', () => {
    const s = puzzle();
    const ids = [0, 1, 4, 5].map((id) => clusterOf(s, id).id);
    const centre = selectionCentre(s, ids)!;

    const before = new Map([0, 1, 4, 5].map((id) => [id, pieceWorldOrigin(s, id)]));
    const pairDistance = (a: number, b: number): number => {
      const pa = pieceWorldOrigin(s, a);
      const pb = pieceWorldOrigin(s, b);
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };
    const wasSpread = pairDistance(0, 5);

    rotateClusters(s, ids, Math.PI / 2, centre);

    // Distances within the selection are unchanged: it turned as one rigid body.
    expect(pairDistance(0, 5)).toBeCloseTo(wasSpread, 6);
    // And every piece actually moved.
    for (const id of [0, 1, 4, 5]) {
      const was = before.get(id)!;
      const now = pieceWorldOrigin(s, id);
      expect(Math.hypot(now.x - was.x, now.y - was.y)).toBeGreaterThan(1);
    }
    for (const id of ids) expect(angleDelta(s.clusters.get(id)!.rotation, Math.PI / 2)).toBeLessThan(1e-9);
  });

  it('four quarter-turns return a cluster exactly where it started', () => {
    const s = puzzle();
    const id = clusterOf(s, 5).id;
    const about = { x: 123, y: 456 };
    const before = pieceWorldOrigin(s, 5);

    for (let i = 0; i < 4; i++) rotateClusters(s, [id], Math.PI / 2, about);

    const after = pieceWorldOrigin(s, 5);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(angleDelta(s.clusters.get(id)!.rotation, 0)).toBeLessThan(1e-9);
  });
});

describe('quantiseAngle', () => {
  it('snaps to the nearest quarter turn', () => {
    expect(quantiseAngle(0.05)).toBeCloseTo(0, 9);
    expect(quantiseAngle(Math.PI / 2 + 0.1)).toBeCloseTo(Math.PI / 2, 9);
    expect(quantiseAngle(-Math.PI / 2 - 0.1)).toBeCloseTo(-Math.PI / 2, 9);
    expect(Math.abs(quantiseAngle(Math.PI - 0.05))).toBeCloseTo(Math.PI, 9);
  });

  it('lets a hand-twisted piece become snappable again', () => {
    const s = puzzle(3, 3, true);
    const id = clusterOf(s, 1).id;
    const cluster = s.clusters.get(id)!;

    // A gesture leaves it 7 degrees off square: too far to ever satisfy the snap test.
    cluster.rotation = 0.122;
    expect(angleDelta(cluster.rotation, 0)).toBeGreaterThan(s.settings.angleTolerance * 0.6);

    quantiseClusterRotations(s, [id]);
    expect(cluster.rotation).toBeCloseTo(0, 9);
  });
});

describe('releaseClusters', () => {
  it('releases a whole selection and reports the clusters they ended up in', () => {
    const s = puzzle(3, 3);
    scatter(s, 11, { x: -900, y: -900, w: 2600, h: 2600 }, { avoid: { x: 0, y: 0, w: 800, h: 800 } });

    // Put pieces 0, 1 and 2 back in place, then release them all at once.
    const ids: number[] = [];
    for (const pieceId of [0, 1, 2]) {
      const cluster = clusterOf(s, pieceId);
      const piece = s.geometry.pieces[pieceId]!;
      const at = toWorld(cluster, piece.solved);
      moveCluster(s, cluster.id, piece.solved.x - at.x, piece.solved.y - at.y);
      ids.push(cluster.id);
    }

    const result = releaseClusters(s, ids);

    expect(result.merges).toBeGreaterThanOrEqual(2);
    expect(result.clusterIds).toHaveLength(1);
    for (const id of result.clusterIds) expect(s.clusters.has(id)).toBe(true);
    expect(clusterOf(s, 0).pieces).toEqual([0, 1, 2]);
  });

  it('never returns an id that was absorbed during the release', () => {
    const s = puzzle(3, 3);
    const ids = [0, 1, 2].map((id) => clusterOf(s, id).id);
    const result = releaseClusters(s, ids);
    for (const id of result.clusterIds) expect(s.clusters.has(id)).toBe(true);
  });
});

describe('rubber-band selection', () => {
  it('finds exactly the clusters overlapping a world rectangle', () => {
    const s = puzzle(4, 4);
    // Solved layout: piece 0 occupies roughly (0,0)-(200,200).
    const hits = clustersIntersecting(s, { x: -10, y: -10, w: 210, h: 210 });
    expect(hits).toContain(clusterOf(s, 0).id);
    expect(hits).not.toContain(clusterOf(s, 15).id);
  });

  it('handles a rectangle dragged right-to-left or bottom-to-top', () => {
    const s = puzzle(4, 4);
    const forward = clustersIntersecting(s, { x: 0, y: 0, w: 400, h: 400 }).sort();
    const backward = clustersIntersecting(s, { x: 400, y: 400, w: -400, h: -400 }).sort();
    expect(backward).toEqual(forward);
  });

  it('selects nothing for a rectangle away from every piece', () => {
    const s = puzzle(4, 4);
    expect(clustersIntersecting(s, { x: 5000, y: 5000, w: 100, h: 100 })).toEqual([]);
  });

  it('grows a cluster bounding box as pieces join it', () => {
    const s = puzzle(4, 4);
    const before = clusterWorldBounds(s, clusterOf(s, 0).id)!;
    mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 1).id);
    const after = clusterWorldBounds(s, clusterOf(s, 0).id)!;
    expect(after.maxX).toBeGreaterThan(before.maxX);
  });
});

describe('edgeClusters', () => {
  it('finds exactly the border pieces of a grid', () => {
    const s = puzzle(5, 6);
    const edges = edgeClusters(s);
    // A 5x6 grid has 30 pieces, of which 3x4 = 12 are interior, so 18 are border.
    expect(edges).toHaveLength(18);
    for (const id of edges) {
      const piece = s.geometry.pieces[clusterOf(s, s.clusters.get(id)!.pieces[0]!).pieces[0]!]!;
      const borders = [piece.neighbours.top, piece.neighbours.right, piece.neighbours.bottom, piece.neighbours.left].filter((n) => n < 0).length;
      expect(borders).toBeGreaterThan(0);
    }
  });

  it('finds the four corners', () => {
    const s = puzzle(5, 6);
    expect(edgeClusters(s, { cornersOnly: true })).toHaveLength(4);
  });

  it('returns the cluster a border piece has joined, not the piece', () => {
    const s = puzzle(4, 4);
    // Join corner piece 0 to its neighbour 1; both are border pieces of one cluster.
    mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 1).id);
    const edges = edgeClusters(s);
    const joined = clusterOf(s, 0).id;
    expect(edges.filter((id) => id === joined)).toHaveLength(1);
  });

  it('treats every piece of a 1xN puzzle as an edge', () => {
    const s = puzzle(1, 4);
    expect(edgeClusters(s)).toHaveLength(4);
  });
});

describe('selectionCentre', () => {
  it('is the centre of the combined bounding box', () => {
    const s = puzzle(4, 4);
    const centre = selectionCentre(s, [clusterOf(s, 0).id, clusterOf(s, 15).id])!;
    expect(centre.x).toBeGreaterThan(300);
    expect(centre.x).toBeLessThan(500);
    expect(centre.y).toBeGreaterThan(300);
    expect(centre.y).toBeLessThan(500);
  });

  it('is null for an empty selection', () => {
    expect(selectionCentre(puzzle(), [])).toBeNull();
  });
});
