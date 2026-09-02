import { describe, expect, it } from 'vitest';
import { toWorld } from '../clusters.js';
import {
  clusterOf,
  createPuzzle,
  findSnap,
  mergeClusters,
  moveCluster,
  pieceWorldOrigin,
  releaseCluster,
  type PuzzleState,
} from '../puzzle.js';
import { deserialize, serialize } from '../serialize.js';
import {
  addToTray,
  createTray,
  deleteTray,
  isHidden,
  isInTray,
  isOnHeader,
  moveTray,
  packTray,
  removeFromTray,
  renameTray,
  setTrayCollapsed,
  trayAt,
  trayBounds,
  trayMetrics,
  trayPieceCount,
} from '../trays.js';

function puzzle(rows = 5, cols = 5): PuzzleState {
  return createPuzzle({ seed: 8080, rows, cols, imageWidth: 1000, imageHeight: 1000 });
}

const idsOf = (s: PuzzleState, pieces: number[]): number[] => pieces.map((p) => clusterOf(s, p).id);

describe('createTray', () => {
  it('starts empty with a default name and width', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 100, y: 100 });
    expect(s.trays.size).toBe(1);
    expect(tray.name).toMatch(/Tray/);
    expect(tray.width).toBeGreaterThan(0);
    expect(tray.clusters).toEqual([]);
    expect(tray.collapsed).toBe(false);
  });

  it('can be created from a selection', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1, 2]) });
    expect(tray.clusters).toHaveLength(3);
    expect(trayPieceCount(s, tray)).toBe(3);
    for (const id of tray.clusters) expect(isInTray(s, id)).toBe(true);
  });

  it('gives every tray a distinct id', () => {
    const s = puzzle();
    const a = createTray(s, { x: 0, y: 0 });
    const b = createTray(s, { x: 0, y: 0 });
    expect(a.id).not.toBe(b.id);
  });
});

describe('packing', () => {
  it('places pieces inside the tray without overlapping', () => {
    const s = puzzle(6, 6);
    const tray = createTray(s, { x: 500, y: 500, clusters: idsOf(s, [0, 1, 2, 3, 4, 5, 6, 7]) });

    const rects = tray.clusters.map((id) => {
      const cluster = s.clusters.get(id)!;
      const pieceId = cluster.pieces[0]!;
      const piece = s.geometry.pieces[pieceId]!;
      const at = toWorld(cluster, piece.solved);
      return { x: at.x, y: at.y, w: piece.bounds.w, h: piece.bounds.h };
    });

    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        // Tabs interlock, so allow a little; centres must clearly not coincide.
        const overlapping = overlapX > a.w * 0.5 && overlapY > a.h * 0.5;
        expect(overlapping).toBe(false);
      }
    }
  });

  it('wraps onto new rows and grows the tray downwards', () => {
    const s = puzzle(6, 6);
    const few = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1]) });
    const shortHeight = trayBounds(s, few).h;

    addToTray(s, few.id, idsOf(s, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    expect(trayBounds(s, few).h).toBeGreaterThan(shortHeight);

    const packed = packTray(s, few);
    const rows = new Set(packed.items.map((i) => Math.round(i.y)));
    expect(rows.size).toBeGreaterThan(1);
  });

  it('keeps every packed item within the tray width', () => {
    const s = puzzle(6, 6);
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1, 2, 3, 4, 5, 6, 7, 8]) });
    const packed = packTray(s, tray);
    for (const item of packed.items) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x + item.w).toBeLessThanOrEqual(packed.width + 0.001);
    }
  });

  it('preserves insertion order so adding one piece does not reshuffle the tray', () => {
    const s = puzzle(6, 6);
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1, 2]) });
    const before = packTray(s, tray).items.map((i) => i.clusterId);
    addToTray(s, tray.id, idsOf(s, [3]));
    const after = packTray(s, tray).items.map((i) => i.clusterId);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('packs a multi-piece assembly as one unit', () => {
    const s = puzzle(6, 6);
    mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 1).id);
    const assembly = clusterOf(s, 0).id;
    const tray = createTray(s, { x: 200, y: 200, clusters: [assembly, clusterOf(s, 8).id] });

    expect(trayPieceCount(s, tray)).toBe(3);
    // Both pieces of the assembly still sit side by side in their solved relationship.
    const a = pieceWorldOrigin(s, 0);
    const b = pieceWorldOrigin(s, 1);
    const solvedGap = s.geometry.pieces[1]!.solved.x - s.geometry.pieces[0]!.solved.x;
    expect(b.x - a.x).toBeCloseTo(solvedGap, 6);
  });
});

