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
 * **Collections are sub-folders, and nothing else.** `samples/beach/rockpool.webp` is in
 * the Beach collection because it is in the `beach` folder. There is no list of
 * collections to keep in step with the files, no tag to forget, and no way for the two to
 * disagree — the same reason the file list itself is scanned. A picture left loose in
 * `samples/` has no collection and appears under "Everything else"; that is the right
 * default, because it means the seven pictures that were here before collections existed
 * carry on working untouched.
 *
 * One level deep, on purpose. Sub-collections would need a tree in the gallery, and a
 * gallery you navigate is worse than one you look at until there are far more pictures
 * than this. Anything nested deeper is ignored, with a warning, rather than silently
 * flattened into its grandparent — a picture that vanishes without explanation is the
 * failure this whole script exists to avoid.
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

/** "early-years" → "Early years". A folder name is a collection name. */
function groupFrom(folder) {
  const words = folder.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

let extra = {};
try {
  extra = JSON.parse(await readFile(join(DIR, 'titles.json'), 'utf8'));
} catch {
  // No overrides is the normal case, not a problem.
}
/** Optional display names for collections, keyed by folder name. */
const groupNames = extra.groups ?? {};

/** Relative paths of every picture, root first, then one level of sub-folders. */
const found = [];
for (const entry of (await readdir(DIR, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
  if (entry.isFile() && IMAGE.test(entry.name)) {
    found.push({ path: entry.name, folder: null });
    continue;
  }
  if (!entry.isDirectory()) continue;
  for (const inner of (await readdir(join(DIR, entry.name), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (inner.isFile() && IMAGE.test(inner.name)) {
      found.push({ path: `${entry.name}/${inner.name}`, folder: entry.name });
    } else if (inner.isDirectory()) {
      console.warn(
        `build-samples: "${entry.name}/${inner.name}/" is nested too deep — collections are one folder deep, so nothing inside it will appear.`,
      );
    }
  }
}

// Collections first and in folder order, then the loose pictures, so a gallery that
// simply renders the list in order already groups correctly.
found.sort((a, b) => {
  if (a.folder === b.folder) return a.path < b.path ? -1 : 1;
  if (a.folder === null) return 1;
  if (b.folder === null) return -1;
  return a.folder < b.folder ? -1 : 1;
});

const samples = found.map(({ path, folder }) => {
  // Keyed by the path as it appears here, but a bare filename still works for a picture
  // that has since been moved into a folder — otherwise adding collections would silently
  // drop every title written before them.
  const override = extra[path] ?? extra[path.split('/').pop()] ?? {};
  return {
    file: path,
    title: override.title ?? titleFrom(path.split('/').pop()),
    ...(folder ? { group: groupNames[folder] ?? groupFrom(folder) } : {}),
    ...(override.note ? { note: override.note } : {}),
    ...(override.credit ? { credit: override.credit } : {}),
  };
});

// Listed overrides that name a file which is not there: a typo, and the note the author
// wrote will never be seen. Worth a line on the console rather than silence.
const names = new Set(found.flatMap(({ path }) => [path, path.split('/').pop()]));
for (const name of Object.keys(extra)) {
  if (name !== 'groups' && !names.has(name)) {
    console.warn(`build-samples: titles.json mentions "${name}", which is not in public/samples/`);
  }
}

await writeFile(join(DIR, 'index.json'), `${JSON.stringify({ samples }, null, 2)}\n`);
const collections = new Set(samples.map((s) => s.group).filter(Boolean));
console.log(
  `samples/index.json written — ${samples.length} picture(s)` +
    (collections.size ? ` in ${collections.size} collection(s): ${[...collections].join(', ')}` : ''),
);
