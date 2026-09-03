/**
 * Checks the things that make this installable and offline-capable — and that fail
 * silently when they break.
 *
 * A broken service worker does not throw. It just quietly stops caching, and you find
 * out weeks later when the app will not open on a train. So this serves the real build,
 * lets the worker install, then *kills the server* and reloads, asserting the app boots
 * having made zero network requests.
 *
 * Same Playwright caveat as bench.mjs — see its header.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const DIST = new URL('../dist/', import.meta.url).pathname;
const BASE = '/open-jigsaw-studio/';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.map': 'application/json', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

let offline = false;
let served = 0;
const server = createServer(async (req, res) => {
  if (offline) return void res.destroy();
  served++;
  let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path.startsWith(BASE)) path = path.slice(BASE.length - 1);
  if (path === '/' || path === '') path = '/index.html';
  try {
    const file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const failures = [];
page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

await page.goto(`http://127.0.0.1:${port}${BASE}`);
await page.waitForFunction(() => globalThis.__ojs?.session, null, { timeout: 30_000 });

const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel=manifest]');
  if (!link) return null;
  const m = await (await fetch(link.href)).json();
  return { name: m.name, display: m.display, icons: (m.icons || []).length, start: m.start_url };
});
check('the app has a web manifest', manifest !== null);
check('it declares itself installable', manifest?.display === 'standalone', manifest?.display);
check('it ships icons', (manifest?.icons ?? 0) >= 2, `${manifest?.icons} icons`);
check('start_url is relative, so it works under any base path', manifest?.start.startsWith('./'), manifest?.start);

await page.waitForTimeout(2000);
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const keys = await caches.keys();
  const cache = keys.length ? await caches.open(keys[0]) : null;
  return { active: Boolean(reg?.active), caches: keys.length, entries: cache ? (await cache.keys()).length : 0 };
});
check('a service worker is active', sw.active);
check('exactly one cache exists', sw.caches === 1, `${sw.caches} caches`);
check('the build is precached', sw.entries >= 4, `${sw.entries} entries`);

// The real test: no server at all.
offline = true;
const beforeReload = served;
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
const booted = await page
  .waitForFunction(() => globalThis.__ojs?.session, null, { timeout: 30_000 })
  .then(() => true)
  .catch(() => false);
check('the app boots with the server switched off', booted);
check('and makes no network requests doing it', served === beforeReload, `${served - beforeReload} requests`);
if (booted) {
  const pieces = await page.evaluate(() => globalThis.__ojs.session.state.geometry.pieces.length);
  check('the puzzle in progress is still there', pieces > 0, `${pieces} pieces`);
}

await browser.close();
server.close();

if (failures.length) {
  console.error('\nFAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
console.log('\nall PWA checks passed');
