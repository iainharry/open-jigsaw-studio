/**
 * The user guide: one self-contained page, built from the app that is running.
 *
 * Two halves, and they are made in opposite ways for a reason.
 *
 * **The control reference is generated, never written.** Every control already carries a
 * `data-help` sentence, shown by help mode. Copying those into a document would create a
 * second copy of forty-seven strings that has to be kept in step with the first, and it
 * would fall out of step silently — the guide would go on confidently describing a button
 * that had been renamed. So the reference is read out of the live DOM at the moment
 * somebody asks for it. It cannot drift, because there is only one copy.
 *
 * **Everything else is written by hand, because none of it can be derived.** How to build
 * a border first. Which settings quietly change other settings. What to do with a class.
 * A tooltip can say what a button does; it cannot say what two buttons do together, and
 * that second thing is the entire reason a guide is worth having. Help mode already
 * covers the first.
 *
 * The output is a single HTML file with its styles inline and everything laid out in HTML
 * rather than SVG -- SVG text does not wrap, and the first version of the coupling diagram
 * cut every explanation off at the right-hand edge while still looking like a diagram. No
 * PDF library — this project has no runtime dependencies and is not about to gain one to
 * make a document that every browser can already print. Saving the file and pressing
 * print produces the PDF, and the file works offline afterwards, which a PDF generated
 * from a server would not.
 */

/** One control, as the app describes it. */
export interface GuideControl {
  readonly zone: string;
  readonly name: string;
  readonly help: string;
}

/** A hand-written walkthrough. */
interface Recipe {
  readonly title: string;
  readonly why: string;
  readonly steps: readonly string[];
}

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Read every documented control out of the running app.
 *
 * Toolbar controls are grouped by the zone they sit in, so the guide is ordered the same
 * way the toolbar is — somebody looking a control up is looking at the toolbar, and a
 * guide in a different order makes them translate between the two.
 *
 * Panel controls are collected too, under the panel's own name. The first version read
 * only the toolbar and the section was still headed "Every control", which quietly
 * omitted Print sheet, the challenge fields and the playtest switch. A reference that
 * says "every" has to mean it.
 */
export function collectControls(root: ParentNode): GuideControl[] {
  const panels: readonly { selector: string; label: string }[] = [
    { selector: '.challenge', label: 'Challenge panel' },
    { selector: '.library', label: 'My puzzles panel' },
    { selector: '.settings', label: 'Settings panel' },
  ];

  const out: GuideControl[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[data-help]')) {
    const help = el.getAttribute('data-help')?.trim();
    if (!help) continue;
    // The guide's own controls are not documented in the guide.
    if (el.closest('.guide')) continue;

    const zone =
      el.closest<HTMLElement>('[data-zone]')?.dataset['zone'] ??
      panels.find((panel) => el.closest(panel.selector))?.label ??
      'Elsewhere';

    // A label's own text is its first text node: `<label>Ghost<input></label>` would
    // otherwise come back as "Ghost" plus every option in the menu inside it.
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    const name = own || el.textContent?.trim() || el.className;
    out.push({ zone, name: name.slice(0, 40), help });
  }
  return out;
}

