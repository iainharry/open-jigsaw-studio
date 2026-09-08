# Architecture and decision record

Status of this document: covers M1 to M7 (engine, selection, rotation, library, trays,
colour sorting, shipping, image preparation, and assistance levels).
Update it as decisions change; do not let it drift.

## 1. Layers

```
src/engine/    headless. no DOM, no canvas, no framework. runs in Node.
src/render/    Canvas2D renderer, baked-bitmap cache, viewport maths.
src/input/     Pointer Events -> engine operations.
src/ui/        shell, IndexedDB persistence, reference panel.
scripts/       benchmark, smoke test, PWA check, service-worker generator.
```

The line between `engine` and everything else is the single most important structural
decision in the project, for two reasons.

**Testability.** A browser driver cannot usefully assert that releasing a piece twelve
pixels from its neighbour merges two clusters. A Node test can, in about a millisecond.
All 138 current tests run headless in about 1.5 seconds. If engine code ever needs jsdom, the
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

Runtime dependencies: **none.** The built bundle is 72 KB (24 KB gzipped).

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

## 10. Selection, and a correction about groups

Section 2 says a named group is just a cluster with a name. That holds for **connected**
groups — pieces you have joined and want to name and move as a unit — because a cluster is
rigid at its members' solved offsets, which is exactly right for joined pieces.

It does **not** hold for trays. "Put all the sky pieces here" involves unconnected pieces
that must keep independent positions and be packed for convenience, not held at their
solved offsets. A tray is therefore a genuinely separate concept: a named set of cluster
ids plus a layout, not a cluster.

Both need the same foundation, which is why selection came first:

- **Selection lives in the interaction layer, not the engine.** Which pieces are
  highlighted is not part of a puzzle and does not belong in a save file. The engine
  provides the vocabulary — `moveClusters`, `rotateClusters`, `releaseClusters`,
  `clustersIntersecting`, `selectionCentre` — so multi-piece operations are one tested
  function rather than a loop in the UI.
- **`releaseClusters` must not return dead ids.** Releasing one cluster can absorb another
  still waiting in the list, so it re-checks membership every iteration and filters the
  result. Returning a retired id would leave the UI holding a selection of nothing.

## 11. Rotation

Rotation was in the transform model and the snap test from M1; M2 exposed it.

Two rules make it usable rather than merely present:

- **Free rotation is quantised to quarter turns on release.** A twist gesture produces an
  arbitrary angle, and an arbitrary angle can never satisfy the snap test — the piece
  would be permanently three degrees off and unsolvable. Quantising means a rough twist
  gets you close and the app finishes the job.
- **Turning rotation off straightens every cluster.** With rotation disabled the snap test
  ignores angle entirely, so a piece left at an angle would snap home while visibly
  sideways.

A second finger landing mid-drag means "turn this piece", not "abandon it and zoom" — that
is the gesture people make with a physical piece. The pinch handler checks for an active
drag before claiming the pointers.

## 12. Zoom, and the hard limit on legible pieces

A 500-piece puzzle arrived on a 31-inch monitor with 28-pixel pieces. The cause was the
default view: opening a puzzle fitted *all* content, and the scatter ring made total
content five times the board area, so the app opened zoomed most of the way out.

Fixed three ways: the ring is now sized from the area the pieces actually need rather
than a fixed fraction of the board; a new puzzle opens fitted to the **board**, not to
everything; and there are real zoom controls with an on-screen piece-size readout.

But there is an arithmetic ceiling underneath, and no zoom default can move it. On a
2560x1300 canvas:

| piece size | area of 500 pieces | share of the screen |
|---|---|---|
| 40 px | 0.8 M px² | 24% |
| 55 px | 1.5 M px² | 45% |
| 64 px | 2.1 M px² | 62% |
| 80 px | 3.2 M px² | 96% |

