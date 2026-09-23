/**
 * Builds the world knowledge base: the two worlds the client ships.
 *
 *   npm run build:world                      both worlds, from the archives below
 *   npm run build:world -- paradigm          one of them
 *   npm run build:world -- majormud path.zip one of them, from another file
 *
 * Reads a realm database and emits one normalised, gzipped JSON-lines file per
 * world that the app loads at runtime. Two decisions worth knowing about:
 *
 * - **Normalisation happens here, not at runtime.** docs/legacy-assessment.md
 *   §5 consequence 4: one knowledge base per world, addressed as `map/room`,
 *   loaded once into an indexed graph rather than queried per line. The
 *   CoffeeScript engine issued synchronous SQLite queries from inside block
 *   parsing, per line, on the main thread — this exists so that is not possible.
 * - **Two worlds, because there are two versions of this game's data.** Stock
 *   MajorMUD v1.11p and Paradigm's, which grew out of it. A realm says which it
 *   runs at its own menu (`[MAJORMUD]:`, `[PARADIGM]:`) and the client walks
 *   that one (`shared/worlds.ts`); one file per world rather than one file
 *   flagging every row, because the two are loaded by different sessions and
 *   never at once, and every index would otherwise carry the flag.
 *
 * The header names the world and the archive it was built from — name, size,
 * SHA-1 — so a database a player names can be recognised as the same bytes and
 * loaded as the bundled world rather than converted again (`RealmLibrary`).
 *
 * The conversion itself lives in `src/main/world/buildRealm.ts`, shared with
 * the runtime path that converts a realm a player has chosen — so a
 * client-converted realm and a shipped one cannot disagree about what a room
 * is. Either shape of realm file, zipped or loose (`RealmSource`).
 *
 * Re-run this only when the realm data changes; the output is committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { openRealm } from '../src/main/world/RealmSource.ts';
import { buildRealm, identityOfArchive } from '../src/main/world/buildRealm.ts';
import { asShippedWorld, SHIPPED_WORLDS, shippedWorldFile } from '../src/shared/worlds.ts';

/*
 * The archives each world is built from — paths inside the repository, so the
 * one command that regenerates what the client ships can be run on any clone.
 * Zipped: 22 MB of Access file is 2.7 MB of archive, and `RealmSource` reads
 * the one inside without unpacking it.
 */
const ARCHIVES = {
  majormud: path.resolve('mdb/majormud-v1.11p.zip'),
  paradigm: path.resolve('mdb/pmud.zip')
};
const outDir = path.resolve('resources/world');

const only = process.argv[2] === undefined ? null : asShippedWorld(process.argv[2]);
if (process.argv[2] !== undefined && only === null) {
  console.error(`No such world: ${process.argv[2]}. One of: ${SHIPPED_WORLDS.join(', ')}.`);
  process.exit(1);
}
const jobs = (only === null ? SHIPPED_WORLDS : [only]).map((world) => ({
  world,
  source:
    only !== null && process.argv[3] !== undefined ? path.resolve(process.argv[3]) : ARCHIVES[world]
}));

for (const { world, source } of jobs) {
  if (!fs.existsSync(source)) {
    console.error(`No realm database at ${source}`);
    process.exit(1);
  }

  console.log(`${world}: reading ${path.relative(process.cwd(), source)}`);
  const realm = openRealm(source);
  const built = buildRealm(realm, new Date().toISOString().slice(0, 10), {
    world,
    archive: identityOfArchive(source)
  });
  realm.close();

  // What a room is furnished with (format 42) is a source like a shop's stock,
  // stated on the rooms rather than on the items.
  const furnished = new Set();
  let furnishedRooms = 0;
  for (const line of built.lines) {
    const placed = JSON.parse(line).pl ?? [];
    if (placed.length > 0) furnishedRooms += 1;
    for (const id of placed) furnished.add(id);
  }
  console.log(`  ${built.stats.rooms.toLocaleString()} rooms`);
  console.log(
    `  ${built.stats.items} items named — what an exit demands, what a shop stocks, what a ` +
      `script hands over and what a room holds, ` +
      `${built.header.items.filter((item) => item.shops || item.mobs || item.from || furnished.has(item.id)).length} ` +
      `with a known source`
  );
  console.log(
    `  ${furnishedRooms} rooms the realm puts ${furnished.size} items in, back every night`
  );
  console.log(
    `  ${built.stats.shops} shops with stock, ` +
      `${built.header.shops.reduce((total, shop) => total + shop.items.length, 0)} lines between them`
  );
  console.log(`  ${built.stats.spells} spells`);
  console.log(
    `  ${built.stats.quests} quests in ${built.stats.questSteps} steps, ` +
      'assembled from the realm’s own text blocks'
  );
  console.log(
    `  ${built.stats.itemNames} item names for the console to recognise, ` +
      `${built.stats.races} races, ${built.stats.classes} classes`
  );
  console.log(
    `  ${built.stats.mobs} monsters by name, ` +
      `${built.header.mobs.filter((mob) => mob.hi !== undefined).length} whose health the realm ` +
      'data is not certain of'
  );

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, shippedWorldFile(world));
  const body = [JSON.stringify(built.header), ...built.lines].join('\n') + '\n';
  fs.writeFileSync(outFile, zlib.gzipSync(body, { level: 9 }));

  const size = fs.statSync(outFile).size;
  console.log(`  ${built.stats.withExits.toLocaleString()} rooms with exits`);
  console.log(`  ${built.stats.withInstructions.toLocaleString()} exits carrying an instruction`);
  console.log(
    `  ${built.stats.scripted.toLocaleString()} rooms that answer a typed word — see roomScript.ts`
  );
  console.log(
    `  ${built.stats.levered.toLocaleString()} rooms holding a lever, opening ` +
      `${built.stats.openableHere.toLocaleString()} hidden exits where they stand — see parseAction` +
      (built.stats.ambiguousLevers > 0
        ? `\n  ${built.stats.ambiguousLevers.toLocaleString()} levers dropped: several of the room's own commands answer to the phrase`
        : '')
  );
  console.log(
    `  family ${built.header.family ?? 'unstated'}, ${built.header.build?.custom ?? '?'} ` +
      `${built.header.build?.data ?? ''}`.trim()
  );
  console.log(
    `wrote ${path.relative(process.cwd(), outFile)} (${(size / 1024 / 1024).toFixed(2)} MB)`
  );
}