describe('membership', () => {
  it('moves a cluster between trays rather than duplicating it', () => {
    const s = puzzle();
    const a = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1]) });
    const b = createTray(s, { x: 600, y: 0 });
    const moving = clusterOf(s, 0).id;

    addToTray(s, b.id, [moving]);

    expect(a.clusters).not.toContain(moving);
    expect(b.clusters).toContain(moving);
    expect(s.trayOfCluster.get(moving)).toBe(b.id);
  });

  it('removeFromTray leaves pieces on the board', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1, 2]) });
    const leaving = clusterOf(s, 1).id;
    removeFromTray(s, [leaving]);
    expect(isInTray(s, leaving)).toBe(false);
    expect(tray.clusters).not.toContain(leaving);
    expect(s.clusters.has(leaving)).toBe(true);
  });

  it('deleting a tray keeps its pieces', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1, 2]) });
    const held = [...tray.clusters];
    deleteTray(s, tray.id);
    expect(s.trays.size).toBe(0);
    for (const id of held) {
      expect(s.clusters.has(id)).toBe(true);
      expect(isInTray(s, id)).toBe(false);
    }
  });

  it('drops a cluster from its tray when it is absorbed by a merge', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1]) });
    const absorbed = clusterOf(s, 1).id;
    mergeClusters(s, clusterOf(s, 0).id, absorbed);
    expect(tray.clusters).not.toContain(absorbed);
    expect(s.trayOfCluster.has(absorbed)).toBe(false);
  });
});

describe('collapsing', () => {
  it('shrinks to header height and hides its contents', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1, 2, 3]) });
    const open = trayBounds(s, tray);

    setTrayCollapsed(s, tray.id, true);
    const shut = trayBounds(s, tray);

    expect(shut.h).toBeLessThan(open.h);
    expect(shut.h).toBeCloseTo(trayMetrics(s).header, 6);
    for (const id of tray.clusters) expect(isHidden(s, id)).toBe(true);
  });

  it('re-places its pieces when expanded after being dragged away', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1, 2]) });
    setTrayCollapsed(s, tray.id, true);
    moveTray(s, tray.id, 900, 700);
    setTrayCollapsed(s, tray.id, false);

    const bounds = trayBounds(s, tray);
    for (const id of tray.clusters) {
      const cluster = s.clusters.get(id)!;
      const at = toWorld(cluster, s.geometry.pieces[cluster.pieces[0]!]!.solved);
      expect(at.x).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(at.y).toBeGreaterThanOrEqual(bounds.y - 1);
      expect(at.x).toBeLessThanOrEqual(bounds.x + bounds.w + 1);
      expect(at.y).toBeLessThanOrEqual(bounds.y + bounds.h + 1);
    }
  });

  it('a piece not in any tray is never hidden', () => {
    const s = puzzle();
    createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0]) });
    expect(isHidden(s, clusterOf(s, 7).id)).toBe(false);
  });
});

describe('moving a tray', () => {
  it('carries its pieces with it', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1, 2]) });
    const before = tray.clusters.map((id) => {
      const c = s.clusters.get(id)!;
      return toWorld(c, s.geometry.pieces[c.pieces[0]!]!.solved);
    });

    moveTray(s, tray.id, 250, -120);

    tray.clusters.forEach((id, i) => {
      const c = s.clusters.get(id)!;
      const now = toWorld(c, s.geometry.pieces[c.pieces[0]!]!.solved);
      expect(now.x - before[i]!.x).toBeCloseTo(250, 6);
      expect(now.y - before[i]!.y).toBeCloseTo(-120, 6);
    });
  });
});

