/**
 * Converts MegaMUD's recorded loop paths into this client's loops.
 *
 * MegaMUD stores a loop as a binary-ish list of steps — an opaque room code, a
 * flag word and a direction per line — because it has no pathfinder to
 * re-derive them. We do, so a loop here is a list of *places*
 * (`src/shared/loops.ts`). Bringing its loops across therefore means:
 *
 *   1. resolve the loop's starting room (the name carries `-<map> <room>`),
 *   2. replay its recorded directions through the shipped realm to recover the
 *      loop it actually walks,
 *   3. reduce that loop to the fewest waypoints whose A* routes reproduce
 *      it exactly — a corridor of twelve rooms is one waypoint, a fork is two,
 *   4. write them as YAML somebody can read and edit.
 *
 * A loop whose start cannot be resolved, or whose steps do not fit the realm
 * data, is **dropped and counted** rather than guessed at: a loop that walks
 * somewhere the character did not mean is worse than no loop.
 *
 *   npm run build:loops [-- <mega-paramud/Default> <out.yaml>]
 */
import fs from 'node:fs';
import path from 'node:path';

import { WorldGraph } from '../src/main/world/WorldGraph.ts';
import { RealmLibrary } from '../src/main/world/RealmLibrary.ts';

const source = process.argv[2] ?? path.resolve('mega-paramud/Default');
const out = process.argv[3] ?? path.resolve('resources/loops/megamud.yaml');
/*
 * The realm those paths were recorded against — not necessarily the one this
 * client ships. `mega-paramud` is Paradigm's, and replaying its paths through
 * stock GreaterMUD fits 7 loops out of 488: the room numbers are a different
 * realm's. Pass the database the paths belong to.
 */
const realm = process.argv[4] ?? '';

const world = realm
  ? new RealmLibrary({
      shippedFile: path.resolve('resources/world/rooms.jsonl.gz'),
      cacheDir: path.join(path.dirname(path.resolve('resources/config/user.yaml')), 'realms'),
      notify: (message) => console.log(`  ${message}`)
    }).load(realm).graph
  : WorldGraph.load(path.resolve('resources/world/rooms.jsonl.gz'));
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'u', 'd']);
/** MegaMUD records long forms too; the realm data is canonical short. */
const LONG = {
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  up: 'u', down: 'd'
};

/**
 * `Ancient Crypt-1 1943` → the room at 1/1943.
 *
 * The coordinates were typed by hand into 488 file names, so every spelling
 * in the corpus is accepted: `-1 1943`, `- 2 10134` (a space after the dash),
 * and `(17/25)` in parentheses.
 */
function startRoom(name) {
  const suffix =
    /-\s*(\d{1,3})\s+(\d{1,6})\s*$/.exec(name) ?? /\((\d{1,3})\/(\d{1,6})\)\s*$/.exec(name);
  if (suffix) {
    const room = world.byId(`${suffix[1]}/${suffix[2]}`);
    if (room) return room;
  }
  const found = world.findByName(name);
  return found.length === 1 ? found[0] : null;
}

/** Every room the recorded directions walk through, or null where they do not fit. */
function replay(from, steps) {
  const rooms = [from];
  let here = from;
  for (const step of steps) {
    // `w[use dragon key w]` — the bracket is MegaMUD's extra commands for the
    // same move, which the route planner and walker handle themselves — and
    // `e -- comment` is an annotation. Both are shed before reading the move.
    let command = step
      .replace(/\[.*\]\s*$/, '')
      .replace(/\s+--.*$/, '')
      .trim()
      .toLowerCase();
    command = LONG[command] ?? command;
    const exit = DIRECTIONS.has(command)
      ? here.exits.find((entry) => entry.direction === command)
      : here.exits.find((entry) => entry.requirement?.commands?.includes(command));
    if (!exit) {
      /*
       * Not every recorded step is a move: the corpus stashes loot
       * (`hide 500 gold`), checks state (`stat`, `v`), wields (`wea moon`)
       * and talks to NPCs mid-loop. A step that is not a direction and not a
       * text exit of this room is an in-place action — the character stays
       * put and the replay carries on. A *direction* that does not fit is
       * still a real mismatch and fails the loop.
       */
      if (!DIRECTIONS.has(command)) continue;
      return null;
    }
    const next = world.byId(`${exit.map}/${exit.room}`);
    if (!next) return null;
    rooms.push(next);
    here = next;
  }
  return rooms;
}

const idOf = (room) => `${room.map}/${room.room}`;

/**
 * The fewest waypoints whose routes reproduce the loop.
 *
 * Greedy: extend the current leg while the planner's own route from the last
 * waypoint to the candidate is exactly the recorded rooms; the moment it would
 * take a different way, the previous room becomes a waypoint. So a loop only
 * carries the places where the walk is a *choice*.
 */
