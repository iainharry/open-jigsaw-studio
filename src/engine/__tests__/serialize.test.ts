import { describe, expect, it } from 'vitest';
import {
  clusterOf,
  createPuzzle,
  mergeClusters,
  moveCluster,
  nameCluster,
  pieceWorldOrigin,
  releaseCluster,
  scatter,
  type PuzzleState,
} from '../puzzle.js';
import { SAVE_FORMAT, SAVE_VERSION, deserialize, serialize } from '../serialize.js';
import type { GeometryOptions } from '../geometry.js';

const OPTS: GeometryOptions = { vertexJitter: 0.06, tabScale: 1, randomiseTabs: true };

function partlySolved(): PuzzleState {
  const s = createPuzzle({
    seed: 314159,
    rows: 4,
    cols: 6,
    imageWidth: 1200,
    imageHeight: 800,
    ...OPTS,
  });
  scatter(s, 314159, { x: -300, y: -300, w: 1800, h: 1400 });

  // Join a handful of pieces into a couple of assemblies and name one of them.
  mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 1).id);
  mergeClusters(s, clusterOf(s, 0).id, clusterOf(s, 6).id);
  nameCluster(s, clusterOf(s, 0).id, 'Top-left corner');
  mergeClusters(s, clusterOf(s, 20).id, clusterOf(s, 21).id);
  moveCluster(s, clusterOf(s, 0).id, 55.25, -13.75);
  s.elapsedMs = 987_654;
  return s;
}

function snapshot(s: PuzzleState): unknown {
  return s.geometry.pieces.map((p) => {
    const w = pieceWorldOrigin(s, p.id);
    const c = clusterOf(s, p.id);
    return [p.id, w.x, w.y, c.rotation, c.pieces.length, c.name];
  });
}

describe('serialize / deserialize', () => {
  it('round-trips every piece position exactly', () => {
    const s = partlySolved();
    const before = snapshot(s);

    const saved = JSON.parse(JSON.stringify(serialize(s, OPTS, { x: 12, y: 34, zoom: 0.75 })));
    const { state: restored, viewport } = deserialize(saved);

    expect(snapshot(restored)).toEqual(before);
    expect(viewport).toEqual({ x: 12, y: 34, zoom: 0.75 });
    expect(restored.elapsedMs).toBe(987_654);
    expect(restored.clusters.size).toBe(s.clusters.size);
    expect(restored.zOrder).toEqual(s.zOrder);
  });

  it('regenerates identical geometry rather than storing it', () => {
    const s = partlySolved();
    const saved = serialize(s, OPTS);
    expect(JSON.stringify(saved)).not.toContain('outline');
    const { state: restored } = deserialize(JSON.parse(JSON.stringify(saved)));
    expect(JSON.stringify(restored.geometry)).toBe(JSON.stringify(s.geometry));
  });

  it('keeps save files small even for a large puzzle', () => {
    const s = createPuzzle({ seed: 1, rows: 40, cols: 50, imageWidth: 6000, imageHeight: 4000 });
    scatter(s, 1, { x: 0, y: 0, w: 9000, h: 6000 });
    const bytes = JSON.stringify(serialize(s, {})).length;
    // 2,000 pieces should serialise in well under 250 KB.
    expect(bytes).toBeLessThan(250_000);
  });

  it('a restored puzzle still snaps correctly', () => {
    const s = partlySolved();
    const { state: restored } = deserialize(JSON.parse(JSON.stringify(serialize(s, OPTS))));

    // Move piece 2 next to the named assembly containing piece 1 and release it.
    const target = clusterOf(restored, 1);
    const piece2 = restored.geometry.pieces[2]!;
    const want = {
      x: target.x + (piece2.solved.x - target.pivotX),
      y: target.y + (piece2.solved.y - target.pivotY),
    };
    const current = pieceWorldOrigin(restored, 2);
    moveCluster(restored, clusterOf(restored, 2).id, want.x - current.x, want.y - current.y);

    const result = releaseCluster(restored, clusterOf(restored, 2).id);
    expect(result.merges).toBe(1);
    expect(clusterOf(restored, 2).name).toBe('Top-left corner');
  });

  it('refuses a save written by a newer version', () => {
    const s = partlySolved();
    const saved = serialize(s, OPTS);
    expect(() => deserialize({ ...saved, version: SAVE_VERSION + 1 })).toThrow(/newer version/);
  });

  it('refuses an unrecognised format', () => {
    const s = partlySolved();
    const saved = serialize(s, OPTS);
    expect(() => deserialize({ ...saved, format: 'something/else' as typeof SAVE_FORMAT })).toThrow(
      /unrecognised save format/,
    );
  });
});