const RECIPES: readonly Recipe[] = [
  {
    title: 'Build the border first',
    why: 'The traditional way into a big puzzle, and the app can do the sorting for you.',
    steps: [
      'Press <b>Edges</b> in the Sort zone. Every piece with a flat side is selected.',
      'Press <b>New tray</b>. The selected pieces are put into a tray of their own, out of the way of everything else.',
      'Press <b>Edges only</b> in the Assist zone. Every other piece is hidden — not lost, just out of the way — so you can work the frame without five hundred pieces underneath it.',
      'Build the frame. Press <b>Edges only</b> again to bring the rest back.',
    ],
  },
  {
    title: 'Sort a large puzzle into manageable piles',
    why: 'Two hundred pieces on a table is not a puzzle, it is a search problem.',
    steps: [
      'Press <b>Sort by colour</b>. The pieces are grouped by their average colour and the app steps you through the groups one at a time.',
      'For each group, press <b>New tray</b> and give it a name — "sky", "roof", "the dark bits".',
      'Use the <b>Named</b> menu to jump back to any tray later. It lists trays and named groups together.',
      'A tray can be collapsed to a title bar with <b>Collapse</b>, so eight trays fit on one screen.',
    ],
  },
  {
    title: 'Get unstuck without being given the answer',
    why: 'Three levels of help, deliberately separate, so you can take only as much as you want.',
    steps: [
      'Turn the <b>Ghost</b> slider up a little. The finished picture appears faintly on the board to lay pieces over. All the way left is no help at all.',
      'Touch a piece and press <b>Hints</b>. The pieces that belong beside it are outlined in amber. If they are off screen, press <b>Find</b> to bring them into view — this moves the view, never a piece.',
      'Turn the <b>Reference</b> menu on to see the finished picture beside the board rather than under it.',
      'None of these place a piece for you. That is the line: the app shows you where to look.',
    ],
  },
  {
    title: 'Set the same puzzle for a group of people',
    why: 'A shape puzzle with no photo is completely described by a short code, so everybody can have the identical board with no account and nothing uploaded.',
    steps: [
      'Set <b>Cut</b> to Shapes and <b>Picture</b> to Colours only.',
      'Choose an <b>Outline</b>, a <b>Shapes</b> set and a <b>Size</b>, then press <b>New puzzle</b> until you get one you like.',
      'Press <b>Challenge…</b>. The code is shown, along with how hard the puzzle is if you are playing Any fit.',
      'Send the link, or read the code out — it is short enough to write on a whiteboard. One character of it is a checksum, so a mistyped code says so instead of quietly opening a different board.',
    ],
  },
  {
    title: 'Print a puzzle to cut out on paper',
    why: 'Thirty children and four tablets is a common shape of problem.',
    steps: [
      'Make a shape puzzle as above, then press <b>Challenge…</b> and <b>Print sheet…</b>.',
      'The sheet has the outline at true scale and every piece beside it, so a cut-out piece really does fit the printed frame.',
      'Pieces print with flat edges even if the screen version has tabs — a printed tab is a two-millimetre spike that tears off the moment it is cut.',
      'The code is printed on the sheet, so anyone can pick the same puzzle up on screen afterwards.',
    ],
  },
  {
    title: 'Make a letter or number puzzle for a young child',
    why: 'The puzzle becomes the shape rather than a picture of it — the child makes a 5 out of pieces.',
    steps: [
      'Set <b>Cut</b> to Shapes, then pick a number, letter or shape from the <b>Outline</b> menu.',
      'Leave <b>Rules</b> on <i>Match the picture</i>. Every piece then has one home, which is an ordinary jigsaw and the right thing for a first go.',
      'The board shows the outline you are filling, so the child can see the shape from the start.',
      'Piece count is decided by legibility, not by the Pieces menu: shapes and arrows come out at five to nine pieces, most letters twelve to twenty, and <b>8</b>, <b>B</b>, <b>6</b> and <b>9</b> nearer thirty — they have more strokes to draw. The app tells you when it has had to use more pieces than you asked for.',
      'For an older child, switch <b>Rules</b> to <i>Any fit</i>. The same board becomes a packing puzzle with many solutions and no single right answer.',
    ],
  },
];

/**
 * Settings that change other settings.
 *
 * The couplings are real and deliberate, and every one of them is invisible until you
 * trip over it: a menu you did not touch has moved and there is nothing on screen saying
 * which one did it. They are gathered here because this is the one question a tooltip
 * structurally cannot answer — a tooltip describes its own control.
 */
const COUPLINGS: readonly { from: string; to: string; why: string }[] = [
  {
    from: 'Rules → Any fit',
    to: 'turns on Shapes and Flat edges',
    why: 'A tab fits exactly one socket in exactly one place, so a puzzle where any arrangement counts cannot have tabs. Without flat edges Any fit would be unsolvable.',
  },
  {
    from: 'Outline → a letter, number or shape',
    to: 'turns on Colours only',
    why: "The grid comes from the letter's own proportions, and a photograph's proportions would squash it. Given the choice between distorting the photo and distorting the letter, the letter wins.",
  },
  {
    from: 'Rules → Any fit',
    to: 'disables Hints',
    why: 'Hints show which pieces belong beside the one you touched. Under Any fit there is no single right neighbour, so there is nothing truthful to show.',
  },
  {
    from: 'Cut → Classic',
    to: 'hides Size, Shapes, Outline and Edges',
    why: 'Those four only describe the shape cut. They are hidden rather than greyed out because a classic puzzle has no answer to them at all.',
  },
  {
    from: 'Picture → Colours only',
    to: 'removes the piece-count ceiling',
    why: 'The ceiling exists because past it a piece is more tab than picture. With no picture there is no detail to lose.',
  },
];