Above about 55–65 px the pieces alone cover most of the screen, before any gaps between
them or the board they are being assembled on. **You cannot show 500 legible pieces at
once on any monitor.** Fit-board lands at roughly 64 px for a 3000x2000 photo, which is
essentially the ceiling. Beyond that the player must work zoomed in and pan — which is
the argument for piece trays, and the reason they are the next feature rather than a
nicety.

### Frame-time reporting

The footer reported 83 ms/frame at 486 pieces where a benchmark of the same view measured
1.3 ms. `lastFrameMs` was the culprit: once the view settles the app stops drawing, so the
last frame recorded is whichever one happened to bake a few hundred pieces after a zoom
change. The footer now shows the median of the last 60 frames. The benchmark still samples
`lastFrameMs` per frame and computes its own median, which is correct there.

The underlying spike is real, if minor: a zoom change invalidates the bake bucket and
re-bakes every visible piece in a single frame. A per-frame baking budget would smooth it.
Not built — it is one stutter after a zoom, not a steady-state cost.

### Measured on a 2560x1400 canvas (dpr 1), fitted to board

| pieces | median | p95 | drawn / culled |
|---|---|---|---|
| 204 | 0.7 ms | 1.4 ms | 99 / 105 |
| 486 | 1.3 ms | 2.3 ms | 174 / 312 |
| 988 | 2.7 ms | 5.0 ms | 353 / 635 |
| 1998 | 5.0 ms | 10.2 ms | 688 / 1310 |

Faster than the fit-all figures in section 7 precisely because fitting the board zooms in
further, so culling removes more work.

## 13. Trays

A tray is a named, movable region that holds **clusters** and packs them into rows.

### Why a tray is not a cluster

The M1 note claimed a named group is "just a cluster with a name". Section 10 already
corrected that for trays; this is the implementation of the correction. A cluster holds its
members rigidly at their *solved* offsets, which is exactly right for pieces you have
joined and exactly wrong for a box of unrelated sky pieces that need packing. So a tray
owns a list of cluster ids and positions them itself.

It holds clusters rather than pieces so that an assembly you have already joined can be
parked without coming apart.

### Collapsing is the feature

Section 12's arithmetic says 500 legible pieces cannot share a monitor however neatly they
are arranged, so tidying alone would not have helped. A collapsed tray is therefore skipped
in both the draw loop and the hit test — fifty pieces become one tile that neither renders
nor responds. Expanding re-packs, because while collapsed the pieces were not being drawn
and the tray may have been dragged elsewhere entirely.

### Rules that stop it being surprising

- **Pieces in a tray do not snap**, to each other or to the board. Packing puts unrelated
  pieces side by side, so two neighbours landing next to each other would join silently and
  pull an assembly out of the layout. `findSnap` returns null for a trayed cluster and skips
  trayed candidates.
- **A merge removes the absorbed cluster from its tray.** Otherwise the tray holds a dead
  id and mis-packs for ever after.
- **Packing preserves insertion order**, not size. Sorting by height would reshuffle the
  whole tray every time one piece was added, and a player expects to find pieces roughly
  where they put them.
- **Shelf packing, not a uniform grid**, because a tray can hold one piece and a
  twelve-piece assembly side by side and a grid sized to the largest member would waste
  most of the tray.
- **Deleting a tray keeps its pieces.** It expands first if collapsed, so they reappear
  where the tray was rather than at a stale position.
- **New trays go down the left of the current view**, stepping over existing ones. Centring
  them would drop a tray on the board, which is the one place it must not be.

### Save format

Trays took the save file to v2. A v1 file loads with no trays, which is what it had.
Members that no longer exist are dropped on load, so a hand-edited or corrupt file cannot
leave a tray holding phantom ids.

## 14. In-app help instead of a manual

Every toolbar control carries a `data-help` sentence, shown as a styled tooltip on hover
or keyboard focus. A smoke check asserts that no control is missing one, so the help cannot
quietly rot as controls are added.