function waypoints(rooms) {
  const stops = [rooms[0]];
  let anchor = 0;
  for (let i = 2; i < rooms.length; i += 1) {
    const route = world.route(idOf(rooms[anchor]), idOf(rooms[i]));
    const walked = route.blocked ? null : route.steps.map((step) => step.to);
    const recorded = rooms.slice(anchor + 1, i + 1).map(idOf);
    const same =
      walked !== null &&
      walked.length === recorded.length &&
      walked.every((id, at) => id === recorded[at]);
    if (!same) {
      stops.push(rooms[i - 1]);
      anchor = i - 1;
    }
  }
  const last = rooms[rooms.length - 1];
  if (stops[stops.length - 1] !== last && idOf(stops[stops.length - 1]) !== idOf(last)) {
    stops.push(last);
  }
  // A loop ends where it began; the loop runner rings round by itself.
  if (stops.length > 1 && idOf(stops[0]) === idOf(stops[stops.length - 1])) stops.pop();
  return stops;
}

const quote = (text) => `'${text.replace(/'/g, "''")}'`;

const files = fs
  .readdirSync(source)
  .filter((name) => /LOOP/i.test(name) && /\.mp$/i.test(name))
  .sort();

const loops = [];
const dropped = { start: 0, steps: 0, tiny: 0 };

for (const name of files) {
  const lines = fs.readFileSync(path.join(source, name), 'latin1').split(/\r?\n/);
  const header = /^\[(\w+):([^:]+):(.+)\]$/.exec(lines[1] ?? '');
  if (!header) {
    dropped.start += 1;
    continue;
  }
  const from = startRoom(header[3]);
  if (!from) {
    dropped.start += 1;
    continue;
  }
  /*
   * Steps begin at the first `<room>:<flags>:<command>` line. Counting header
   * lines instead does not work: a goto path names a start *and* an end room,
   * a loop names only the one it returns to, so a fixed offset silently drops
   * a loop's first step and every replay then fails on the second.
   */
  const steps = lines
    .map((line) => /^[0-9A-F]{8}:[0-9A-F]{4}:(.*)$/i.exec(line)?.[1])
    .filter((step) => step !== undefined && step.length > 0);
  const rooms = replay(from, steps);
  if (!rooms) {
    dropped.steps += 1;
    continue;
  }
  const stops = waypoints(rooms);
  if (stops.length < 2) {
    dropped.tiny += 1;
    continue;
  }
  loops.push({
    name: `${header[2]}: ${header[3]}`,
    area: header[2],
    stops,
    rooms: rooms.length,
    file: name
  });
}

/*
 * Sorted by name, and by source file where two share one -- so the numbering
 * below is the same on every run rather than whatever order the directory was
 * read in.
 */
loops.sort((a, b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0
);

/*
 * A name is a loop's address, so two loops may not share one.
 *
 * MegaMUD labels its recorded paths `<area>: <title>` and reuses a label across
 * files: eleven labels here cover twenty-five genuinely different loops.
 * MegaMUD does not care -- it runs a *file* -- but everything in this client
 * addresses a loop by name: the palette starts one by name, `loopNamed` finds
 * it by name, and a profile lists them by name. Left alone, fourteen of these
 * loops could be shipped and never run, because the lookup would always
 * find the first.
 *
 * The first keeps the bare label, so a name already written into somebody's
 * options file goes on meaning what it meant.
 */
let collisions = 0;
const seen = new Map();
for (const loop of loops) {
  const count = (seen.get(loop.name) ?? 0) + 1;
  seen.set(loop.name, count);
  if (count > 1) {
    loop.name = `${loop.name} (${count})`;
    collisions += 1;
  }
}

const body = loops
  .map((loop) => {
    const stops = loop.stops
      .map((room) => `      - ${quote(`${room.name} ${room.map}/${room.room}`)}`)
      .join('\n');
    return `  - name: ${quote(loop.name)}\n    stops:\n${stops}`;
  })
  .join('\n');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `# MegaMUD's loops, as waypoints.
#
# Generated by \`npm run build:loops\` from the recorded paths in
# mega-paramud/Default/*LOOP*.mp: each loop's directions were replayed through
# the shipped realm data and reduced to the fewest places whose routes
# reproduce the same loop. Nothing here is a recorded step -- the client
# plans each leg itself, so a corridor that changes is picked up for free.
#
# ${loops.length} loops from ${files.length} recorded paths.
# Dropped: ${dropped.start} whose starting room the realm data does not have,
# ${dropped.steps} whose steps do not fit it, ${dropped.tiny} too short to loop.
# ${collisions} share a label with an earlier one and carry a number: a name is
# how this client addresses a loop, so no two of them may be spelled the same.
#
# Copy one into \`automation.loops\` in your options file, or name it there.
loops:
${body}
`,
  'utf8'
);

console.log(
  `${loops.length} loops written to ${path.relative(process.cwd(), out)} ` +
    `(dropped ${dropped.start} start, ${dropped.steps} steps, ${dropped.tiny} short; ` +
    `${collisions} numbered to keep every name unique)`
);
const sizes = loops.map((loop) => loop.stops.length).sort((a, b) => a - b);
if (sizes.length > 0) {
  console.log(
    `  waypoints per loop: min ${sizes[0]}, median ${sizes[Math.floor(sizes.length / 2)]}, max ${sizes.at(-1)}`
  );
  console.log(`  e.g. ${loops[0].name}: ${loops[0].stops.map((r) => r.name).join(' -> ')}`);
}
