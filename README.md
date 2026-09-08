# Open Jigsaw Studio

An open-source, local-first, cross-platform digital jigsaw studio. Works fully offline.
No account, no server, no network.

**Status: M6.** Import a picture, crop and straighten it, cut it into 12–2,000 pieces,
drag, snap, rotate, multi-select, gather the edges, sort by colour, file pieces into named
trays, and keep a library of puzzles. Installs as an app and runs completely offline, with
no runtime dependencies and no account.

## Install it

The built app is a PWA: open it in a browser, choose **Install** (Chrome and Edge offer
this in the address bar; on Android it is "Add to home screen"), and it runs full-screen
and completely offline afterwards. Your puzzles live in that browser's storage on that
device.

## Backup, and moving puzzles between devices

There is no cloud and no account, so there are two honest paths.

**Export / import.** Every puzzle in **My puzzles** has an **Export** button that saves a
`.jigsaw` file — the picture and your progress in one self-contained file. **Import…**
reads one back. Works in every browser, including on the tablet. Put the file in your
OneDrive or Google Drive folder and it is backed up.

**Backup folder** (Chrome or Edge on a computer only). Press **Backup folder…** in
My puzzles and pick a folder — your OneDrive or Google Drive folder, say. From then on
every save also writes a `.jigsaw` file there, and the sync client you already run does
the uploading. No account, no OAuth, no server, and it still works with the network
unplugged.