`title` attributes were not enough on their own: they are slow, unstyled, truncate badly,
and — the decisive problem — **do not exist on touch**. A tablet has no hover, so pointing
at a control can never explain it there. Hence help mode: the **?** button makes a press
show the explanation instead of performing the action, which is the only way the same help
is reachable by finger without shipping a separate manual.

Implementation note worth keeping: help mode has to intercept `pointerdown`, `click` *and*
`change` in the capture phase. Swallowing `pointerdown` alone still lets the browser deliver
the `click` the toolbar listens for, so the button fired anyway — the first version looked
right and did nothing.

## 15. Colour sorting

`Sort by colour` groups the loose clusters and lets the player step through the groups,
selecting each in turn. Three decisions carry the design.

**It selects, it does not file.** Automatically creating six named trays would be a
judgement about the picture the algorithm is not entitled to make — "Blues" might be three
things the player wanted apart, or two they wanted together, and undoing a wrong guess
costs more than the sort saved. Stepping through costs one extra press per group and keeps
the decision with the person.

**Grouping happens in OKLab, not RGB.** Euclidean distance in sRGB does not match what the
eye calls similar; it will put a mid-blue nearer a dark grey than another blue. The whole
value of a colour sort is that the groups look like groups, so the space has to be
near-perceptually-uniform. There is a test asserting the blue/grey case specifically.

**k-means is seeded from the puzzle seed.** Sorting twice gives identical groups. A sort
that reshuffled every press would be unusable when working through groups one at a time.
Empty clusters are re-seeded on the worst-served point, so asking for six groups does not
quietly return five.

Sampling (`src/render/pieceColours.ts`) needs a canvas and so sits outside the engine. It
samples each piece's *nominal cell*, not its bounding box: the bounding box includes tab
overhang that reaches into the neighbour's part of the picture, which would drag a sky
piece towards green because of a tab poking into a tree. The image is analysed at 900px on
the long edge — colour averaging needs no more, and reading a 25-megapixel buffer would
cost ~100 MB and a visible pause for nothing.

### Frame-time reporting, again

Section 12 changed the footer from last-frame to a median of 60 frames. That was still
wrong after a change that rebakes: with only a handful of frames since the sort, all of
them baking, the footer read 28 ms where a measured steady state was 1.3 ms. Frames that
rasterised anything are now excluded from the median entirely. The spike is real, but it
happens once, and reporting it as the typical cost was simply false.

Worth recording what that investigation ruled out: selection outlines were the suspect,
since colour sorting makes 200-piece selections normal where before selections were a
handful. Measured cost of outlining 211 visible pieces: **0.0 ms**. Stroking cached Path2D
objects inside an existing transform is free at this scale.

## 16. Shipping: PWA, Pages, and portable files

**Deployment** is a GitHub Actions workflow that typechecks, runs the tests, builds and
publishes to Pages on every push to `main`. A push that breaks the engine fails the
workflow rather than deploying a broken puzzle.

**The service worker is written by hand** (`scripts/build-sw.mjs`, about sixty lines)
rather than pulled from a PWA plugin, because it is small enough to understand completely
and a plugin would be a build dependency with its own upgrade treadmill.

Its strategy exists to avoid the classic PWA failure — an app that caches itself on first
visit and then never updates for anyone again:

- **Navigations are network-first**, cache as fallback. Online you always get the deployed
  version. A cache-first navigation would pin every user to whatever was live the day they
  first opened it.
- **Hashed assets are cache-first.** Vite fingerprints them, so a hit can never be stale.
- **The cache name carries a build id** derived from the content hashes, and activating a
  new worker deletes every other cache. An identical rebuild does not churn clients.

`scripts/pwa-check.mjs` asserts the thing that otherwise fails silently: it serves the
build, lets the worker install, **kills the server**, reloads, and requires the app to
boot having made zero network requests.

### Backup without a cloud

"Can it save to Google Drive or OneDrive" has a good answer that involves neither
company's API. Point the app at a synced folder with the File System Access API and it
writes a `.jigsaw` file there on every save; the desktop sync client uploads it. No OAuth,
no account, no server, nothing to re-verify annually, and it works offline because writing
to a local folder does.

