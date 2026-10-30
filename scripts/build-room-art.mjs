#!/usr/bin/env node
/**
 * Ships the room art run's pictures with the window (todo 20261021-1417-01).
 *
 *   npm run build:room-art -- [zip]
 *
 * The zip (default `mdb/room-art.zip`, copied from orohost's run) holds
 * `room-index.json` (format 2: per realm, map/room to `<key>:<turn>`),
 * `room-described.json` (each drawing's `roomKey` of its description) and
 * `<key>.webp` at 512 px. Writes the pictures into `src/renderer/public/room-art/`,
 * removing any not in the set, and the index `ShippedRoomArt` reads at
 * `resources/art/room-index.json`. The reasoning is `mudengine-ui` › `parts/game.md`.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ROOM_KEY } from '../src/main/art/roomKey.ts';
import { ROOM_INDEX_FORMAT, shippedRow } from '../src/main/art/ShippedRoomArt.ts';
import { openZip } from '../src/main/world/zip.ts';

/** The art run's index format this reads, the run with exits. */
const RUN_INDEX_FORMAT = 2;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const zip = path.resolve(process.argv[2] ?? path.join(root, 'mdb', 'room-art.zip'));
if (!existsSync(zip)) {
  console.error(`build:room-art: ${zip} is not there`);
  process.exit(2);
}

const archive = openZip(zip);
const { entries } = archive;
const readJson = (name) => {
  const entry = entries.find((one) => one.name === name);
  if (entry === undefined) {
    console.error(`build:room-art: ${zip} has no ${name}`);
    process.exit(1);
  }
  return JSON.parse(archive.read(entry).toString('utf8'));
};
const index = readJson('room-index.json');
if (index.format !== RUN_INDEX_FORMAT || typeof index.byRoom !== 'object' || index.byRoom === null) {
  console.error(`build:room-art: ${zip}'s room-index.json is not format ${RUN_INDEX_FORMAT}`);
  process.exit(1);
}
const described = readJson('room-described.json');

const pictures = entries.filter(
  (entry) => entry.name.endsWith('.webp') && ROOM_KEY.test(entry.name.slice(0, -5))
);
const drawn = new Set(
  pictures
    .map((entry) => entry.name.slice(0, -5))
    .filter((key) => typeof described[key] === 'string' && ROOM_KEY.test(described[key]))
);

/** Per realm family, as the run drew them: a realm the run did not draw has no table. */
const byRoom = {};
/** The drawings some room shows: only these ship. */
const keys = new Set();
let rooms = 0;
let unshipped = 0;
for (const [realm, table] of Object.entries(index.byRoom)) {
  byRoom[realm] = {};
  for (const [room, entry] of Object.entries(table)) {
    const row = typeof entry === 'string' ? shippedRow(entry) : null;
    if (row === null || !drawn.has(row.key)) {
      unshipped++;
      continue;
    }
    byRoom[realm][room] = entry;
    keys.add(row.key);
    rooms++;
  }
}

const out = path.join(root, 'src/renderer/public/room-art');
mkdirSync(out, { recursive: true });
let written = 0;
for (const entry of pictures) {
  if (!keys.has(entry.name.slice(0, -5))) continue;
  const target = path.join(out, entry.name);
  if (existsSync(target) && statSync(target).size === entry.size) continue;
  writeFileSync(target, archive.read(entry));
  written++;
}
// The set is swapped whole: a picture from an earlier run is shown by no room.
let removed = 0;
for (const name of readdirSync(out)) {
  const key = name.slice(0, -5);
  if (name.endsWith('.webp') && ROOM_KEY.test(key) && !keys.has(key)) {
    rmSync(path.join(out, name));
    removed++;
  }
}

const shippedDescribed = Object.fromEntries([...keys].sort().map((key) => [key, described[key]]));
const shipped = { format: ROOM_INDEX_FORMAT, described: shippedDescribed, byRoom };
mkdirSync(path.join(root, 'resources/art'), { recursive: true });
writeFileSync(path.join(root, 'resources/art/room-index.json'), JSON.stringify(shipped));
console.log(
  `build:room-art: ${written} written, ${keys.size - written} up to date, ${removed} removed, ` +
    `${rooms} rooms indexed over ${Object.keys(byRoom).join(', ')}, ${unshipped} index rows with no picture`
);
