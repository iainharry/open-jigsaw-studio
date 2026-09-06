/**
 * End-to-end smoke test: does the app actually boot, render pieces, and snap a piece
 * dragged with real pointer events?
 *
 * The engine tests cover snapping as maths. This covers the parts they cannot: that a
 * piece is visible on the canvas, that hit testing finds it, and that the pointer path
 * from `pointerdown` to `pointerup` ends in a merge. Writes `smoke.png` for eyeballing.
 *
 * Same Playwright caveat as bench.mjs -- see its header.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const DIST = new URL('../dist/', import.meta.url).pathname;
const BASE = '/open-jigsaw-studio/';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

const { server, port } = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (path.startsWith(BASE)) path = path.slice(BASE.length - 1);
    if (path === '/' || path === '') path = '/index.html';
    try {
      const file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
});

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const failures = [];
page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') failures.push(`console error: ${m.text()}`);
});

await page.goto(`http://127.0.0.1:${port}${BASE}`);
await page.waitForFunction(() => globalThis.__ojs?.session, null, { timeout: 30_000 });
await page.selectOption('.pieces', '50');
await page.waitForFunction(() => globalThis.__ojs.session.state.geometry.pieces.length > 20);
await page.waitForTimeout(400);

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// 1. Pieces are actually painted, not just present in state.
const painted = await page.evaluate(() => {
  const c = document.querySelector('.board');
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4 * 97) {
    seen.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
  }
  return seen.size;
});
check('canvas paints a varied image', painted > 12, `${painted} distinct colour buckets`);

// 2. Drag a piece onto its solved neighbour with real pointer events and expect a snap.
const result = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const state = app.session.state;
  const canvas = document.querySelector('.board');
  const rect = canvas.getBoundingClientRect();
  const vp = () => app.viewport;

  const worldToScreen = (p) => ({
    x: (p.x - vp().x) * vp().zoom + rect.width / 2 + rect.left,
    y: (p.y - vp().y) * vp().zoom + rect.height / 2 + rect.top,
  });

  // Piece 0 stays put; drag piece 1 to sit exactly beside it.
  const anchor = state.clusters.get(state.clusterOfPiece[0]);
  const p1 = state.geometry.pieces[1];
  const target = {
    x: anchor.x + (p1.solved.x - anchor.pivotX) + p1.bounds.w / 2,
    y: anchor.y + (p1.solved.y - anchor.pivotY) + p1.bounds.h / 2,
  };

  const c1 = state.clusters.get(state.clusterOfPiece[1]);
  // The scatter is random per run, so another piece can be lying on top of this one.
  // Hit testing correctly returns whatever is topmost, which would make this test flaky
  // and would be testing the wrong thing. Raise the intended piece first.
  const zi = state.zOrder.indexOf(c1.id);
  if (zi >= 0) {
    state.zOrder.splice(zi, 1);
    state.zOrder.push(c1.id);
  }
  const grabWorld = {
    x: c1.x + (p1.solved.x - c1.pivotX) + p1.bounds.w / 2,
    y: c1.y + (p1.solved.y - c1.pivotY) + p1.bounds.h / 2,
  };

  const from = worldToScreen(grabWorld);
  const to = worldToScreen(target);
  const before = state.clusters.size;

  const fire = (type, x, y, extra = {}) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        bubbles: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        ...extra,
      }),
    );

  fire('pointerdown', from.x, from.y);
  // Assert the intended cluster was picked up, not merely that something was.
  const grabbed = app.renderer.highlightClusters?.has(c1.id) ?? false;
  for (let i = 1; i <= 12; i++) {
    fire('pointermove', from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    await new Promise((r) => requestAnimationFrame(r));
  }
  fire('pointerup', to.x, to.y);

  return { grabbed, before, after: state.clusters.size, joined: state.clusters.get(state.clusterOfPiece[1]).pieces.length };
});

check('pointerdown grabs a piece', result.grabbed);
check('dragging a piece into place snaps it', result.after < result.before, `${result.before} -> ${result.after} clusters`);
check('the snapped piece is in a multi-piece group', result.joined >= 2, `${result.joined} pieces`);

// 3. Rubber-band selection, multi-drag and rotation.
const fire = `(canvas, type, x, y, id = 1) => canvas.dispatchEvent(new PointerEvent(type, {
  pointerId: id, pointerType: 'mouse', isPrimary: id === 1, bubbles: true,
  clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }))`;

await page.click('.tool'); // switch to Select mode
const selected = await page.evaluate(async (fireSrc) => {
  const fireEv = eval(fireSrc);
  const app = globalThis.__ojs;
  const canvas = document.querySelector('.board');
  const r = canvas.getBoundingClientRect();

  fireEv(canvas, 'pointerdown', r.left + 20, r.top + 20);
  for (let i = 1; i <= 10; i++) {
    fireEv(canvas, 'pointermove', r.left + 20 + (r.width - 40) * (i / 10), r.top + 20 + (r.height - 40) * (i / 10));
    await new Promise((res) => requestAnimationFrame(res));
  }
  fireEv(canvas, 'pointerup', r.left + r.width - 20, r.top + r.height - 20);
  return app.selection.size;
}, fire);
check('rubber-band selects many clusters', selected > 3, `${selected} selected`);

await page.click('.tool'); // back to Move mode
const multi = await page.evaluate(async (fireSrc) => {
  const fireEv = eval(fireSrc);
  const app = globalThis.__ojs;
  const state = app.session.state;
  const canvas = document.querySelector('.board');
  const r = canvas.getBoundingClientRect();
  const vp = () => app.viewport;
  const toScreen = (p) => ({
    x: (p.x - vp().x) * vp().zoom + r.width / 2 + r.left,
    y: (p.y - vp().y) * vp().zoom + r.height / 2 + r.top,
  });

  const ids = [...app.selection];
  // Pieces overlap in a dense scatter and hit testing correctly returns the topmost.
  // Raise the one we intend to grab, or this test measures overlap rather than dragging.
  const zi = state.zOrder.indexOf(ids[0]);
  if (zi >= 0) { state.zOrder.splice(zi, 1); state.zOrder.push(ids[0]); }
  const pieceIds = ids.flatMap((id) => state.clusters.get(id).pieces);
  const origin = (pid) => {
    const c = state.clusters.get(state.clusterOfPiece[pid]);
    const p = state.geometry.pieces[pid];
    const dx = p.solved.x - c.pivotX;
    const dy = p.solved.y - c.pivotY;
    const cos = Math.cos(c.rotation);
    const sin = Math.sin(c.rotation);
    return { x: dx * cos - dy * sin + c.x, y: dx * sin + dy * cos + c.y };
  };

  const before = new Map(pieceIds.map((pid) => [pid, origin(pid)]));
  const grabPiece = state.clusters.get(ids[0]).pieces[0];
  const gp = state.geometry.pieces[grabPiece];
  const grab = toScreen({
    x: before.get(grabPiece).x + gp.bounds.w / 2,
    y: before.get(grabPiece).y + gp.bounds.h / 2,
  });

  fireEv(canvas, 'pointerdown', grab.x, grab.y);
  const held = app.renderer.highlightClusters?.size ?? 0;
  for (let i = 1; i <= 8; i++) {
    fireEv(canvas, 'pointermove', grab.x + 9 * i, grab.y + 5 * i);
    await new Promise((res) => requestAnimationFrame(res));
  }

  // Measured before pointerup on purpose. Releasing snaps the selection together, which
  // legitimately moves individual clusters by different amounts -- so a post-release
  // comparison would be testing the snap engine, not whether the drag stayed rigid.
  const deltas = pieceIds.map((pid) => {
    const a = before.get(pid);
    const b = origin(pid);
    return { dx: b.x - a.x, dy: b.y - a.y };
  });

  fireEv(canvas, 'pointerup', grab.x + 72, grab.y + 40);
  const first = deltas[0];
  const consistent = deltas.every(
    (d) => Math.abs(d.dx - first.dx) < 0.01 && Math.abs(d.dy - first.dy) < 0.01,
  );
  return { held, count: ids.length, moved: Math.hypot(first.dx, first.dy), consistent };
}, fire);
check('grabbing one selected piece lifts the whole selection', multi.held === multi.count, `${multi.held} of ${multi.count}`);
check('the whole selection moves together by one delta', multi.consistent && multi.moved > 1, `moved ${multi.moved.toFixed(1)} world units`);

await page.check('.rotate-on');
const rotated = await page.evaluate(() => {
  const app = globalThis.__ojs;
  const ids = [...app.selection].filter((id) => app.session.state.clusters.has(id));
  const before = ids.map((id) => app.session.state.clusters.get(id).rotation);
  return { ids: ids.length, before };
});
await page.click('[data-act="rotr"]');
const afterRot = await page.evaluate(() => {
  const app = globalThis.__ojs;
  const ids = [...app.selection].filter((id) => app.session.state.clusters.has(id));
  return ids.map((id) => app.session.state.clusters.get(id).rotation);
});
const quarter = Math.PI / 2;
check(
  'rotate turns the whole selection by a quarter turn',
  rotated.ids > 0 && afterRot.every((a, i) => Math.abs(Math.abs(a - rotated.before[i]) - quarter) < 1e-6),
  `${rotated.ids} clusters`,
);
check(
  'rotations land exactly on a quarter turn',
  afterRot.every((a) => Math.abs(a / quarter - Math.round(a / quarter)) < 1e-9),
);

await page.keyboard.press('Escape');
const cleared = await page.evaluate(() => globalThis.__ojs.selection.size);
check('Escape clears the selection', cleared === 0);

await page.uncheck('.rotate-on');
const straightened = await page.evaluate(() =>
  [...globalThis.__ojs.session.state.clusters.values()].every((c) => c.rotation === 0),
);
check('turning rotation off straightens every piece', straightened);

// 4. Reference panel: it must never push the page wider than the window. The first
//    implementation used CSS `resize: horizontal`, which grew the panel off-screen and
//    left it reachable only via the page scrollbar.
const overflow = () =>
  page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    panel: (() => {
      const el = document.querySelector('.reference');
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
    })(),
  }));

await page.selectOption('.ref-mode', 'right');
await page.waitForTimeout(250);
let ov = await overflow();
check('reference panel (side) is fully on screen', ov.panel.right <= ov.innerW + 1 && ov.panel.w > 50, `right edge ${Math.round(ov.panel.right)} of ${ov.innerW}`);
check('side reference does not make the page scroll sideways', ov.scrollW <= ov.innerW + 1, `${ov.scrollW} vs ${ov.innerW}`);

// Drag the splitter far past the window edge; the clamp must hold.
await page.evaluate(async () => {
  const el = document.querySelector('.splitter');
  const r = el.getBoundingClientRect();
  const f = (t, x) => el.dispatchEvent(new PointerEvent(t, { pointerId: 3, pointerType: 'mouse', isPrimary: true, bubbles: true, clientX: x, clientY: r.top + r.height / 2, button: 0, buttons: t === 'pointerup' ? 0 : 1 }));
  f('pointerdown', r.left + 3);
  for (let i = 1; i <= 6; i++) { f('pointermove', r.left - i * 400); await new Promise((z) => requestAnimationFrame(z)); }
  f('pointerup', r.left - 2400);
});
await page.waitForTimeout(200);
ov = await overflow();
check('dragging the splitter past the edge is clamped', ov.panel.w <= ov.innerW * 0.72 && ov.panel.w > 100, `panel ${Math.round(ov.panel.w)}px of ${ov.innerW}`);
check('board keeps room after a big splitter drag', ov.panel.left > 40, `board width ${Math.round(ov.panel.left)}px`);

await page.selectOption('.ref-mode', 'bottom');
await page.waitForTimeout(250);
ov = await overflow();
check('reference panel (below) is fully on screen', ov.panel.bottom <= ov.innerH + 1 && ov.panel.h > 50, `bottom edge ${Math.round(ov.panel.bottom)} of ${ov.innerH}`);
await page.selectOption('.ref-mode', 'off');

// 4b. A new puzzle must open at a zoom where pieces are legible. Fitting *all* content
//     includes the scatter ring, which is several times the board area, so a 500-piece
//     puzzle used to arrive on screen with 28px pieces on a large monitor.
await page.selectOption('.pieces', '500');
await page.waitForFunction(() => globalThis.__ojs.session.state.geometry.pieces.length > 300, null, { timeout: 60_000 });
await page.waitForTimeout(400);

const zoomCheck = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const g = app.session.state.geometry;
  const cell = Math.min(g.cellWidth, g.cellHeight);
  const px = () => cell * app.viewport.zoom;

  const onOpen = px();
  document.querySelector('[data-act="fit-all"]').click();
  await new Promise((r) => requestAnimationFrame(r));
  const fitAll = px();
  document.querySelector('[data-act="fit-board"]').click();
  await new Promise((r) => requestAnimationFrame(r));
  const fitBoard = px();
  document.querySelector('[data-act="zoom-in"]').click();
  await new Promise((r) => requestAnimationFrame(r));
  const zoomedIn = px();

  return { pieces: g.pieces.length, onOpen, fitAll, fitBoard, zoomedIn };
});

check(
  'a new 500-piece puzzle opens with legible pieces',
  zoomCheck.onOpen >= 34,
  `${zoomCheck.onOpen.toFixed(0)}px per piece at ${zoomCheck.pieces} pieces`,
);
check(
  'opening at fit-board beats fitting the whole scatter',
  zoomCheck.fitBoard > zoomCheck.fitAll * 1.4,
  `${zoomCheck.fitBoard.toFixed(0)}px vs ${zoomCheck.fitAll.toFixed(0)}px`,
);
check('the zoom-in button enlarges pieces', zoomCheck.zoomedIn > zoomCheck.fitBoard, `${zoomCheck.zoomedIn.toFixed(0)}px`);

const readout = await page.textContent('.zoom-readout');
check('zoom readout shows a percentage', /^\d+%$/.test(readout.trim()), readout);

await page.selectOption('.pieces', '50');
await page.waitForFunction(() => globalThis.__ojs.session.state.geometry.pieces.length < 100, null, { timeout: 60_000 });

// 4c. Trays: create from a selection, collapse to reclaim screen space, drag pieces in
//     and out, rename, and survive a reload.
await page.click('.tool'); // Select mode: a bare drag in Move mode pans instead
await page.evaluate(async (fireSrc) => {
  const fireEv = eval(fireSrc);
  const c = document.querySelector('.board');
  const r = c.getBoundingClientRect();
  // Lasso the whole visible board. The app now opens zoomed to the board, so a
  // narrow lasso catches only a piece or two and makes for a weak test.
  fireEv(c, 'pointerdown', r.left + 10, r.top + 10);
  for (let i = 1; i <= 10; i++) {
    fireEv(c, 'pointermove', r.left + 10 + ((r.width - 20) * i) / 10, r.top + 10 + ((r.height - 20) * i) / 10);
    await new Promise((z) => requestAnimationFrame(z));
  }
  fireEv(c, 'pointerup', r.left + r.width - 10, r.top + r.height - 10);
}, fire);

await page.click('.tool'); // back to Move mode
const beforeTray = await page.evaluate(() => globalThis.__ojs.selection.size);
check('lasso for the tray selected something', beforeTray >= 3, `${beforeTray} clusters`);
await page.click('[data-act="new-tray"]');
await page.waitForTimeout(300);

const trayMade = await page.evaluate(() => {
  const s = globalThis.__ojs.session.state;
  const tray = [...s.trays.values()][0];
  return {
    trays: s.trays.size,
    held: tray ? tray.clusters.length : 0,
    inTray: tray ? tray.clusters.every((id) => s.trayOfCluster.get(id) === tray.id) : false,
    selection: globalThis.__ojs.selection.size,
  };
});
check('New tray takes the selection', trayMade.trays === 1 && trayMade.held === beforeTray && beforeTray >= 3, `${trayMade.held} of ${beforeTray} clusters`);
check('tray membership is recorded', trayMade.inTray);
check('creating a tray clears the selection', trayMade.selection === 0);

// The rename editor opens over the tray; type a name and commit.
await page.fill('.tray-rename', 'Blue sky');
await page.press('.tray-rename', 'Enter');
await page.waitForTimeout(200);
const trayName = await page.evaluate(() => [...globalThis.__ojs.session.state.trays.values()][0].name);
check('a tray can be renamed in place', trayName === 'Blue sky', trayName);

// Collapsing must actually stop drawing the contents — that is the point of the feature.
const drawnOpen = await page.evaluate(async () => {
  globalThis.__ojs.dirty = true;
  await new Promise((r) => requestAnimationFrame(r));
  return globalThis.__ojs.renderer.stats.piecesDrawn;
});
await page.click('[data-act="collapse-tray"]');
await page.waitForTimeout(250);
const collapsed = await page.evaluate(async () => {
  globalThis.__ojs.dirty = true;
  await new Promise((r) => requestAnimationFrame(r));
  const s = globalThis.__ojs.session.state;
  const tray = [...s.trays.values()][0];
  return { drawn: globalThis.__ojs.renderer.stats.piecesDrawn, collapsed: tray.collapsed };
});
check('collapsing a tray hides its pieces from the board', collapsed.collapsed && collapsed.drawn < drawnOpen, `${drawnOpen} -> ${collapsed.drawn} drawn`);

// A collapsed tray's pieces must not be grabbable either.
const grabHidden = await page.evaluate(() => {
  const app = globalThis.__ojs;
  const s = app.session.state;
  const tray = [...s.trays.values()][0];
  if (!tray || tray.clusters.length === 0) return 'empty tray';
  const cluster = s.clusters.get(tray.clusters[0]);
  const piece = s.geometry.pieces[cluster.pieces[0]];
  const at = { x: cluster.x + (piece.solved.x - cluster.pivotX) + piece.bounds.w / 2, y: cluster.y + (piece.solved.y - cluster.pivotY) + piece.bounds.h / 2 };
  return app.renderer.hitTest(s, at) !== null;
});
check('pieces in a collapsed tray cannot be grabbed', grabHidden === false);

await page.click('[data-act="collapse-tray"]');
await page.waitForTimeout(250);

// Drag a loose piece onto the tray and confirm it joins.
const dropped = await page.evaluate(async (fireSrc) => {
  const fireEv = eval(fireSrc);
  const app = globalThis.__ojs;
  const s = app.session.state;
  const c = document.querySelector('.board');
  const r = c.getBoundingClientRect();
  const vp = () => app.viewport;
  const toScreen = (p) => ({ x: (p.x - vp().x) * vp().zoom + r.width / 2 + r.left, y: (p.y - vp().y) * vp().zoom + r.height / 2 + r.top });

  const tray = [...s.trays.values()][0];
  const free = [...s.clusters.keys()].find((id) => !s.trayOfCluster.has(id));
  const cluster = s.clusters.get(free);
  const piece = s.geometry.pieces[cluster.pieces[0]];
  // Raise it so the hit test finds this piece and not one lying on top.
  const zi = s.zOrder.indexOf(cluster.id);
  if (zi >= 0) { s.zOrder.splice(zi, 1); s.zOrder.push(cluster.id); }

  const from = toScreen({ x: cluster.x + (piece.solved.x - cluster.pivotX) + piece.bounds.w / 2, y: cluster.y + (piece.solved.y - cluster.pivotY) + piece.bounds.h / 2 });
  const to = toScreen({ x: tray.x + tray.width / 2, y: tray.y + 10 });

  fireEv(c, 'pointerdown', from.x, from.y);
  for (let i = 1; i <= 10; i++) {
    fireEv(c, 'pointermove', from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
    await new Promise((z) => requestAnimationFrame(z));
  }
  fireEv(c, 'pointerup', to.x, to.y);
  return { joined: s.trayOfCluster.get(free) === tray.id, held: tray.clusters.length, id: free };
}, fire);
check('dragging a piece onto a tray puts it in', dropped.joined, `tray now holds ${dropped.held} clusters`);

// And dragging one back out frees it.
const pulled = await page.evaluate(async (fireSrc) => {
  const fireEv = eval(fireSrc);
  const app = globalThis.__ojs;
  const s = app.session.state;
  const c = document.querySelector('.board');
  const r = c.getBoundingClientRect();
  const vp = () => app.viewport;
  const toScreen = (p) => ({ x: (p.x - vp().x) * vp().zoom + r.width / 2 + r.left, y: (p.y - vp().y) * vp().zoom + r.height / 2 + r.top });

  const tray = [...s.trays.values()][0];
  const id = tray.clusters[0];
  const cluster = s.clusters.get(id);
  const piece = s.geometry.pieces[cluster.pieces[0]];
  const zi = s.zOrder.indexOf(cluster.id);
  if (zi >= 0) { s.zOrder.splice(zi, 1); s.zOrder.push(cluster.id); }

  const from = toScreen({ x: cluster.x + (piece.solved.x - cluster.pivotX) + piece.bounds.w / 2, y: cluster.y + (piece.solved.y - cluster.pivotY) + piece.bounds.h / 2 });
  // Somewhere well clear of the tray.
  const to = { x: r.left + r.width - 60, y: r.top + 60 };

  fireEv(c, 'pointerdown', from.x, from.y);
  for (let i = 1; i <= 10; i++) {
    fireEv(c, 'pointermove', from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
    await new Promise((z) => requestAnimationFrame(z));
  }
  fireEv(c, 'pointerup', to.x, to.y);
  return { free: !s.trayOfCluster.has(id), held: tray.clusters.length };
}, fire);
check('dragging a piece out of a tray frees it', pulled.free, `tray now holds ${pulled.held} clusters`);

const trayListed = await page.evaluate(() => [...document.querySelector('.tray-list').options].map((o) => o.textContent));
check('the tray appears in the tray list', trayListed.some((t) => t.includes('Blue sky')), trayListed.join(' | '));

// 4d. Edge selection and the in-app help.
await page.click('[data-act="select-edges"]');
await page.waitForTimeout(250);
const edges = await page.evaluate(() => {
  const app = globalThis.__ojs;
  const s = app.session.state;
  const ids = [...app.selection];
  const allBorder = ids.every((id) =>
    s.clusters.get(id).pieces.some((pid) => {
      const n = s.geometry.pieces[pid].neighbours;
      return n.top < 0 || n.right < 0 || n.bottom < 0 || n.left < 0;
    }),
  );
  return { count: ids.length, allBorder, total: s.geometry.pieces.length };
});
check('Edges selects the border pieces', edges.count > 4 && edges.count < edges.total, `${edges.count} of ${edges.total}`);
check('every piece Edges selects really is on the border', edges.allBorder);
await page.keyboard.press('Escape');

// Help: hovering shows an explanation, and help mode makes a press explain not act.
await page.click('[data-act="help"]');
await page.waitForTimeout(150);
await page.hover('[data-act="shuffle"]');
await page.waitForTimeout(300);
const tip = await page.evaluate(() => {
  const t = document.querySelector('.tip');
  const r = t.getBoundingClientRect();
  return { hidden: t.hidden, len: (t.textContent || '').length, left: r.left, right: r.right };
});
check('hovering a control shows help text', !tip.hidden && tip.len > 20, `${tip.len} chars`);
check('the tooltip stays on screen', tip.left >= 0 && tip.right <= 1500, `${Math.round(tip.left)}..${Math.round(tip.right)}`);

const traysBefore = await page.evaluate(() => globalThis.__ojs.session.state.trays.size);
await page.click('[data-act="new-tray"]');
await page.waitForTimeout(250);
const traysAfter = await page.evaluate(() => globalThis.__ojs.session.state.trays.size);
check('help mode explains instead of acting', traysBefore === traysAfter, `${traysBefore} -> ${traysAfter} trays`);

await page.keyboard.press('Escape');
await page.waitForTimeout(150);
check('Escape leaves help mode', await page.evaluate(() => globalThis.__ojs.helpMode === false));

const missing = await page.evaluate(() =>
  [...document.querySelectorAll('.bar [data-act], .bar label.field, .bar label.btn')]
    .filter((el) => !el.closest('[data-help]'))
    .map((el) => el.dataset.act || el.className),
);
check('every toolbar control carries help text', missing.length === 0, missing.join(', ') || 'all covered');

// 4e. Colour sorting: groups the loose pieces and steps through them.
await page.click('[data-act="colour-sort"]');
await page.waitForTimeout(500);
const sortStart = await page.evaluate(() => {
  const app = globalThis.__ojs;
  return {
    navVisible: !document.querySelector('.colour-nav').hidden,
    groups: app.colourGroups ? app.colourGroups.length : 0,
    selected: app.selection.size,
    label: document.querySelector('.colour-label').textContent,
    swatch: document.querySelector('.swatch').style.background,
    covered: app.colourGroups
      ? app.colourGroups.reduce((n, g) => n + g.clusterIds.length, 0)
      : 0,
    free: [...app.session.state.clusters.keys()].filter((id) => !app.session.state.trayOfCluster.has(id)).length,
  };
});
check('colour sort produces groups', sortStart.groups >= 2, `${sortStart.groups} groups`);
check('the first group is selected for you', sortStart.selected > 0, `${sortStart.selected} clusters`);
check('the stepper appears with a swatch and a count', sortStart.navVisible && /\d+\/\d+/.test(sortStart.label) && sortStart.swatch.length > 0, sortStart.label);
check('every loose cluster lands in some group', sortStart.covered === sortStart.free, `${sortStart.covered} of ${sortStart.free}`);

const stepped = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const first = [...app.selection].sort().join(',');
  document.querySelector('[data-act="colour-next"]').click();
  await new Promise((r) => requestAnimationFrame(r));
  const second = [...app.selection].sort().join(',');
  document.querySelector('[data-act="colour-prev"]').click();
  await new Promise((r) => requestAnimationFrame(r));
  return { changed: first !== second, backAgain: [...app.selection].sort().join(',') === first };
});
check('stepping shows a different group', stepped.changed);
check('stepping back returns to the first group', stepped.backAgain);

// Sorting is deterministic: the same puzzle re-sorts identically.
const repeatable = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const before = app.colourGroups.map((g) => g.clusterIds.join(','));
  document.querySelector('[data-act="colour-sort"]').click();
  await new Promise((r) => requestAnimationFrame(r));
  const after = app.colourGroups.map((g) => g.clusterIds.join(','));
  return before.join('|') === after.join('|');
});
check('re-sorting the same puzzle gives the same groups', repeatable);

// Filing a group should tray it and advance automatically.
const filed = await page.evaluate(() => ({ index: globalThis.__ojs.colourIndex, trays: globalThis.__ojs.session.state.trays.size }));
await page.click('[data-act="new-tray"]');
await page.waitForTimeout(250);
await page.fill('.tray-rename', 'Colour group');
await page.press('.tray-rename', 'Enter');
await page.waitForTimeout(350);
const afterFiled = await page.evaluate(() => ({ index: globalThis.__ojs.colourIndex, trays: globalThis.__ojs.session.state.trays.size }));
check('New tray files the colour group', afterFiled.trays === filed.trays + 1, `${filed.trays} -> ${afterFiled.trays} trays`);
check('and advances to the next group', afterFiled.index !== filed.index, `group ${filed.index + 1} -> ${afterFiled.index + 1}`);

await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape ends colour sorting', await page.evaluate(() => globalThis.__ojs.colourGroups === null));

// 4f. Portable .jigsaw files: export and re-import round-trips.
await page.click('[data-act="library"]');
await page.waitForSelector('.lib-card', { timeout: 10_000 });
const cardsBefore = await page.evaluate(() => document.querySelectorAll('.lib-card').length);
const downloadPromise = page.waitForEvent('download');
await page.click('.lib-export');
const download = await downloadPromise;
const exportPath = '/tmp/ojs-smoke-export.jigsaw';
await download.saveAs(exportPath);
check('a puzzle exports as a .jigsaw file', download.suggestedFilename().endsWith('.jigsaw'), download.suggestedFilename());

await page.setInputFiles('.import-file', exportPath);
await page.waitForTimeout(1200);
const cardsAfter = await page.evaluate(() => document.querySelectorAll('.lib-card').length);
check('importing it back adds a puzzle', cardsAfter === cardsBefore + 1, `${cardsBefore} -> ${cardsAfter}`);
check('import does not overwrite the original', cardsAfter > cardsBefore);

const imported = await page.evaluate(async () => {
  document.querySelectorAll('.lib-card')[0].querySelector('.lib-open').click();
  await new Promise((r) => setTimeout(r, 900));
  const s = globalThis.__ojs.session;
  return { pieces: s.state.geometry.pieces.length, title: s.record.title };
});
check('the imported puzzle opens with its pieces', imported.pieces > 0, `${imported.pieces} pieces`);
// Opening from the library closes it, so there is nothing left to close.
check('opening from the library closes it', await page.evaluate(() => document.querySelector('.library').hidden));

// 5. Renaming a puzzle.
await page.fill('.title', 'Great Ocean Road');
await page.dispatchEvent('.title', 'change');
await page.waitForTimeout(200);
const named = await page.evaluate(() => globalThis.__ojs.session.record.title);
check('the puzzle can be renamed', named === 'Great Ocean Road', named);

// 6. Library lists saved puzzles and can reopen one.
await page.click('[data-act="library"]');
await page.waitForSelector('.lib-card', { timeout: 10_000 });
const lib = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.lib-card')];
  return {
    count: cards.length,
    titles: cards.map((c) => c.querySelector('.lib-title').textContent),
    thumbs: cards.filter((c) => c.querySelector('.lib-thumb img')).length,
  };
});
check('library lists saved puzzles', lib.count >= 1, `${lib.count} listed`);
check('library shows the renamed puzzle', lib.titles.includes('Great Ocean Road'), lib.titles.join(', '));
check('library cards have thumbnails', lib.thumbs === lib.count, `${lib.thumbs}/${lib.count}`);
await page.click('[data-act="close-library"]');

// 7. Save and reload restores the board.
await page.evaluate(() => globalThis.__ojs.save());
const restored = await page.evaluate(() => globalThis.__ojs.session.state.clusters.size);
await page.reload();
await page.waitForFunction(() => globalThis.__ojs?.session, null, { timeout: 30_000 });
await page.waitForTimeout(500);
const afterReload = await page.evaluate(() => ({
  clusters: globalThis.__ojs.session.state.clusters.size,
  title: globalThis.__ojs.session.record.title,
}));
check('progress survives a page reload', afterReload.clusters === restored, `${restored} -> ${afterReload.clusters} clusters`);
check('the new name survives a page reload', afterReload.title === 'Great Ocean Road', afterReload.title);

const traysAfterReload = await page.evaluate(() => {
  const s = globalThis.__ojs.session.state;
  const tray = [...s.trays.values()][0];
  return tray
    ? { name: tray.name, held: tray.clusters.length, mapped: tray.clusters.every((id) => s.trayOfCluster.get(id) === tray.id) }
    : null;
});
check('trays survive a page reload', traysAfterReload !== null && traysAfterReload.name === 'Blue sky' && traysAfterReload.held > 0, traysAfterReload ? `“${traysAfterReload.name}” with ${traysAfterReload.held} clusters` : 'no trays');
check('tray membership is rebuilt on load', traysAfterReload?.mapped === true);

// 8. Image preparation: turn and crop the picture, then cut a puzzle from the result.
const beforePrep = await page.evaluate(() => ({
  w: globalThis.__ojs.session.state.geometry.imageWidth,
  h: globalThis.__ojs.session.state.geometry.imageHeight,
}));
await page.click('[data-act="prepare"]');
await page.waitForSelector('.prepare .prep-canvas', { timeout: 10_000 });
await page.waitForTimeout(200);
await page.click('[data-prep="rot-right"]');
await page.locator('.prep-aspect', { hasText: 'Square' }).click();
await page.waitForTimeout(150);
const prepReadout = await page.textContent('.prep-readout');
check('preparation previews the resulting piece size', /\d+×\d+ → \d+ pieces/.test(prepReadout ?? ''), prepReadout ?? '');
await page.click('[data-prep="create"]');
await page.waitForSelector('.prepare', { state: 'detached', timeout: 10_000 });
await page.waitForTimeout(400);

const afterPrep = await page.evaluate(() => ({
  w: globalThis.__ojs.session.state.geometry.imageWidth,
  h: globalThis.__ojs.session.state.geometry.imageHeight,
  turns: globalThis.__ojs.session.record.edit?.turns ?? null,
  original: { w: globalThis.__ojs.session.original.width, h: globalThis.__ojs.session.original.height },
}));
const expectedSide = Math.min(beforePrep.w, beforePrep.h);
check(
  'a square crop cuts a square puzzle',
  Math.abs(afterPrep.w - afterPrep.h) <= 1 && Math.abs(afterPrep.w - expectedSide) <= 2,
  `${beforePrep.w}×${beforePrep.h} -> ${afterPrep.w}×${afterPrep.h}`,
);
check('the edit is recorded with the puzzle', afterPrep.turns === 1, `turns=${afterPrep.turns}`);
check(
  'the original picture is kept untouched beside the prepared one',
  afterPrep.original.w === beforePrep.w && afterPrep.original.h === beforePrep.h,
  `${afterPrep.original.w}×${afterPrep.original.h}`,
);

// The edit is stored as parameters, so the prepared picture has to survive a reload by
// being re-derived -- not by having been saved as a second copy of the photograph.
await page.evaluate(() => globalThis.__ojs.save());
await page.reload();
await page.waitForFunction(() => globalThis.__ojs?.session, null, { timeout: 30_000 });
await page.waitForTimeout(500);
const rederived = await page.evaluate(() => ({
  w: globalThis.__ojs.session.state.geometry.imageWidth,
  h: globalThis.__ojs.session.state.geometry.imageHeight,
  turns: globalThis.__ojs.session.record.edit?.turns ?? null,
}));
check(
  'the prepared picture is re-derived after a reload',
  rederived.w === afterPrep.w && rederived.h === afterPrep.h && rederived.turns === 1,
  `${rederived.w}×${rederived.h}, turns=${rederived.turns}`,
);

// 9. A puzzle whose picture has gone missing: it is flagged, and it can be relinked.
//    Losing the image row is the failure that used to produce a card that simply would
//    not open, blaming "its image is missing" whatever had actually gone wrong.
const orphan = await page.evaluate(async () => {
  const hash = globalThis.__ojs.session.record.imageHash;
  // Keep the bytes so the relink has a real file to offer, then remove the row.
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('open-jigsaw-studio');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const blob = await new Promise((res, rej) => {
    const r = db.transaction('images', 'readonly').objectStore('images').get(hash);
    r.onsuccess = () => res(r.result?.blob ?? null);
    r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').delete(hash);
    tx.oncomplete = () => res();
    tx.onabort = () => rej(tx.error);
  });
  db.close();
  globalThis.__ojsRescue = blob;
  return { hash, kept: !!blob };
});
check('the picture bytes were captured before removing the row', orphan.kept);

await page.click('[data-act="library"]');
await page.waitForSelector('.lib-card', { timeout: 10_000 });
const flagged = await page.evaluate(() => {
  const card = document.querySelector('.lib-card.orphaned');
  return card
    ? {
        warn: !!card.querySelector('.lib-warn'),
        relink: !!card.querySelector('.lib-relink'),
        open: !!card.querySelector('.lib-open'),
      }
    : null;
});
check('a puzzle with no picture is flagged in the library', flagged?.warn === true);
check('and is offered a relink instead of a dead Open button', flagged?.relink === true && flagged?.open === false);

// Relinking with the wrong file must be refused: the pieces were cut from one exact file.
const refused = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const record = app.session.record;
  const wrong = new File([new Uint8Array([1, 2, 3, 4])], 'not-it.png', { type: 'image/png' });
  await app.applyRelink(record, wrong);
  return document.querySelector('.lib-note')?.textContent ?? '';
});
check('the wrong picture is refused', /not the picture/i.test(refused), refused.slice(0, 60));

const healed = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const record = app.session.record;
  const file = new File([globalThis.__ojsRescue], 'original.png', { type: 'image/png' });
  await app.applyRelink(record, file);
  return {
    note: document.querySelector('.lib-note')?.textContent ?? '',
    stillOrphaned: !!document.querySelector('.lib-card.orphaned'),
  };
});
check('the right picture restores it', /restored/i.test(healed.note), healed.note.slice(0, 60));
check('and the card stops being flagged', healed.stillOrphaned === false);
await page.click('[data-act="close-library"]');

// 10. Assistance levels: ghost, neighbour hints, edges only.
const ghostEffect = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const canvas = document.querySelector('.board');
  const ctx = canvas.getContext('2d');
  // Sample a patch of bare board -- inside the picture area but away from the scatter
  // ring, so any change there is the ghost and not a piece.
  const sample = () => {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 31) total += data[i] + data[i + 1] + data[i + 2];
    return total;
  };
  app.renderer.ghost = 0;
  app.dirty = true;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const off = sample();
  app.renderer.ghost = 0.45;
  app.dirty = true;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const on = sample();
  app.renderer.ghost = 0;
  app.dirty = true;
  return { off, on };
});
check('the ghost changes what is painted', ghostEffect.on !== ghostEffect.off);

const hints = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const state = app.session.state;
  // Select one loose single-piece cluster and ask for its neighbours.
  const single = [...state.clusters.values()].find((c) => c.pieces.length === 1);
  app.selection.clear();
  app.selection.add(single.id);
  app.syncSelection();
  const before = app.renderer.hintClusters?.size ?? null;
  app.toggleHints();
  const after = app.renderer.hintClusters?.size ?? null;
  const pieceId = single.pieces[0];
  const piece = state.geometry.pieces[pieceId];
  const realNeighbours = [piece.neighbours.top, piece.neighbours.right, piece.neighbours.bottom, piece.neighbours.left].filter((n) => n >= 0).length;
  return { before, after, realNeighbours, selfIncluded: app.renderer.hintClusters?.has(single.id) ?? false };
});
check('hints are off until asked for', hints.before === null);
check('hints outline exactly the neighbours of the selection', hints.after === hints.realNeighbours, `${hints.after} outlined, ${hints.realNeighbours} neighbours`);
check('hints never include the selection itself', hints.selfIncluded === false);

// Marking a neighbour is worthless if the neighbour is off-screen, which in a fresh
// scatter it usually is. Find must bring the selection and every hint into view.
const find = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const st = app.session.state;
  const findBtn = document.querySelector('[data-act="hint-find"]');
  const offered = !findBtn.hidden;

  const inView = () => {
    const size = app.renderer.size;
    const vp = app.viewport;
    const halfW = size.width / 2 / vp.zoom;
    const halfH = size.height / 2 / vp.zoom;
    const ids = [...app.selection, ...app.renderer.hintClusters];
    return ids.every((id) => {
      const c = st.clusters.get(id);
      return (
        Math.abs(c.x - vp.x) <= halfW && Math.abs(c.y - vp.y) <= halfH
      );
    });
  };

  findBtn.click();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { offered, allVisible: inView() };
});
check('Find is offered once there are hints to find', find.offered === true);
check('Find brings the selection and every hint into view', find.allVisible === true);

const findHidden = await page.evaluate(() => {
  const app = globalThis.__ojs;
  app.selection.clear();
  app.syncSelection();
  return document.querySelector('[data-act="hint-find"]').hidden;
});
check('Find disappears when there is nothing selected', findHidden === true);

const edgesOnly = await page.evaluate(async () => {
  const app = globalThis.__ojs;
  const total = app.session.state.geometry.pieces.length;
  app.toggleEdgesOnly();
  const shown = app.renderer.onlyPieces?.size ?? null;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const drawnWhenFiltered = app.renderer.stats.piecesDrawn;
  // An interior piece must not be grabbable while it is hidden.
  const interior = app.session.state.geometry.pieces.find((p) => !app.renderer.onlyPieces.has(p.id));
  const cluster = app.session.state.clusters.get(app.session.state.clusterOfPiece[interior.id]);
  const centre = { x: cluster.x, y: cluster.y };
  const grabbed = app.renderer.hitTest(app.session.state, centre);
  app.toggleEdgesOnly();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return {
    total,
    shown,
    drawnWhenFiltered,
    drawnAfter: app.renderer.stats.piecesDrawn,
    grabbedInterior: grabbed?.pieceId === interior.id,
  };
});
check('edges-only shows fewer pieces than the puzzle has', edgesOnly.shown !== null && edgesOnly.shown < edgesOnly.total, `${edgesOnly.shown} of ${edgesOnly.total}`);
check('and actually draws fewer of them', edgesOnly.drawnWhenFiltered < edgesOnly.drawnAfter, `${edgesOnly.drawnWhenFiltered} -> ${edgesOnly.drawnAfter} drawn`);
check('a hidden interior piece cannot be grabbed', edgesOnly.grabbedInterior === false);
check('switching it off brings every piece back', edgesOnly.drawnAfter > edgesOnly.drawnWhenFiltered);

await page.screenshot({ path: new URL('../smoke.png', import.meta.url).pathname });
console.log('\nwrote smoke.png');

await browser.close();
server.close();

if (failures.length) {
  console.error('\nFAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('all smoke checks passed');