Deliberately **not** built: Drive/Graph OAuth integrations. They would require accounts —
contradicting the no-account rule — plus client registration, token storage, periodic
re-verification, and a redirect flow, in exchange for something a synced folder already
does.

Limits, recorded honestly: the API is desktop Chromium only (~27% of browsers, no mobile
at all), permission lapses between sessions and can only be re-requested during a user
gesture — which is why the autosave path never prompts — and this is file sync, not merge.
Two devices on one puzzle produce a conflict copy and one winner.

### The `.jigsaw` file

JSON with the image inlined as a data URL, not a zip. Base64 costs a third more bytes —
700 KB on a 2 MB photo — and buys no zip dependency, a diffable file, and something any
tool can open. Geometry is not stored; it regenerates from the seed, so the state costs
kilobytes regardless of piece count. An import always gets a **new** record id, so
importing the same file twice gives two puzzles rather than silently overwriting one you
were part-way through, while the image keeps its content hash so one photograph is still
stored once.

## 17. Image preparation

Crop, quarter turns, straighten, flip, and three light adjustments, applied before the
picture is cut. Three decisions carry it.

**An edit is parameters, never a second picture.** `ImageEdit` is a handful of numbers and
a rectangle stored on the puzzle record; the prepared picture is re-derived from the
original every time the puzzle opens. Storing the cropped result instead would have cost a
second copy of the photograph per puzzle, broken the content-hash deduplication that lets
six puzzles from one picture cost one picture, and made a crop permanent — reopening
preparation can widen a crop precisely because the original is still there. The smoke test
asserts the re-derivation specifically: it cuts a square puzzle from a landscape picture,
reloads, and requires the geometry to still be square.

**The crop lives in post-rotation coordinates.** `usableArea()` gives the largest
axis-aligned rectangle inside the straightened frame, which is what stops a three-degree
straighten leaving transparent wedges in the corners, and every crop is clamped into it.
The alternative — storing the crop against the unrotated photo — means the box crawls
across the picture while the straighten slider moves, which is exactly the interaction
people find maddening in photo editors.

**The maths is separated from the canvas.** `src/engine/imageEdit.ts` is pure geometry
over numbers and tests in Node (28 tests, including one that rotates each corner of the
inscribed rectangle back to prove it genuinely fits); `src/render/applyEdit.ts` holds the
canvas work. The order there is load-bearing — quarter turns, straighten, flip, crop,
colour, downscale — and it is two passes on purpose, since a single clever transform would
need the crop expressed in pre-rotation space.

Preparation always cuts a new puzzle. It cannot do otherwise: piece outlines are laid out
over a picture of a particular size, so changing the picture changes the puzzle. The
readout shows the resulting piece size live, because "2000 pieces" means something rather
different after a crop takes half the picture away.

Adjustments are deliberately three sliders driving CSS filters, not a photo editor. The
job is making a picture *puzzleable* — lifting a murky scan until piece colours can be
told apart — and levels, curves and white balance would be a different application.

The `.jigsaw` format carries the edit and claims **version 2 only when it has one**. A v1
reader given a cropped puzzle would lay pieces cut from the prepared picture over the
uncropped original and put every one of them in the wrong place; refusing the file is
better than showing nonsense. Unedited puzzles still claim v1, so ordinary files stay
openable by older builds.

### A write is not saved until its transaction commits

Reported from real use: a puzzle listed in the library that would not open, saying its
image was missing. It was.

`run()` resolved its promise on the *request's* `onsuccess`, which fires while the
transaction is still open. A transaction can abort afterwards — a quota error rolls the
whole thing back — so a write could report success for data that was never stored. The
image write in `adoptImage()` was additionally `.catch()`-ed to nothing, and the puzzle
record was written straight after, so the failure mode was a record outliving its picture
with no complaint anywhere.

