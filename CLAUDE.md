# Open Jigsaw Studio — project constitution

Rules for any AI agent or human working in this repository. Read this before changing code.

## Product principles

1. **Open source, MIT.** Every dependency's licence is recorded in `ARCHITECTURE.md`.
   Never copy GPL/AGPL source into this codebase.
2. **Local-first.** The app must work fully offline with no account and no network.
   Cloud is an optional extension, never a dependency of core functionality.
3. **The user owns their data.** Puzzle state must always be locally recoverable and exportable.
4. **Cross-platform by construction.** One engine, multiple shells. Web/PWA first;
   a native shell is added only when a concrete limitation forces it.

## Architectural rules

5. **The engine is headless.** Everything under `src/engine/` must run in Node with no DOM,
   no `canvas`, no `window`. If a test of engine code needs jsdom, the boundary has leaked.
   This is what makes the app testable at all — you cannot meaningfully test drag-and-snap
   through a browser driver.
6. **Piece hot state never goes through the UI framework.** Cluster transforms and piece
   positions live in engine-owned plain objects/typed arrays. The UI layer only ever sees
   coarse state (puzzle open, percent complete, active tool).
7. **Clusters are first class from day one.** A connected group of pieces *is* a cluster.
   Named user groups, trays and subassemblies are a label and a UI layer over the same
   structure — never a parallel one.
8. **Geometry is derived, not stored.** Puzzle geometry is regenerated deterministically from
   `(seed, rows, cols, imageW, imageH)`. Save files contain state only. Adding a field to a
   save file is a schema change and needs a version bump plus a migration.
9. **A piece is a path plus a UV rect**, both in image space. This model must work for both the
   Canvas2D baked-bitmap renderer and a future WebGL mesh renderer. Do not introduce a piece
   representation that only one renderer can use.
10. **Determinism.** Same seed, same inputs, byte-identical geometry. There is a test for this;
    do not weaken it. No `Math.random()` anywhere in `src/engine/`.

## Engineering rules

11. TypeScript strict mode, including `noUncheckedIndexedAccess`. No `any`, no `@ts-ignore`
    without a comment explaining why.
12. Every non-trivial engine behaviour has a test. Run `npm test` before claiming anything works.
13. Do not claim functionality works unless it has actually been run.
14. Measure performance, do not guess it. Piece-count benchmarks report real numbers.
15. No unnecessary dependencies. Prefer 200 lines we own over a 500KB package for three
    operations. Every new dependency needs a line in `ARCHITECTURE.md` justifying it.
16. Do not implement several major features in one uncontrolled change.
17. Preserve working functionality. If you must replace something that works, say why in the
    commit message.

## Known non-goals (for now)

Multiplayer, accounts, cloud sync, AI image analysis, achievements, leaderboards, marketplace,
native Smart TV apps. Do not add these speculatively.
