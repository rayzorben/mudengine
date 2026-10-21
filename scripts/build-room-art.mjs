#!/usr/bin/env node
/**
 * Ships the room art run's pictures with the window (todo 20261020-2015-01).
 *
 *   npm run build:room-art -- [zip]
 *
 * The zip (default `mdb/room-art.zip`) is the run's output, copied from
 * orohost (/storage/apps/item-art): `room-index.json` (format 1, `byRoom` per
 * realm from the world databases, map/room to key) and `<key>.webp` at 512 px,
 * keyed by the first 16 hex of SHA-1 over the description with its whitespace
 * collapsed (`src/main/art/roomKey.ts`). Writes each picture into
 * `src/renderer/public/room-art/`, which the build copies beside the window
 * for both hosts, and the index main reads at `resources/art/room-index.json`
 * (`ShippedRoomArt`): the keys shipped, and per realm family the map/room
 * table of the rooms a picture was shipped for. A picture already there with
 * the same size is left.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ROOM_KEY } from '../src/main/art/roomKey.ts';
import { ROOM_INDEX_FORMAT } from '../src/main/art/ShippedRoomArt.ts';
import { readZipEntry, zipEntries } from '../src/main/world/zip.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const zip = path.resolve(process.argv[2] ?? path.join(root, 'mdb', 'room-art.zip'));
if (!existsSync(zip)) {
  console.error(`build:room-art: ${zip} is not there`);
  process.exit(2);
}

const entries = zipEntries(zip);
const indexEntry = entries.find((entry) => entry.name === 'room-index.json');
if (indexEntry === undefined) {
  console.error(`build:room-art: ${zip} has no room-index.json`);
  process.exit(1);
}
const index = JSON.parse(readZipEntry(zip, indexEntry).toString('utf8'));
if (index.format !== 1 || typeof index.byRoom !== 'object' || index.byRoom === null) {
  console.error(`build:room-art: ${zip}'s room-index.json is not format 1`);
  process.exit(1);
}

const pictures = entries.filter(
  (entry) => entry.name.endsWith('.webp') && ROOM_KEY.test(entry.name.slice(0, -5))
);
const keys = new Set(pictures.map((entry) => entry.name.slice(0, -5)));

/** Per realm family, as the run drew them: a realm the run did not draw has no table. */
const byRoom = {};
let rooms = 0;
let unshipped = 0;
for (const [realm, table] of Object.entries(index.byRoom)) {
  byRoom[realm] = {};
  for (const [room, key] of Object.entries(table)) {
    if (!keys.has(key)) {
      unshipped++;
      continue;
    }
    byRoom[realm][room] = key;
    rooms++;
  }
}

const out = path.join(root, 'src/renderer/public/room-art');
mkdirSync(out, { recursive: true });
let written = 0;
for (const entry of pictures) {
  const target = path.join(out, entry.name);
  if (existsSync(target) && statSync(target).size === entry.size) continue;
  writeFileSync(target, readZipEntry(zip, entry));
  written++;
}

const shipped = { format: ROOM_INDEX_FORMAT, keys: [...keys].sort(), byRoom };
mkdirSync(path.join(root, 'resources/art'), { recursive: true });
writeFileSync(path.join(root, 'resources/art/room-index.json'), JSON.stringify(shipped));
console.log(
  `build:room-art: ${written} written, ${pictures.length - written} up to date, ` +
    `${rooms} rooms indexed over ${Object.keys(byRoom).join(', ')}, ${unshipped} index rows with no picture`
);