Three changes. Writes now resolve on `tx.oncomplete` and reject on `tx.onabort`. The image
write is no longer swallowed: if the picture cannot be stored, the import fails and says
so, rather than producing a puzzle that cannot be opened. And the library reports the
condition on the card rather than only on pressing Open.

**Recovery is exact, not a guess.** Images are keyed by the SHA-256 of their bytes, so
**Relink picture…** can simply hash the file offered and compare: it either is the picture
the puzzle was cut from or it is not. If it is, the record starts working again with its
progress intact; if it is not, the puzzle says so instead of half-working. This is the
content-hash design paying for itself a second time.

The old error message deserves a note of its own. `openFromLibrary()` caught every failure
and reported "its image is missing" regardless of cause — a guess dressed as a diagnosis,
and it would have said the same thing if the saved progress were corrupt or the renderer
had thrown. The three cases are now told apart before anything is said.

## 18. Assistance levels

Three aids, all off by default, each its own switch. Not one difficulty dial: how much
help a puzzle should give is a matter of taste and of the day, and collapsing that into
"easy / normal / hard" would mean deciding on the player's behalf which kinds of help go
together.

**The ghost** paints the finished picture on the board at up to 45% opacity, under every
piece. The cap is the whole design decision. Past roughly that the board reads as the
finished picture with pieces scattered on it, and placing a piece stops being a judgement
about the picture — it becomes tracing. The slider goes to 45 and no further.

**Hints** outline the clusters that belong beside the selection. Two decisions: it is a
hint rather than an answer — it says which pieces go next to this one, leaving you to find
and place them — and it is tied to a *selection* rather than shown for everything at once,
because outlining every neighbour of every piece lights up the whole board and tells you
nothing. `neighbourClusters()` is a lookup, not a search: the geometry already records
each piece's four neighbours, and each piece knows its cluster. Hints are derived from the
selection inside `syncSelection()` rather than tracked alongside it, so the two cannot
drift apart.

The first version of hints shipped working and useless, which is worth recording because
the tests were no help at all. It drew a 2.5px dashed outline on the neighbouring pieces
and stopped there. Every assertion passed — the right clusters were marked, the selection
was excluded — and the feature was invisible in use. Screenshotting an actual frame showed
why: on a 200-piece puzzle the selected piece was above the top of the window and its two
neighbours were at the right edge and the bottom, both half cut off. A thin outline on a
59px piece in a scatter of two hundred is no easier to find than the piece itself, and a
scatter ring is five times the area of the board, so *most* neighbours are off-screen.

Marking assumed the thing marked was visible. Two changes fixed the concept rather than
the drawing: hinted pieces get a wide amber glow stroked twice, at a constant screen width
so it survives zooming out; and off-screen hints get an arrow at the screen edge pointing
towards them. **Find** then frames the selection with its neighbours — it moves the *view*,
never a piece, so it answers "where are they" and leaves the fitting to you. The smoke test
now asserts that Find brings every hint inside the visible world rect, which is the
property that was actually missing.

A second report followed — "when I click on a piece and Hints is on I get 0% connected" —
and nothing was broken at all. Turning hints on printed a message; selecting a piece then
called `updateStatus()`, which knew nothing about hints and replaced the line with
"1 selected (1 piece) · 0% connected". Identical to hints being off. A mode that gives no
ongoing evidence it is on is a mode people correctly assume is off, so the hint state is
now reported on every selection rather than announced once.

A third report closed the loop: "no Find button appears". That message was the
*no-selection* branch, which proved the build was current and that clicking a piece was
selecting nothing. It was not: `onDown` in `pointer.ts` deliberately **clears** the
selection when you grab a piece that is not already selected, so it can start a fresh
single-piece drag. Selection only happens on Shift+click or a lasso in Select mode. So
hints keyed off the selection could not fire from an ordinary click — which is every
normal interaction — while the status line cheerfully advised "select a piece", exactly
what the user had just done.

