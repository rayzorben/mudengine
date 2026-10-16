/**
 * Reading MegaMUD's recorded paths (`mega-paramud/Default/*.mp`) against a
 * realm, shared by `build-loops.mjs` and `build-rooms.mjs`. The file format is
 * in `docs/mega-paramud.md`.
 */
import path from 'node:path';

import { WorldGraph } from '../../src/main/world/WorldGraph.ts';
import { RealmLibrary } from '../../src/main/world/RealmLibrary.ts';

const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'u', 'd']);
/** MegaMUD records long forms too; the realm data is canonical short. */
const LONG = {
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  up: 'u', down: 'd'
};

export const idOf = (room) => `${room.map}/${room.room}`;

/**
 * The realm the paths were recorded against: `mega-paramud` is Paradigm's,
 * the shipped world, unless a database is named. Replaying them through stock
 * GreaterMUD fits 7 loops of 488, since the room numbers are another realm's.
 */
export function recordedRealm(database) {
  return database
    ? new RealmLibrary({
        shippedDir: path.resolve('resources/world'),
        cacheDir: path.join(path.dirname(path.resolve('resources/config/user.yaml')), 'realms'),
        notify: (message) => console.log(`  ${message}`)
      }).load(database).graph
    : WorldGraph.load(path.resolve('resources/world/paradigm.jsonl.gz'));
}

/**
 * `Ancient Crypt-1 1943` → the room at 1/1943.
 *
 * The coordinates were typed by hand into 488 file names, so every spelling
 * in the corpus is accepted: `-1 1943`, `- 2 10134` (a space after the dash),
 * and `(17/25)` in parentheses.
 */
export function startRoom(world, name) {
  const suffix =
    /-\s*(\d{1,3})\s+(\d{1,6})\s*$/.exec(name) ?? /\((\d{1,3})\/(\d{1,6})\)\s*$/.exec(name);
  if (suffix) {
    const room = world.byId(`${suffix[1]}/${suffix[2]}`);
    if (room) return room;
  }
  const found = world.findByName(name);
  return found.length === 1 ? found[0] : null;
}

/**
 * A hand-typed name split from the `map room` at its end: `{ name, id }`, or
 * the whole text and a null id.
 *
 * The tail is spelled every way a person spells it (`-17 9507`, `  14 5489`,
 * `+6 924`, `(17/25)`, `Section7 519`), so a pattern loose enough to catch them
 * all is loose enough to take the `11` off `Undermountain Level 11`. A
 * trailing pair of numbers is therefore coordinates only when **the realm has
 * a room there**; otherwise it is part of the name.
 */
export function coordinateTail(world, text) {
  const pair = /[\s\-+(/]*(\d{1,3})[\s/]+(\d{1,6})\)?\s*$/.exec(text);
  if (pair && world.byId(`${pair[1]}/${pair[2]}`)) {
    return { name: text.slice(0, pair.index).trim(), id: `${pair[1]}/${pair[2]}` };
  }
  return { name: text.trim(), id: null };
}

/**
 * A path file's step lines, `<checksum>:<flags>:<command>`, as
 * `{ checksum, command }`; the checksum is MegaMUD's code for the room the
 * step is taken in.
 *
 * Steps begin at the first such line. Counting header lines instead does not
 * work: a goto path names a start *and* an end room, a loop names only the one
 * it returns to, so a fixed offset silently drops a loop's first step.
 */
export function stepLines(lines) {
  return lines
    .map((line) => /^([0-9A-F]{8}):[0-9A-F]{4}:(.*)$/i.exec(line))
    .filter((match) => match !== null && match[2].length > 0)
    .map((match) => ({ checksum: match[1].toUpperCase(), command: match[2] }));
}

/**
 * Every room the recorded commands walk through (`rooms`, the start first),
 * and the room each command was given in (`stood`, one per command), or null
 * where they do not fit the realm.
 */
export function replay(world, from, commands) {
  const rooms = [from];
  const stood = [];
  let here = from;
  for (const step of commands) {
    stood.push(here);
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
  return { rooms, stood };
}
