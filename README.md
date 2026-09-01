# Open Jigsaw Studio

An open-source, local-first, cross-platform digital jigsaw studio. Works fully offline.
No account, no server, no network.

**Status: M1.** A playable puzzle engine — import an image, generate 12 to 2,000 pieces,
drag, snap, resume. Everything else on the roadmap is still ahead.

## Running it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Then open the URL it prints (usually http://localhost:5173). It starts with a generated
sample image so there is something to play with immediately; **Load image** replaces it
with your own.

`npm run dev` uses `--host`, so the same URL works from a tablet on your network — take
the `Network:` address it prints rather than `localhost`.

| command | what it does |
|---|---|
| `npm run dev` | dev server with hot reload |
| `npm test` | 38 headless engine tests, ~1.5 s |
| `npm run typecheck` | TypeScript strict-mode check |
| `npm run build` | production build into `dist/` |
| `npm run preview` | serve the production build |

## Controls

| | mouse / pen | touch |
|---|---|---|
| move a piece or group | drag it | drag it |
| pan the board | drag the background | drag the background, or two fingers |
| zoom | wheel | pinch |
| select several pieces | Shift+drag the background | **Select** mode, then drag the background |
| add or remove one piece | Shift+click it | **Select** mode, then tap it |
| move the whole selection | drag any selected piece | drag any selected piece |
| clear the selection | Esc, or click empty board | tap empty board |
| select everything | Ctrl+A | — |
| rotate the selection | **R** / **Shift+R**, or the ↻ ↺ buttons | ↻ ↺ buttons, or hold a piece and twist with a second finger |

Pieces snap when released near where they belong, and a group that lands in a hole
connects to every neighbour at once. The footer shows piece count, how many are drawn
versus culled, frame time, baked-bitmap memory and the number of separate groups.

Rotation is off by default — tick **Rotation** to turn it on. New puzzles then start with
pieces at random quarter turns. Free twisting is quantised to the nearest quarter turn on
release, because an arbitrary angle can never satisfy the snap test and would leave a
piece permanently unsolvable. Turning rotation back off straightens everything, for the
same reason: with rotation off the snap test stops considering angle at all.

## Layout

```
src/engine/   headless puzzle engine — no DOM, no canvas, runs in Node
src/render/   Canvas2D renderer, bake cache, viewport
src/input/    Pointer Events: mouse, touch and pen on one path
src/ui/       shell, IndexedDB storage, reference panel
scripts/      benchmark and smoke test (need Playwright, see below)
```

`ARCHITECTURE.md` explains why it is arranged this way, records the measured performance
numbers, and lists the third-party libraries that were considered and why each was
rejected. `CLAUDE.md` is the project constitution — read it before changing anything.

## Benchmark and smoke test

Both drive the real built app in a real browser. Playwright is deliberately *not* a
project dependency, because it downloads several hundred megabytes of browsers:

```bash
npm run build
npm i -D playwright && npx playwright install chromium
node scripts/bench.mjs    # frame times and memory at 50 -> 2,000 pieces
node scripts/smoke.mjs    # end-to-end: renders, drags, snaps, survives reload
```

## Measured performance

Chromium with software rendering, 1600x1000 viewport. Real hardware is faster.

| pieces | median frame | p95 frame |
|---|---|---|
| 204 | 1.3 ms | 2.8 ms |
| 988 | 5.5 ms | 7.9 ms |
| 1998 | 12.8 ms | 17.1 ms |

Full table, including the zoomed-in case where culling removes 95% of the work, is in
`ARCHITECTURE.md`.

## Roadmap

M1 is done. Next is named groups and piece trays, then image preparation (crop, rotate),
then the puzzle library. See `ARCHITECTURE.md` section 10 for what M1 deliberately does
not do.

## Licence

MIT. Every dependency's licence is recorded in `ARCHITECTURE.md`.