describe('snapping and trays', () => {
  it('pieces in a tray do not connect to each other', () => {
    const s = puzzle();
    // Pieces 0 and 1 are neighbours. In a tray they may be packed adjacently.
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1]) });
    expect(tray.clusters).toHaveLength(2);
    for (const id of tray.clusters) expect(findSnap(s, id)).toBeNull();
  });

  it('a piece on the board will not snap to one sitting in a tray', () => {
    const s = puzzle();
    createTray(s, { x: 3000, y: 3000, clusters: idsOf(s, [0]) });

    // Piece 1 also neighbours 2 and 6, which are still solved on the board and would
    // legitimately catch it. Push them away so the trayed piece 0 is the only candidate.
    for (const id of [2, 6]) moveCluster(s, clusterOf(s, id).id, 5000, 5000);

    const cluster = clusterOf(s, 1);
    const piece = s.geometry.pieces[1]!;
    const at = toWorld(cluster, piece.solved);
    moveCluster(s, cluster.id, piece.solved.x - at.x, piece.solved.y - at.y);
    expect(findSnap(s, cluster.id)).toBeNull();
  });

  it('a piece taken out of a tray snaps normally again', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 3000, y: 3000, clusters: idsOf(s, [0]) });
    removeFromTray(s, [...tray.clusters]);

    const zero = clusterOf(s, 0);
    const p0 = s.geometry.pieces[0]!;
    const at0 = toWorld(zero, p0.solved);
    moveCluster(s, zero.id, p0.solved.x - at0.x, p0.solved.y - at0.y);

    expect(releaseCluster(s, zero.id).merges).toBeGreaterThan(0);
  });
});

describe('hit testing', () => {
  it('finds the tray under a point, and its header', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 400, y: 300, clusters: idsOf(s, [0, 1]) });
    const b = trayBounds(s, tray);
    const { header } = trayMetrics(s);

    expect(trayAt(s, { x: b.x + 5, y: b.y + 5 })?.id).toBe(tray.id);
    expect(trayAt(s, { x: b.x - 50, y: b.y - 50 })).toBeNull();

    expect(isOnHeader(s, tray, { x: b.x + 5, y: b.y + header * 0.5 })).toBe(true);
    expect(isOnHeader(s, tray, { x: b.x + 5, y: b.y + header * 2 })).toBe(false);
  });
});

describe('renaming', () => {
  it('takes a new name but refuses an empty one', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 0, y: 0 });
    renameTray(s, tray.id, 'Blue sky');
    expect(tray.name).toBe('Blue sky');
    renameTray(s, tray.id, '   ');
    expect(tray.name).toBe('Blue sky');
  });
});

describe('saving trays', () => {
  it('round-trips trays, their contents and their collapsed state', () => {
    const s = puzzle();
    const a = createTray(s, { x: 120, y: 340, clusters: idsOf(s, [0, 1, 2]) });
    renameTray(s, a.id, 'Blue sky');
    const b = createTray(s, { x: 800, y: 100, clusters: idsOf(s, [5, 6]) });
    setTrayCollapsed(s, b.id, true);

    const restored = deserialize(JSON.parse(JSON.stringify(serialize(s, {})))).state;

    expect(restored.trays.size).toBe(2);
    const ra = restored.trays.get(a.id)!;
    const rb = restored.trays.get(b.id)!;
    expect(ra.name).toBe('Blue sky');
    expect(ra.clusters).toEqual(a.clusters);
    expect(ra.x).toBe(120);
    expect(rb.collapsed).toBe(true);
    for (const id of ra.clusters) expect(restored.trayOfCluster.get(id)).toBe(a.id);
  });

  it('loads a v1 save, which predates trays, with none', () => {
    const s = puzzle();
    const saved = JSON.parse(JSON.stringify(serialize(s, {})));
    delete saved.trays;
    delete saved.nextTrayId;
    saved.version = 1;

    const restored = deserialize(saved).state;
    expect(restored.trays.size).toBe(0);
    expect(restored.nextTrayId).toBeGreaterThanOrEqual(1);
  });

  it('ignores tray members that no longer exist', () => {
    const s = puzzle();
    const tray = createTray(s, { x: 0, y: 0, clusters: idsOf(s, [0, 1]) });
    const saved = JSON.parse(JSON.stringify(serialize(s, {})));
    saved.trays[0].clusters.push(999999);

    const restored = deserialize(saved).state;
    expect(restored.trays.get(tray.id)!.clusters).not.toContain(999999);
  });
});