/** The zone diagram: what each part of the toolbar is for. */
const ZONES: readonly { name: string; colour: string; what: string }[] = [
  { name: 'Puzzle', colour: '#6aa9ff', what: 'Which puzzle, and cutting a new one' },
  { name: 'View', colour: '#63c9b0', what: 'Zoom, fit, the reference picture, full board' },
  { name: 'Sort', colour: '#e8b45f', what: 'Finding pieces: edges, colour, trays' },
  { name: 'Play', colour: '#8f9bff', what: 'Move or select, and rotation' },
  { name: 'Assist', colour: '#7fc45f', what: 'Optional help: ghost, hints, edges only' },
  { name: 'Cut', colour: '#ff9d76', what: 'What the pieces are: shape, rules, outline' },
  { name: 'Organise', colour: '#d98cc4', what: 'Naming groups and finding them again' },
  { name: 'App', colour: '#9aa5b4', what: 'Challenge codes, settings, help, this guide' },
];

/**
 * The zone map and the coupling list, as HTML rather than SVG.
 *
 * Both were drawn as SVG first, and both were wrong in the same way: SVG text does not
 * wrap. The reasons beside each coupling — the part actually worth reading — ran off the
 * right-hand edge and were cut in half, and one row's label overflowed its box and
 * collided with the arrow next to it. It rendered, it looked like a diagram, and the
 * content was missing.
 *
 * HTML wraps, reflows on a phone, and prints. SVG earns its place when the shape carries
 * meaning; here the shape is a row with an arrow in it, which CSS does perfectly well.
 * The one genuinely graphical part — the coloured zone chip — stays, and it is a colour
 * *and* a word, never colour alone.
 */
function zoneMap(): string {
  return `<ul class="zones">${ZONES.map(
    (zone) =>
      `<li><span class="chip" style="--zone:${zone.colour}">${escape(zone.name)}</span>
        <span>${escape(zone.what)}</span></li>`,
  ).join('')}</ul>`;
}

function couplingList(): string {
  return `<ul class="couplings">${COUPLINGS.map(
    (c) =>
      `<li>
        <p class="pair"><span class="from">${escape(c.from)}</span>
          <span class="arrow" aria-hidden="true">→</span>
          <span class="to">${escape(c.to)}</span></p>
        <p class="why-plain">${escape(c.why)}</p>
      </li>`,
  ).join('')}</ul>`;
}

const STYLE = `
  /*
   * Light by default, dark under either the reader's device setting or an explicit
   * data-theme. Both are needed and they serve different readers: inside the app the
   * guide is part of the app and must not flash white against a dark board, while a
   * saved copy belongs to whoever opens it and should follow their device.
   */
  :root { color-scheme: light dark; --ink: #14161a; --paper: #fff; --muted: #5a626e; --line: #d8dde4; --accent: #2c6fd1; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme='light']) { --ink: #e8ecf2; --paper: #14161a; --muted: #98a2b0; --line: #2a2f38; --accent: #6aa9ff; }
  }
  :root[data-theme='dark'] { --ink: #e8ecf2; --paper: #14161a; --muted: #98a2b0; --line: #2a2f38; --accent: #6aa9ff; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 20px 60px; background: var(--paper); color: var(--ink);
         font: 15px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 34px 0 8px; padding-top: 14px; border-top: 1px solid var(--line); }
  h3 { font-size: 15px; margin: 20px 0 4px; }
  p, li { color: var(--ink); }
  .lede, .why { color: var(--muted); }
  .why { margin: 0 0 8px; font-style: italic; }
  ol, ul { margin: 6px 0 0; padding-left: 22px; }
  li { margin: 4px 0; }
  code, kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em;
              background: color-mix(in oklab, var(--ink) 8%, transparent); padding: 1px 5px; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  td { border-top: 1px solid var(--line); padding: 7px 8px 7px 0; vertical-align: top; }
  td.name { width: 34%; font-weight: 600; }
  .zone-head { margin: 22px 0 0; font-size: 11px; letter-spacing: .09em; text-transform: uppercase;
               font-weight: 700; color: var(--accent); }
  .zones, .couplings { list-style: none; padding: 0; margin: 12px 0 0; }
  .zones li { display: flex; gap: 12px; align-items: baseline; margin: 0 0 7px; flex-wrap: wrap; }
  .chip { flex: none; min-width: 92px; text-align: center; padding: 2px 9px; border-radius: 7px;
          font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
          color: var(--zone); background: color-mix(in oklab, var(--zone) 16%, transparent);
          box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--zone) 45%, transparent); }
  .couplings li { margin: 0 0 14px; padding-left: 12px; border-left: 3px solid var(--line); }
  .pair { margin: 0; display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
  .from { font-weight: 650; }
  .arrow { color: var(--muted); }
  .why-plain { margin: 2px 0 0; color: var(--muted); font-size: 13.5px; }
  footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
  @media print {
    body { padding: 0; font-size: 11pt; }
    h2 { break-before: auto; break-after: avoid; }
    li, tr { break-inside: avoid; }
  }
`;

