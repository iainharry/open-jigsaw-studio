/**
 * Piece-count benchmark.
 *
 * "It seems fast" is not a result. This drives the real built app in a real browser,
 * pans the viewport for a fixed number of frames at each piece count, and reports
 * measured frame time and baked-bitmap memory.
 *
 * Requires Playwright, which is deliberately NOT a project dependency (it pulls
 * ~300 MB of browsers). Install it only when you want to run this:
 *
 *   npm run build
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/bench.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const DIST = new URL('../dist/', import.meta.url).pathname;
const BASE = '/open-jigsaw-studio/';
const COUNTS = [50, 100, 200, 500, 1000, 2000];
const FRAMES = 90;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.webp': 'image/webp',
};

function serve() {
  const server = createServer(async (req, res) => {
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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const { server, port } = await serve();
const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--no-sandbox'],
  // Set CHROMIUM_PATH to use a Chromium that Playwright did not download itself.
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto(`http://127.0.0.1:${port}${BASE}`);
await page.waitForFunction(() => globalThis.__ojs?.session, null, { timeout: 30_000 });

// The built-in demo image is 1.8 megapixels, and the app correctly refuses to cut it
// into 2,000 pieces. Swap in a large synthetic image so the high counts are reachable.
await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 4400;
  c.height = 3000;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0, '#2b4c7e');
  g.addColorStop(0.5, '#d98f4a');
  g.addColorStop(1, '#25403a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `hsla(${(i * 37) % 360},70%,60%,0.5)`;
    ctx.fillRect((i * 977) % c.width, (i * 613) % c.height, 14, 14);
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.9));
  await globalThis.__ojs.adoptImage(blob, 'bench');
});
await page.waitForFunction(() => globalThis.__ojs?.session?.image?.width > 3000, null, {
  timeout: 60_000,
});

const results = [];
let previous = -1;
for (const count of COUNTS) {
  await page.selectOption('.pieces', String(count));
  await page.waitForFunction(
    (prev) => {
      const s = globalThis.__ojs?.session?.state;
      return s && s.geometry.pieces.length !== prev;
    },
    previous,
    { timeout: 90_000 },
  );

  const measured = await page.evaluate(async (frames) => {
    const app = globalThis.__ojs;
    const times = [];
    // Pan the viewport every frame so nothing can be skipped as a no-op redraw.
    for (let i = 0; i < frames; i++) {
      app.viewport = { ...app.viewport, x: app.viewport.x + 2.5 };
      app.dirty = true;
      await new Promise((r) => requestAnimationFrame(() => r()));
      times.push(app.renderer.stats.lastFrameMs);
    }
    times.sort((a, b) => a - b);
    const at = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
    return {
      pieces: app.session.state.geometry.pieces.length,
      median: at(0.5),
      p95: at(0.95),
      drawn: app.renderer.stats.piecesDrawn,
      culled: app.renderer.stats.piecesCulled,
      bakedMB: app.renderer.stats.bakedBytes / (1024 * 1024),
      clusters: app.session.state.clusters.size,
    };
  }, FRAMES);

  results.push(measured);
  previous = measured.pieces;
  console.log(
    `${String(measured.pieces).padStart(5)} pieces | ` +
      `median ${measured.median.toFixed(2)} ms | p95 ${measured.p95.toFixed(2)} ms | ` +
      `${measured.drawn} drawn / ${measured.culled} culled | ` +
      `${measured.bakedMB.toFixed(1)} MB baked`,
  );
}

// The numbers above are all at fit-to-view zoom, where every piece is on screen but
// baked small. The opposite case matters just as much: zoomed to 1:1, where each piece
// bakes at full resolution and culling is what keeps memory bounded.
const zoomed = await page.evaluate(async (frames) => {
  const app = globalThis.__ojs;
  app.renderer.bakeCache.clear();
  app.viewport = { ...app.viewport, zoom: 1 };
  const times = [];
  for (let i = 0; i < frames; i++) {
    app.viewport = { ...app.viewport, x: app.viewport.x + 6 };
    app.dirty = true;
    await new Promise((r) => requestAnimationFrame(() => r()));
    times.push(app.renderer.stats.lastFrameMs);
  }
  times.sort((a, b) => a - b);
  return {
    median: times[Math.floor(times.length / 2)],
    p95: times[Math.floor(times.length * 0.95)],
    drawn: app.renderer.stats.piecesDrawn,
    culled: app.renderer.stats.piecesCulled,
    bakedMB: app.renderer.stats.bakedBytes / (1024 * 1024),
  };
}, FRAMES);

console.log(
  `\n2,000 pieces at 1:1 zoom | median ${zoomed.median.toFixed(2)} ms | ` +
    `p95 ${zoomed.p95.toFixed(2)} ms | ${zoomed.drawn} drawn / ${zoomed.culled} culled | ` +
    `${zoomed.bakedMB.toFixed(1)} MB baked`,
);

console.log('\nJSON:', JSON.stringify({ fitted: results, zoomed }));

await browser.close();
server.close();
