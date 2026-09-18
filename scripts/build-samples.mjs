/**
 * Builds `public/samples/index.json` by looking at what is in `public/samples/`.
 *
 * Scanned rather than hand-listed, because the whole point is that adding a picture is
 * *dropping a file in the folder*. A list to edit is a list to forget, and the failure is
 * silent — the file sits there and never appears, with nothing to say why.
 *
 * Titles come from filenames (`world-map.webp` → "World map"), which keeps the common case
 * free. Anything a filename cannot carry — a longer description, a credit, a suggested
 * piece count — goes in an optional `titles.json` beside the images, merged in where
 * present. Missing metadata is never an error; it just means the defaults are used.
 *
 * **What this script deliberately does not do is measure the pictures.** A number baked
 * into a manifest only protects the pictures somebody remembered to measure, and it would
 * need an image decoder here — a build dependency, for a project that has none. The app
 * measures instead, on the picture it is actually about to cut, which covers the
 * photograph a person imports as well as the samples shipped with it. See
 * `src/engine/pictureDetail.ts`.
 *
 * Run by `npm run build`. Also safe to run on its own after adding a file.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = new URL('../public/samples/', import.meta.url).pathname;
const IMAGE = /\.(webp|png|jpe?g|avif)$/i;

/** "world-map.webp" → "World map". Hyphens and underscores become spaces. */
function titleFrom(file) {
  const stem = file.replace(IMAGE, '').replace(/[-_]+/g, ' ').trim();
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

const entries = (await readdir(DIR)).filter((f) => IMAGE.test(f)).sort();

let extra = {};
try {
  extra = JSON.parse(await readFile(join(DIR, 'titles.json'), 'utf8'));
} catch {
  // No overrides is the normal case, not a problem.
}

const samples = entries.map((file) => {
  const override = extra[file] ?? {};
  return {
    file,
    title: override.title ?? titleFrom(file),
    ...(override.note ? { note: override.note } : {}),
    ...(override.credit ? { credit: override.credit } : {}),
  };
});

// Listed overrides that name a file which is not there: a typo, and the note the author
// wrote will never be seen. Worth a line on the console rather than silence.
for (const name of Object.keys(extra)) {
  if (!entries.includes(name)) {
    console.warn(`build-samples: titles.json mentions "${name}", which is not in public/samples/`);
  }
}

await writeFile(join(DIR, 'index.json'), `${JSON.stringify({ samples }, null, 2)}\n`);
console.log(`samples/index.json written — ${samples.length} picture(s)`);
