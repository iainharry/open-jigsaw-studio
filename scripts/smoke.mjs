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
  const grabPiece = pieceIds[0];
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

// 4. Save and reload restores the board.
await page.evaluate(() => globalThis.__ojs.save());
const restored = await page.evaluate(() => globalThis.__ojs.session.state.clusters.size);
await page.reload();
await page.waitForFunction(() => globalThis.__ojs?.session, null, { timeout: 30_000 });
await page.waitForTimeout(500);
const afterReload = await page.evaluate(() => globalThis.__ojs.session.state.clusters.size);
check('progress survives a page reload', afterReload === restored, `${restored} -> ${afterReload} clusters`);

await page.screenshot({ path: new URL('../smoke.png', import.meta.url).pathname });
console.log('\nwrote smoke.png');

await browser.close();
server.close();

if (failures.length) {
  console.error('\nFAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('all smoke checks passed');