Two things to be clear about. The [File System Access API](https://caniuse.com/native-filesystem-api)
that powers the folder link exists only in Chrome, Edge and Opera **on a computer** — no
mobile browser has it, so on the tablet you use Export and Import. And this is file sync,
not merge: if you play the same puzzle on two devices, your sync client will make a
conflict copy and one version wins. For one person playing on one device at a time it is
exactly right; it is not multi-device sync and is not pretending to be.

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
| `npm test` | 215 headless engine tests, ~3 s |
| `npm run typecheck` | TypeScript strict-mode check |
| `npm run build` | production build into `dist/` |
| `npm run preview` | serve the production build |
| `node scripts/pwa-check.mjs` | verify it installs and boots with the server off |

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

## Preparing a picture

**Prepare…** opens the picture full-screen before it is cut. Drag the corners to crop,
pick a shape (16:9, square and so on) to constrain it, turn it a quarter at a time, flip
it, and nudge **Straighten** for a sloping horizon — the crop is held inside the
straightened frame, so you never end up with empty corners. **Brightness**, **Contrast**
and **Saturation** are there to make a flat or murky picture puzzleable, not to be a photo
editor.

The readout under the picture updates as you go: it shows the size you will end up with
and how big each piece will be, which matters, because cropping half the picture away
makes a 1,000-piece puzzle noticeably harder to see.

Two things worth knowing. **Your original is never changed** — the crop is stored as a
setting and applied afresh each time the puzzle opens, so you can press Prepare again
later and widen a crop you took too far. And **preparing cuts a new puzzle**, because the
pieces are shaped around a picture of a particular size; finish the one you are on first.

## Finding your way around

Every control in the toolbar explains itself. Point at it with a mouse and a short
description appears. On a tablet there is no hover, so press **?** to enter help mode and
tap any control to read what it does instead of pressing it — Esc, or **?** again, to
leave. There is deliberately no separate user guide to fall out of date.

## Getting help with a puzzle

Three aids in the toolbar, all off unless you turn them on, and each independent — you can
have one without the others.

**Ghost** fades the finished picture onto the board to lay pieces over. The slider stops
at 45% on purpose: any stronger and you are tracing rather than solving.

**Hints** outlines the pieces that belong beside the piece you last touched. Click or tap
any piece and its neighbours glow amber — it tells you where to look, not where to put things.
Most of them will be off-screen in a fresh scatter, so an amber arrow appears at the edge
of the screen pointing towards each one, and a **Find** button appears next to Hints that
moves the view until the selected piece and all its neighbours are visible together.
Nothing on the board is moved; only the view.

**Edges only** hides every piece that is not part of the border, so you can build the
frame in peace. Nothing is moved or lost; switch it off and everything comes back exactly
where it was.

## Keeping track of a puzzle

Open **My puzzles** and expand *Notes, rating and history* on any card.

**Notes** is free text — where the picture came from, how it went, what to try next time.
**Difficulty** is five stars you set yourself; Clear removes the rating.

**History** records every time you have finished that puzzle, and records the conditions
with it: the piece count, whether rotation was on, and which aids were switched on when
you finished. A bare time is not comparable with another one — 500 pieces with the ghost
at 45% is a different afternoon from 500 pieces unaided — so the app writes down what it
actually cost you. The card shows your best time. Shuffling a finished puzzle makes it
unfinished again, so playing it a second time adds a second entry.

## Any fit: the packing puzzle

**Rules** switches between *Match the picture* — the ordinary jigsaw, where every piece has
one home — and **Any fit**, where any arrangement that fills the frame counts. That turns
it into a packing puzzle with a great many solutions rather than one.

Any fit needs shape pieces with flat edges, and switches those on for you: a tab only
interlocks in the arrangement it was cut for, so it cannot work otherwise. Pieces do not
join together in this mode, because two shapes side by side in your layout are not really
connected — you may pull one out again a minute later. Progress is how much of the frame
you have covered, and the puzzle is finished when the frame is full, wherever each piece
came from.

Turn **Rotation** on to make it properly hard: then you have to find the right orientation
as well as the right hole. Hints are switched off under these rules — they would point at
where a piece was originally cut from, which is neither a hint nor the only right answer.

## Naming a group

Touch a piece and press **Name group**. If you have highlighted several *separate* pieces
rather than one joined assembly, the same button collects them into a tray and offers to
name that instead — a name belongs to one joined group, while a tray is the right home for
a handful of pieces that are not joined to each other. Type a name — "the lighthouse",
"top left sky" — and it appears on the board above that group and in the **Named** list
in the toolbar — which holds everything you have named, groups and trays alike, each
saying which it is. Whatever you name, it is in that one list. Choosing it from the list selects the group and brings it into view,
however far away it has drifted.

The name is drawn at a fixed size on screen, so it stays readable when you zoom out to
find your way around a large board. Names are saved with the puzzle, and if you join a
named group to an unnamed one the name carries across.

## Shape puzzles

**Cut** switches between classic jigsaw pieces and **Shapes** — L's, T's, crosses, S's,
squares and bars that tile the picture between them. Both cuts snap, rotate, go into
trays and sort by colour in exactly the same way; only the shape of a piece changes.

**Size** sets roughly how many squares make up each piece, from small to extra large.
**Edges** chooses between tabs, which interlock like a jigsaw, and flat, which gives
straight cuts — cleaner to look at and considerably harder, because nothing holds together
visually.

**Picture** can be set to **Colours only**, which plays the puzzle with no photograph at
all: every piece gets its own colour and you match by shape and colour together. This is
worth knowing about — with plain identical pieces, two matching shapes swapped would fit
perfectly and leave you with a board that looks finished but does not register as
complete. A colour each makes that impossible.

The colours are chosen so that no two *touching* pieces are hard to tell apart, including
for red-green and blue-yellow colour blindness — the palette varies brightness as well as
hue, so it also reads in greyscale. This is checked by the tests rather than assumed.

## Finding your way around the toolbar

The toolbar is divided into labelled zones — **Puzzle**, **View**, **Sort**, **Play**,
**Assist**, **Cut**, **Organise**, **App** — each with its own tint and its own name. The
name is there as well as the colour on purpose: a tint alone is no use to someone who
cannot separate those particular colours.

## Playing without a mouse

The whole app can be driven from the keyboard. **Tab** picks up a piece and brings it into
view, **Shift+Tab** goes back. The **arrow keys** carry it — a quarter square at a time, or
a whole square with **Shift** held. **Enter** puts it down, snapping and joining exactly as
letting go of the mouse would. **R** and **Shift+R** turn it, **Esc** lets go.

On a phone or tablet the app gives a short buzz when a piece lands, which you can switch
off in Settings. It is the one bit of feedback a touchscreen cannot give any other way —
there is no click and no resistance, and the piece is under the hand covering it.

There is deliberately no reduce-motion setting: nothing in the app animates, so it would
be a placebo.

## Settings

**Theme** switches between dark and light. **Table** is the surface the pieces lie on —
slate, green felt, oak or near-black. **Piece edges** controls how pronounced the moulded
edge on each piece is; it is baked into the pieces, so changing it redraws them once
rather than costing anything per frame.

**Autosave** sets how often an idle save happens. Worth knowing what it does and does not
control: a save *always* follows pieces joining and any change in My puzzles, so
"Only when pieces join" is not "never saved" — the interval is only the backstop that
catches pieces shuffled about without being joined to anything. The footer tells you when
the last save landed, which is the thing actually worth knowing, and says so loudly if a
save has failed.

Settings are per device, not per puzzle: a puzzle you carry to another machine looks the
way that machine is set up.

## Sharing a puzzle

On a phone or tablet, each card in **My puzzles** has a **Share** button that hands the
`.jigsaw` file to whatever app you like — mail, a chat app, a synced folder. There is no
server and no account, so a share is the file itself rather than a link. On a desktop
browser without file sharing, Export does the same job.

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

Done: the puzzle engine, selection and rotation, the library, zoom controls, piece trays,
edge and colour sorting, in-app help, shipping (PWA, GitHub Pages, portable files), image
preparation, assistance levels, notes/difficulty/history, appearance, autosave and sharing — which
completes the original brief — a second cut that makes shape pieces, named groups, free-form solving, pentominoes and outlines, and keyboard play. Deliberately deferred: tags and search, which solve a problem
a five-puzzle library does not have, and a TV/remote-control interface, which is a
different input model rather than a layout change.
`ARCHITECTURE.md` §26 lists what is deliberately not built.

## Licence

MIT. Every dependency's licence is recorded in `ARCHITECTURE.md`.