/**
 * Build the whole guide as one self-contained HTML document.
 *
 * `theme` pins the colours; leaving it out lets the reader's device decide, which is what
 * a saved copy should do.
 */
export function buildGuide(
  controls: readonly GuideControl[],
  version: string,
  theme?: 'dark' | 'light',
): string {
  const zones = [...new Set(controls.map((c) => c.zone))];
  const reference = zones
    .map((zone) => {
      const rows = controls
        .filter((c) => c.zone === zone)
        .map(
          (c) =>
            `<tr><td class="name">${escape(c.name)}</td><td>${escape(c.help)}</td></tr>`,
        )
        .join('');
      return `<p class="zone-head">${escape(zone)}</p><table>${rows}</table>`;
    })
    .join('');

  const recipes = RECIPES.map(
    (r) => `<h3>${escape(r.title)}</h3><p class="why">${escape(r.why)}</p><ol>${r.steps
      .map((step) => `<li>${step}</li>`)
      .join('')}</ol>`,
  ).join('');

  return `<!doctype html><html lang="en"${theme ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Jigsaw Studio — User Guide</title>
<style>${STYLE}</style></head><body><main>

<h1>Open Jigsaw Studio</h1>
<p class="lede">A guide to the controls, and to what they do together. Everything here works
offline; nothing you do in the app is uploaded anywhere.</p>

<h2>Getting your bearings</h2>
<p>The toolbar is divided into eight zones. Each has a coloured tint and a small label, and
they are grouped by <em>what you are trying to do</em> rather than alphabetically.</p>
${zoneMap()}
<p>Two things are worth knowing before anything else:</p>
<ul>
<li><b>Help mode.</b> Press <b>?</b>, then touch any control to read what it does. It is the
same text as the reference at the end of this guide, and it is always up to date. Press
<kbd>Esc</kbd> to leave.</li>
<li><b>Full board.</b> On a tablet the toolbar takes about a quarter of the screen. Press
<b>Full board</b> in the View zone (or <kbd>F</kbd>) to fold it away entirely; a small tab
stays at the top of the board to bring it back. On a 500-piece puzzle this is the
difference between pieces at 23 pixels and pieces at 35.</li>
</ul>

<h2>Doing things</h2>
<p>These are the routines the app supports but does not announce.</p>
${recipes}

<h2>Settings that change other settings</h2>
<p>A few controls move others when you press them. This is deliberate — the combinations
they prevent do not work — but it is invisible while it is happening, so here they are in
one place.</p>
${couplingList()}

<h2>Using it with a class or a young child</h2>
<h3>Choosing a puzzle for an age</h3>
<ul>
<li><b>Youngest.</b> A shape or arrow outline: five to nine large pieces, and the shape is
visible on the board from the start. Keep <b>Rules</b> on <i>Match the picture</i>.</li>
<li><b>Early readers.</b> A letter or number: twelve to twenty pieces for most,
around thirty for <b>8</b>, <b>B</b>, <b>6</b> and <b>9</b>. Their own initial is a good
first one.</li>
<li><b>Older.</b> Switch <b>Rules</b> to <i>Any fit</i> and the same board becomes a packing
puzzle — many solutions, and no piece has a fixed home. Pentominoes make this markedly
harder than mixed shapes.</li>
</ul>
<h3>Giving everyone the same puzzle</h3>
<p>Make the puzzle, press <b>Challenge…</b>, and share the code or the link. The code
<em>is</em> the puzzle — it carries the seed and every setting — so there is no account, no
server and nothing uploaded. It is short enough to write on a board, and one character of
it is a checksum so a mistyped code is refused rather than quietly opening a different
puzzle.</p>
<h3>Away from screens</h3>
<p><b>Print sheet…</b> in the same panel produces the outline and the pieces at matching
scale, to cut out and solve on a table. The code is printed on it, so the same puzzle can
be picked up on screen later.</p>
<h3>Difficulty</h3>
<p>For an <i>Any fit</i> puzzle the app works out how hard it is by playing it badly a few
hundred times and seeing how often that finishes — so the rating describes the puzzle
rather than counting its pieces. A <i>Match the picture</i> puzzle has one home per piece
and is not rated this way.</p>

<h2>Every control</h2>
<p>Generated from the app itself, so it always matches the version you are using. This is
the same text help mode shows.</p>
${reference}

<footer>Open Jigsaw Studio · ${escape(version)} · free and open source, MIT licensed.<br>
This guide was generated by the app on ${escape(new Date().toISOString().slice(0, 10))} and
works offline. To keep a PDF, print this page and choose “Save as PDF”.</footer>
</main></body></html>`;
}