Hints now follow **the piece you last picked up**, falling back to the selection when
there is one. That is also the better model: you pick up a piece, and the pieces that go
beside it light up. The source is stored as a *piece* id, not a cluster id, because a
cluster id dies the moment that cluster merges into another, and the point is to keep
showing what still goes beside the piece you just placed.

The lesson generalises three ways: an assertion that a thing is *marked* is not an
assertion that it can be *seen*; a mode needs continuous feedback, not an announcement;
and a feature whose trigger is a gesture most people never make is not shipped. All three
were invisible to a test suite driving the app through its own methods rather than through
the gestures a person actually uses — the smoke test now performs a real pointerdown and
pointerup on a piece, with no Shift and no Select mode, which is what was broken.

### The smoke test was flaky, which is worse than absent

Chasing the above turned up five failing tray checks that had nothing wrong with them.
Puzzle geometry is seeded and reproducible by design, but the initial scatter calls
`randomSeed()` — one of the few deliberate uses of `Math.random()`, since its whole job is
to produce a seed to store. Several checks lassoed a fixed screen rectangle and assumed it
caught pieces, which depended on where that run's scatter happened to land.

A flaky test is worse than no test: it teaches you to skim past failures, and a real
regression hiding in the noise is precisely what it exists to catch. Two fixes. The page
now gets a seeded `Math.random` (`SMOKE_SEED`, overridable), so a run is reproducible.
And the lasso was fixed rather than merely pinned — it now presses **Fit all** first,
because a puzzle opens zoomed to the *board*, which is mostly empty with the pieces in a
ring outside it. Pinning the seed alone would have frozen the bug in place instead of
removing it; the test is verified across six seeds.

**Edges only** hides every piece that is not on the border, for building the frame without
five hundred interior pieces in the way. It is a display filter over unchanged state, so
switching it off restores everything exactly where it was — nothing is moved, trayed or
lost. Hidden pieces are made ungrabbable as well as invisible: an invisible piece that
still catches the pointer is worse than no filter at all, and the smoke test asserts
specifically that an interior piece fails a hit test while hidden. Turning it on clears
the selection, since a selection holding pieces you cannot see would let a rotate or a
drag act on them blind.

The border-piece set belongs to one puzzle's geometry, so it is re-derived when a puzzle
opens. The switches themselves persist, because having to turn hints back on for every
puzzle would be its own annoyance.

## 19. Known limitations after M2

- Preparation always recuts, so a crop cannot be changed on a part-finished puzzle. There
  is no way around this: the pieces were cut from the old picture.
- Adjustments are CSS filters, so they clip rather than roll off. A hard push on contrast
  crushes the shadows.
- No named-group UI for *connected* assemblies. `nameCluster()` exists and round-trips
  through save files; nothing calls it yet. Trays (section 13) cover the unconnected case.
- Trays do not scroll. A tray with two hundred pieces grows tall rather than paging, so a
  very large tray is unwieldy.
- Sorting is by colour and by edge only. Sorting by image *region* (sky, foreground,
  subject) would need segmentation and is not obviously better than colour for the job.
- Colour groups are computed from a mean per piece, so a piece split evenly between two
  regions lands between them rather than in either. Honest, but occasionally surprising.
- Selection is not saved. Closing the puzzle loses it, which is correct for a highlight
  but will not be correct once a selection can be named and become a tray.
- Rotation is quarter turns only. Free angles are supported by the maths but always
  quantised on release; a "loose" mode allowing arbitrary angles would need the snap
  tolerance rethought.
- Grabbing overlapping pieces takes the topmost, which is correct but can feel arbitrary
  in a dense scatter. This is one of the things trays are meant to relieve.
- The piece-count cap uses a fixed 60 px minimum piece edge. It is a reasonable default
  but has not been validated against how puzzles actually feel on a tablet.
- Bake cache eviction is LRU over a byte budget with no cost model — a piece that is
  expensive to bake is treated the same as a cheap one.
- Reference panel is a fixed side panel; the plan's floating/bottom/hidden modes are not
  implemented.
