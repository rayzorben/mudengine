/**
 * Builds the world knowledge base.
 *
 *   npm run build:world -- [path/to/realm.mdb | path/to/gmud.sqlite]
 *
 * Reads a realm database and emits one normalised, gzipped JSON-lines file that
 * the app loads at runtime. Two decisions worth knowing about:
 *
 * - **Normalisation happens here, not at runtime.** docs/legacy-assessment.md
 *   §5 consequence 4: one knowledge base, addressed as `map/room`, loaded once
 *   into an indexed graph rather than queried per line. The CoffeeScript engine
 *   issued synchronous SQLite queries from inside block parsing, per line, on
 *   the main thread — this exists so that is not possible.
 * - **Either shape of realm file.** `.mdb` is what the game's own tooling
 *   produces and what every derivative distributes; `.sqlite` is an extraction
 *   of one. `RealmSource` hides the difference and needs nothing installed for
 *   the `.mdb` case, which the `.sqlite` case does (`sqlite3`).
 *
 * The conversion itself lives in `src/main/world/buildRealm.ts`, shared with
 * the runtime path that converts a realm a player has chosen — so a
 * client-converted realm and a shipped one cannot disagree about what a room
 * is.
 *
 * Re-run this only when the realm data changes; the output is committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { openRealm } from '../src/main/world/RealmSource.ts';
import { buildRealm } from '../src/main/world/buildRealm.ts';

/*
 * The realm the client ships: Paradigm's own database, in this checkout.
 *
 * **A path inside the repository, not an absolute one.** This used to name a
 * file under `/home/rayben/…/mudengine-private/`, which meant the one command
 * that regenerates the world the client ships could only be run on one machine
 * — and on any other it printed "No realm database" and exited 1. A build step
 * nobody else can run is a build step whose output nobody else can check.
 *
 * The `.mdb` rather than the `.sqlite` beside it: the SQLite reader shells out
 * to the `sqlite3` CLI, deliberately (see `RealmSource`), and that is not
 * installed everywhere this has to run — while `mdb-reader` is pure JavaScript
 * and needs nothing. The two produce the same rooms; sixteen room names differ,
 * because Access pads fixed-width text with NULs and the `.mdb` reader strips
 * it. That is the correct spelling — see CLAUDE.md, where those sixteen rooms
 * were unfindable by name until both ends trimmed.
 */
const DEFAULT_SOURCE = path.resolve('mdb/default-pmud.mdb');
const source = process.argv[2] ?? DEFAULT_SOURCE;
const outDir = path.resolve('resources/world');
const outFile = path.join(outDir, 'rooms.jsonl.gz');

if (!fs.existsSync(source)) {
  console.error(`No realm database at ${source}`);
  process.exit(1);
}

console.log(`reading ${source}`);
const realm = openRealm(source);
const built = buildRealm(realm, new Date().toISOString().slice(0, 10));
realm.close();

console.log(`  ${built.stats.rooms.toLocaleString()} rooms`);
console.log(
  `  ${built.stats.items} items named — what an exit demands and what a shop stocks, ` +
    `${built.header.items.filter((item) => item.shops || item.mobs).length} with a known source`
);
console.log(
  `  ${built.stats.shops} shops with stock, ` +
    `${built.header.shops.reduce((total, shop) => total + shop.items.length, 0)} lines between them`
);
console.log(`  ${built.stats.spells} spells`);
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
const body = [JSON.stringify(built.header), ...built.lines].join('\n') + '\n';
fs.writeFileSync(outFile, zlib.gzipSync(body, { level: 9 }));

const size = fs.statSync(outFile).size;
console.log(`  ${built.stats.withExits.toLocaleString()} rooms with exits`);
console.log(`  ${built.stats.withInstructions.toLocaleString()} exits carrying an instruction`);
console.log(
  `  ${built.stats.scripted.toLocaleString()} rooms that answer a typed word — see roomScript.ts`
);
console.log(
  `wrote ${path.relative(process.cwd(), outFile)} (${(size / 1024 / 1024).toFixed(2)} MB)`
);
