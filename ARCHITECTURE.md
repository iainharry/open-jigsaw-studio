# Architecture and decision record

Status of this document: covers M1 (a playable puzzle engine). Update it as decisions
change; do not let it drift.

## 1. Layers

```
src/engine/    headless. no DOM, no canvas, no framework. runs in Node.
src/render/    Canvas2D renderer, baked-bitmap cache, viewport maths.
src/input/     Pointer Events -> engine operations.
src/ui/        shell, IndexedDB persistence, reference panel.
scripts/       benchmark and end-to-end smoke test (Playwright, dev-only).
```

The line between `engine` and everything else is the single most important structural
decision in the project, for two reasons.

**Testability.** A browser driver cannot usefully assert that releasing a piece twelve
pixels from its neighbour merges two clusters. A Node test can, in about a millisecond.
All 38 current tests run headless in 1.4 seconds. If engine code ever needs jsdom, the
boundary has leaked and the fix is to move the offending code out of `engine/`.

**Performance.** Piece positions never pass through the UI layer. At 2,000 pieces and
60fps there is no framework reconciliation cheap enough to sit in that path. The UI sees
"puzzle open, 47% connected"; the renderer reads engine state directly.

## 2. Clusters are the unit of movement — from day one

A connected group of pieces is a `Cluster`. A loose single piece is a cluster of one. A
user's named subassembly will be a cluster with a `name` set.

This is deliberate and it is not how the original plan sequenced things. The plan
scheduled "named groups" as a late milestone, on the reasoning that the puzzle state
should stabilise first. But snapped-together pieces *already* have to move, rotate,
serialise and snap as a unit — the structure exists whether or not the feature does.
Adding a separate group concept later would mean two parallel structures that both have
to be correct in all four of those respects.

So the differentiator costs almost nothing now (`name`, plus UI) and would have cost a
rewrite of the state model, the snap engine and the save format later.

Transform model: each cluster has a rotation and a translation about a pivot, where the
pivot is the centroid of its members' *solved* positions. A cluster in its solved place
has rotation 0 and translation equal to its pivot, so world coordinates equal image
coordinates. `repivot()` compensates the translation when membership changes, so merging
never teleports an assembly.

Rotation is in the model and in the snap maths from the start even though the M1 UI does
not expose it, because retrofitting rotation into snapping means rewriting it.

## 3. A piece is an outline plus a UV rect

`PieceGeometry` is a closed cubic-bezier outline in image space plus a bounding box that
doubles as the UV rectangle into the source image. Nothing about it is Canvas2D-specific.

This is the decision that determines whether 2,000 pieces is reachable, and it is the one
that genuinely cannot be deferred to a later "performance" milestone. The two candidate
representations are:

| | memory at 2,000 pieces from a 24 MP source |
|---|---|
| baked per-piece bitmap | ~186 MB of RGBA, plus ~96 MB for the decoded source |
| triangulated mesh sampling one texture | ~45 MB texture, ~1.3 MB vertex data |

The first is an out-of-memory crash on a mid-range Android tablet, not a slow frame. The
outline+UV representation supports both, so the renderer stays swappable while the data
model does not have to change.

## 4. Neighbouring edges are shared, not matched

The boundary between two pieces is generated once, stored once, and traversed forwards by
one piece and backwards by the other. Complementary tabs are true by construction rather
than by two independent calculations agreeing. `geometry.test.ts` asserts it across every
interior edge of a 6x7 grid, but the test can only confirm what the data structure already
guarantees.

Grid vertices are jittered (corners pinned, border vertices sliding only along their
border) so pieces are not a uniform lattice, and every tab's width, height, neck and
centre offset varies. Both are deterministic.

## 5. Geometry is derived; save files store state only

Save files carry the seed, the grid, the geometry options, and per-cluster transforms.
Geometry is regenerated on load. A 2,000-piece save is under 250 KB (asserted in
`serialize.test.ts`) instead of several megabytes, and a puzzle shared as a seed
reproduces exactly on another device.

This works only because generation is fully deterministic. `Math.random()` must never
appear in `src/engine/` except in `randomSeed()`, which exists precisely to produce a seed
to store. Edge parameters are drawn from per-edge streams derived from `(seed, kind, row,
col)`, so geometry does not depend on generation order — which leaves the door open to
generating pieces lazily or in a worker without changing the result.

## 6. Bake cache and the memory budget

Canvas2D cannot clip a path per piece per frame at a useful frame rate, so each piece is
rasterised once into a small bitmap and blitted thereafter. The cost is memory, so bakes
are quantised to zoom buckets (a small zoom change does not invalidate everything), capped
at source resolution, budgeted in bytes (96 MB default) and evicted least-recently-used.
Off-screen pieces are culled by world AABB and cost nothing.

## 7. Measured performance (M1)

`node scripts/bench.mjs`, Chromium with software rendering (SwiftShader) in a container,
90 frames of continuous panning per row, 4400x3000 source image. Real hardware will be
faster; these are a floor, not a ceiling.

Desktop profile (1600x1000, dpr 1) and tablet profile
(`BENCH_W=1180 BENCH_H=820 BENCH_DPR=2`), fitted to view:

