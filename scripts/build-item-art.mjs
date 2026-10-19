#!/usr/bin/env node
/**
 * Ships the item art run's pictures with the window (todo 20261018-2032-01).
 *
 *   npm run build:item-art -- <dir>
 *
 * <dir> is the run's output, copied from orohost (/storage/apps/item-art):
 * `index.json` (the pipeline's `itemart.py index`), `items/<key>.png` and
 * `portraits/<race>-<class>.png`. Writes the index the renderer imports
 * (`src/renderer/src/assets/item-art-index.json`) and each picture at 512 px
 * as WebP into `src/renderer/public/item-art/`, which the build copies beside
 * the window for both hosts. A picture already newer than its source is left.
 * Needs ImageMagick (`magick`).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const from = process.argv[2];
if (!from) {
  console.error('usage: npm run build:item-art -- <the art run output directory>');
  process.exit(2);
}
try {
  await run('magick', ['-version']);
} catch {
  console.error('build:item-art: ImageMagick (magick) is not on the PATH');
  process.exit(2);
}

const index = JSON.parse(readFileSync(path.join(from, 'index.json'), 'utf8'));
if (index.format !== 1) {
  console.error(`build:item-art: ${path.join(from, 'index.json')} is not format 1`);
  process.exit(1);
}
const portraitDir = path.join(from, 'portraits');
const portraits = existsSync(portraitDir)
  ? readdirSync(portraitDir)
      .filter((file) => /^[a-z0-9-]+\.png$/.test(file))
      .map((file) => file.slice(0, -4))
  : [];

const out = path.join(root, 'src/renderer/public/item-art');
mkdirSync(path.join(out, 'portraits'), { recursive: true });
const jobs = [];
const keys = new Set([
  ...Object.values(index.byName),
  ...Object.values(index.byId).flatMap((table) => Object.values(table)),
  ...Object.values(index.coins)
]);
let missing = 0;
for (const key of keys) {
  const source = path.join(from, 'items', `${key}.png`);
  if (!existsSync(source)) missing++;
  else jobs.push({ source, target: path.join(out, `${key}.webp`), trim: true });
}
for (const name of portraits)
  jobs.push({
    source: path.join(portraitDir, `${name}.png`),
    target: path.join(out, 'portraits', `${name}.webp`),
    trim: false
  });

const stale = jobs.filter(
  ({ source, target }) => !existsSync(target) || statSync(target).mtimeMs < statSync(source).mtimeMs
);
// Two at a time: the machine is in use, and this is not worth its cores.
let next = 0;
async function worker() {
  while (next < stale.length) {
    const { source, target, trim } = stale[next++];
    const shape = trim
      ? [
          '-trim',
          '+repage',
          '-resize',
          '480x480',
          '-gravity',
          'center',
          '-background',
          'none',
          '-extent',
          '512x512'
        ]
      : ['-resize', '512x512'];
    await run('magick', [source, ...shape, '-quality', '84', target]);
  }
}
await Promise.all([worker(), worker()]);

const shipped = { ...index, portraits };
writeFileSync(
  path.join(root, 'src/renderer/src/assets/item-art-index.json'),
  JSON.stringify(shipped)
);
console.log(
  `build:item-art: ${stale.length} written, ${jobs.length - stale.length} up to date, ` +
    `${missing} pictures the run has not drawn yet, ${portraits.length} portraits`
);
