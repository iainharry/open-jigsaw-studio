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
  const grabbed = app.renderer.highlightCluster !== null;
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

// 3. Save and reload restores the board.
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