| pieces | desktop median / p95 | tablet median / p95 | baked (desktop / tablet) |
|---|---|---|---|
| 54 | 0.5 / 2.0 ms | 0.4 / 1.0 ms | 1.0 / 4.1 MB |
| 204 | 1.3 / 2.8 ms | 1.2 / 1.9 ms | 1.1 / 4.2 MB |
| 486 | 3.7 / 4.4 ms | 3.3 / 5.2 ms | 1.1 / 4.3 MB |
| 988 | 5.5 / 7.9 ms | 6.4 / 16.7 ms | 1.1 / 4.4 MB |
| 1998 | 12.8 / 17.1 ms | 12.9 / 21.4 ms | 1.2 / 4.5 MB |

The dense case — a fully assembled 2,000-piece puzzle inspected at 1:1 zoom, which is
where per-piece bakes are largest and culling matters most:

| profile | median / p95 | drawn / culled | baked |
|---|---|---|---|
| desktop | 4.9 / 11.3 ms | 370 / 1628 | 16.7 MB |
| tablet (dpr 2) | 4.7 / 10.9 ms | 247 / 1751 | 12.0 MB |

Reading: 2,000 pieces fitted to view is ~78 fps median on a software rasteriser, on both
profiles. Zoomed in, culling removes 85–90% of the work and memory peaks around 17 MB —
nowhere near the ~186 MB that a naive full-resolution bake of every piece would cost,
because bakes follow *display* resolution and the LRU budget bounds the working set.

A methodological note, because it bit this benchmark once: pieces start scattered in a
ring outside the board, so measuring "zoomed in at the board centre" was measuring an
empty region and reporting a flatteringly cheap frame (0 pieces drawn). The dense-case row
now solves the puzzle first. Watch for this if you add profiles.

Conclusion for now: **Canvas2D is sufficient, and a WebGL renderer is not yet justified.**
Revisit if p95 exceeds 16 ms on real target hardware, or when rotation animation and
2,000+ pieces are combined. The tablet p95 at 988 pieces (16.7 ms) is the first number
that is close to the line and is worth re-measuring on the actual device.

## 8. Dependencies and licences

Runtime dependencies: **none.** The built bundle is 28 KB (10 KB gzipped).

| package | role | licence |
|---|---|---|
| typescript | build | Apache-2.0 |
| vite | build/dev server | MIT |
| vitest | tests | MIT |
| @types/node | build types | MIT |
| playwright | bench/smoke scripts, not installed by default | Apache-2.0 |

Project licence: MIT.

### Libraries considered and rejected

Checked on 2026-09-01. The point of recording this is that a permissive licence and a
tidy README are not evidence a project is viable to depend on.

| project | licence | finding | decision |
|---|---|---|---|
| [jigsaw-canvas](https://github.com/ygongdev/jigsaw-canvas) | MIT | **4 stars, 0 forks.** A single author's project with no community and no bus factor. | Rejected as a foundation. Fine as reading. |
| [headbreaker](https://github.com/flbulgarelli/headbreaker) | ISC (not MIT as often reported) | 187 stars, last release July 2023. Konva-backed, so it inherits the per-piece scene-graph memory model. | Rejected. Its piece model would not survive our piece counts. |
| [Konva](https://github.com/konvajs/konva) | MIT | Excellent, well maintained. Retained-mode scene graph: one node with its own cached canvas per piece. | Rejected for the board. Great to ~200 pieces, a wall past 1,000, and adopting it means writing the renderer twice. |
| [tui.image-editor](https://github.com/nhn/tui.image-editor) | MIT | Last release April 2022, 263 open issues. Bundles fabric.js. | Rejected. Crop/rotate/resize is ~100 lines we own; a 500 KB abandoned dependency for three operations is a bad trade. |
| [browser-image-compression](https://github.com/Donaldcwl/browser-image-compression) | MIT | Reasonable, but `createImageBitmap` with `resizeWidth`/`resizeQuality` and `imageOrientation: 'from-image'` covers downscaling and EXIF orientation natively. | Not needed. Revisit if we hit format edge cases. |
| [@use-gesture](https://github.com/pmndrs/use-gesture) | MIT | Good library, React-oriented. | Not needed. Pointer Events give mouse, touch and pen on one path in ~250 lines. |
| [react-jigsaw-puzzle](https://github.com/yuri-becker/react-jigsaw-puzzle) | **GPL-3.0** | Incompatible with an MIT project. | Do not read the source. Not referenced. |

## 9. Platform plan

Web/PWA first, and probably for a long time. An installable PWA covers Windows (Edge or
Chrome), Android tablet, and a TV browser — offline, no store, no signing, no native code.
iOS is the only real gap, and iOS is also where a native shell is hardest.

A native shell (Tauri 2 or equivalent) is deferred until a concrete limitation forces it,
rather than adopted on the assumption that it will be needed. `VITE_BASE=/` builds for
root hosting when that day comes.

## 10. Known limitations after M1

- No rotation UI. The model supports it; nothing exposes it.
- No image crop/rotate before generation. Images are downscaled to 4000 px on the long
  edge and used whole.
- No puzzle library UI. Multiple puzzles are stored in IndexedDB but only the last one
  reopens.
- No named-group UI. `nameCluster()` exists and round-trips through save files; nothing
  calls it yet.
- No piece trays.
- The piece-count cap uses a fixed 60 px minimum piece edge. It is a reasonable default
  but has not been validated against how puzzles actually feel on a tablet.
- Bake cache eviction is LRU over a byte budget with no cost model — a piece that is
  expensive to bake is treated the same as a cheap one.
- Reference panel is a fixed side panel; the plan's floating/bottom/hidden modes are not
  implemented.
