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

import { worldLeg } from '../src/main/session/navigation.ts';
import {
  coordinateTail,
  idOf,
  recordedRealm,
  replay,
  startRoom,
  stepLines
} from './lib/megamud-paths.mjs';

const source = process.argv[2] ?? path.resolve('mega-paramud/Default');
const out = process.argv[3] ?? path.resolve('resources/loops/megamud.yaml');
// The database the paths belong to, where it is not the shipped Paradigm (`recordedRealm`).
const world = recordedRealm(process.argv[4] ?? '');

/**
 * What a person calls this loop, off the file's own first line.
 *
 * `[Burning Plains (NW)-17 9507][Winterhawk]` — a title and whoever recorded
 * it. The title is the name a player typed, and it is the half that says which
 * loop this *is*: the second line's third field is only the room the loop
 * starts from, and four of these files start at Narrow Ledge, so naming them
 * after it produced `Barren Hills: Narrow Ledge-15 640` four times over and a
 * numbered suffix to tell them apart. Their own titles are East Half, West
 * Half, Middle and Full Loop — which is what somebody looking for one of them
 * would type.
 *
 * The coordinates are shed where the realm has a room there (`coordinateTail`),
 * which keeps the fourteen whose title names a different room from the one the
 * second line starts at.
 */
function friendlyTitle(line, room) {
  const title = (/^\[([^\]]*)\]/.exec(line ?? '')?.[1] ?? '').trim();
  if (title.length === 0) return '';

  const tail = coordinateTail(world, title);
  if (tail.id !== null) return tail.name;
  // Half a suffix: `Siren Trees-5`, `Bone-strewn Hillside (Vultures)- 9993`. A
  // dash or a plus is required, so `Eladrin Level 1` keeps its level.
  const one = /\s*[-+]\s*(\d{1,6})\s*$/.exec(title);
  if (one && (Number(one[1]) === room.room || Number(one[1]) === room.map)) {
    return title.slice(0, one.index).trim();
  }
  return title;
}

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
    const route = worldLeg(world, idOf(rooms[anchor]), idOf(rooms[i]));
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
  const from = startRoom(world, header[3]);
  if (!from) {
    dropped.start += 1;
    continue;
  }
  const walked = replay(world, from, stepLines(lines).map((step) => step.command));
  if (!walked) {
    dropped.steps += 1;
    continue;
  }
  const { rooms } = walked;
  const stops = waypoints(rooms);
  if (stops.length < 2) {
    dropped.tiny += 1;
    continue;
  }
  /*
   * The player's own title, and the start room only where a file states none.
   * A loop with no name at all is worse than one named after where it begins.
   */
  const title = friendlyTitle(lines[0], from);
  loops.push({
    name: `${header[2]}: ${title.length > 0 ? title : header[3]}`,
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
    // MegaMUD's own file name, which its `@path` answers with and `@loop` reads back.
    return `  - name: ${quote(loop.name)}\n    pathFile: ${quote(loop.file)}\n    stops:\n${stops}`;
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
# Each is named the way whoever recorded it named it -- the title on the path
# file's own first line -- under the area MegaMUD filed it in. The room the
# loop starts from is its first stop, not its name: four paths that all begin
# at Narrow Ledge are East Half, West Half, Middle and Full Loop.
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
