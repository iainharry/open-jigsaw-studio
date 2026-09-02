# Open Jigsaw Studio

An open-source, local-first, cross-platform digital jigsaw studio. Works fully offline.
No account, no server, no network.

**Status: M3.** Import a picture, cut it into 12–2,000 pieces, drag, snap, rotate,
multi-select, sort into named trays, and keep a library of puzzles in progress. All
offline, with no runtime dependencies.

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
| `npm test` | 84 headless engine tests, ~1.4 s |
| `npm run typecheck` | TypeScript strict-mode check |
| `npm run build` | production build into `dist/` |
| `npm run preview` | serve the production build |

## Controls

| | mouse / pen | touch |
|---|---|---|
| move a piece or group | drag it | drag it |
| pan the board | drag the background | drag the background, or two fingers |
| zoom | wheel, or **+** / **−** | pinch, or the +/− buttons |
| fit the picture area | **0**, or **Fit board** | **Fit board** |
| fit everything | **9**, or **Fit all** | **Fit all** |
| select several pieces | Shift+drag the background | **Select** mode, then drag the background |
| add or remove one piece | Shift+click it | **Select** mode, then tap it |
| move the whole selection | drag any selected piece | drag any selected piece |
| clear the selection | Esc, or click empty board | tap empty board |
| select everything | Ctrl+A | — |
| rotate the selection | **R** / **Shift+R**, or the ↻ ↺ buttons | ↻ ↺ buttons, or hold a piece and twist with a second finger |

Pieces snap when released near where they belong, and a group that lands in a hole
connects to every neighbour at once. The footer shows piece count, how big a piece is on
screen, how many are drawn versus culled, median frame time, baked-bitmap memory and the
number of separate groups.

A new puzzle opens fitted to the **board**, not to everything — fitting the loose pieces
too means zooming so far out that a 500-piece puzzle arrives with 28-pixel pieces. The
toolbar readout turns amber when pieces drop below about 34 px. Note that above roughly
55–65 px per piece, 500 pieces cover most of any monitor, so seeing them all at once and
seeing them clearly are genuinely in tension; `ARCHITECTURE.md` §12 has the arithmetic.

## Finding your way around

Every control in the toolbar explains itself. Point at it with a mouse and a short
description appears. On a tablet there is no hover, so press **?** to enter help mode and
tap any control to read what it does instead of pressing it — Esc, or **?** again, to
leave. There is deliberately no separate user guide to fall out of date.

## Trays

A tray is a named holding area — the digital equivalent of tipping the sky pieces into a
box lid. Select some pieces and press **New tray** (or `T`); type a name straight into the
editor that appears over its title bar.

| | |
|---|---|
| put pieces in | drag them onto the tray, or select and press **New tray** |
| gather the edges | **Edges** selects every border piece; then **New tray** |
| sort by colour | **Sort by colour**, then step through the groups |
| take pieces out | drag them off onto open board |
| move the tray | drag its title bar |
| rename | click its title bar |
| collapse / expand | the **Collapse** button, with the tray selected |
| find one | the tray dropdown jumps to it |
| get rid of it | **Empty** — the tray goes, the pieces stay on the board |

### Sorting

Two buttons do the tedious part of a large puzzle.

**Edges** selects every border and corner piece in one press — the first move in solving
any real puzzle.

**Sort by colour** groups the loose pieces and then steps you through the groups one at a
time, each one selected with a swatch of its colour and a piece count. Press **New tray**
to keep a group (it files them and moves straight to the next), or the arrow to skip. The
**Groups** control re-sorts into more or fewer.

It deliberately does *not* create trays for you. The clustering can tell that these pieces
are similar; it cannot know whether you wanted sky and sea together or apart, and guessing
wrong makes more work than it saves. Grouping happens in OKLab rather than RGB, so
"similar" means similar to the eye, and it is seeded — sorting the same puzzle twice gives
the same groups.

**Collapsing is the point.** A collapsed tray stops drawing *and* hit-testing its contents,
so fifty pieces become one small tile. That is what buys back screen space; simply tidying
pieces into a grid would not, because the arithmetic in `ARCHITECTURE.md` §12 says 500
legible pieces cannot fit on a monitor at once however neatly they are arranged.

Pieces sitting in a tray do not snap to each other, and nothing on the board snaps to
them. Packing puts unrelated pieces side by side, so two neighbours that happened to land
next to each other would otherwise join silently and drag an assembly out of the layout.
Take a piece out and it snaps normally again.

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

Done: the puzzle engine, selection and rotation, the puzzle library, zoom controls, and
piece trays. Next: sorting pieces into trays automatically (by colour, and by image
region), then crop and rotate before generating. `ARCHITECTURE.md` §15 lists what is
deliberately not built.

## Licence

MIT. Every dependency's licence is recorded in `ARCHITECTURE.md`.
