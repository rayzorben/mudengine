/**
 * Reading a MegaMUD path file (`*.mp`) against a realm, and turning it into the
 * picks the loop builder draws.
 *
 * The file format is in `docs/mega-paramud.md`. This is the one reader: the
 * build script that ships the 420 loops (`scripts/build-loops.mjs`) and the
 * builder's *Import MegaMUD path* both call it, so a path imported by hand and
 * the same path off the shipped shelf cannot come out as two different loops.
 *
 * A path whose start cannot be resolved, or whose directions do not fit the
 * realm, is **refused with its reason** rather than guessed at: a loop that
 * walks somewhere the character did not mean is worse than no loop.
 */
import { movementEffect } from '../../shared/commands';
import type { MegamudPath } from '../../shared/loops';
import { roomId, type RoomId, type WorldRoom } from '../../shared/world';
import type { Traveller, WorldGraph } from './WorldGraph';
import { reduceWaypoints } from './loopDraft';

const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'u', 'd']);
/** MegaMUD records long forms too; the realm data is canonical short. */
const LONG: Readonly<Record<string, string>> = {
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
  up: 'u',
  down: 'd'
};

/** `Ancient Crypt-1 1943` → the room at 1/1943, or null. See `docs/mega-paramud.md`. */
export function startRoom(world: WorldGraph, name: string): WorldRoom | null {
  const suffix =
    /-\s*(\d{1,3})\s+(\d{1,6})\s*$/.exec(name) ?? /\((\d{1,3})\/(\d{1,6})\)\s*$/.exec(name);
  if (suffix) {
    const room = world.byId(`${suffix[1]}/${suffix[2]}`);
    if (room) return room;
  }
  const found = world.findByName(name);
  return found.length === 1 ? (found[0] ?? null) : null;
}

/**
 * A hand-typed name split from the `map room` at its end: `{ name, id }`, or
 * the whole text and a null id. A trailing pair of numbers is coordinates only
 * when the realm has a room there; otherwise it is part of the name
 * (`Undermountain Level 11`).
 */
export function coordinateTail(
  world: WorldGraph,
  text: string
): { name: string; id: RoomId | null } {
  const pair = /[\s\-+(/]*(\d{1,3})[\s/]+(\d{1,6})\)?\s*$/.exec(text);
  if (pair && world.byId(`${pair[1]}/${pair[2]}`)) {
    return { name: text.slice(0, pair.index).trim(), id: `${pair[1]}/${pair[2]}` };
  }
  return { name: text.trim(), id: null };
}

/**
 * A path file's step lines, `<checksum>:<flags>:<command>`; the checksum is
 * MegaMUD's code for the room the step is taken in. Steps begin at the first
 * such line: a goto path names a start and an end room, a loop only the one it
 * returns to, so a fixed header offset would drop a loop's first step.
 */
export function stepLines(lines: readonly string[]): Array<{ checksum: string; command: string }> {
  const steps: Array<{ checksum: string; command: string }> = [];
  for (const line of lines) {
    const match = /^([0-9A-F]{8}):[0-9A-F]{4}:(.*)$/i.exec(line);
    if (match !== null && (match[2] ?? '').length > 0) {
      steps.push({ checksum: (match[1] ?? '').toUpperCase(), command: match[2] ?? '' });
    }
  }
  return steps;
}

export interface Replayed {
  /** Every room the commands walk through, the start first. */
  rooms: WorldRoom[];
  /** The room each command was given in, one per command. */
  stood: WorldRoom[];
  /** Steps that are neither a game command nor anything the room offers, by index. */
  unread: number[];
}

/** The recorded commands walked through the realm, or null where they do not fit it. */
export function replay(
  world: WorldGraph,
  from: WorldRoom,
  commands: readonly string[]
): Replayed | null {
  const rooms = [from];
  const stood: WorldRoom[] = [];
  const unread: number[] = [];
  let here = from;
  for (const [at, step] of commands.entries()) {
    stood.push(here);
    // `w[use dragon key w]` carries MegaMUD's extra commands for the same move,
    // `e -- comment` is an annotation, and `@party ` sends it for the whole
    // party. All three are shed before the move is read.
    let command = step
      .replace(/^@party\s+/i, '')
      .replace(/\[.*\]\s*$/, '')
      .replace(/\s+--.*$/, '')
      .trim()
      .toLowerCase();
    command = LONG[command] ?? command;
    const exit = DIRECTIONS.has(command)
      ? here.exits.find((entry) => entry.direction === command)
      : here.exits.find((entry) => entry.requirement?.commands?.includes(command));
    // A portal is a room command with a destination (`enter portal`), not an exit.
    const portal = exit
      ? undefined
      : here.commands?.find((entry) => entry.to && entry.say.includes(command));
    if (portal?.to) {
      const next = world.byId(portal.to);
      if (!next) return null;
      rooms.push(next);
      here = next;
      continue;
    }
    if (!exit) {
      // Stashing, `stat`, wielding and talking happen mid-loop: an in-place
      // action leaves the character where it is. A direction that does not
      // fit is a real mismatch and fails the path.
      if (DIRECTIONS.has(command)) return null;
      if (movementEffect(command) !== 'stays') unread.push(at);
      continue;
    }
    const next = world.byId(`${exit.map}/${exit.room}`);
    if (!next) return null;
    rooms.push(next);
    here = next;
  }
  return { rooms, stood, unread };
}

/**
 * What a person calls this path, off the file's own first line
 * (`[Burning Plains (NW)-17 9507][Winterhawk]`): the title, without the
 * coordinates where the realm has a room there. Empty when the line has none.
 */
export function friendlyTitle(
  world: WorldGraph,
  line: string | undefined,
  room: WorldRoom
): string {
  const title = (/^\[([^\]]*)\]/.exec(line ?? '')?.[1] ?? '').trim();
  if (title.length === 0) return '';
  const tail = coordinateTail(world, title);
  if (tail.id !== null) return tail.name;
  // Half a suffix: `Siren Trees-5`. A dash or plus is required, so
  // `Eladrin Level 1` keeps its level.
  const one = /\s*[-+]\s*(\d{1,6})\s*$/.exec(title);
  if (one && (Number(one[1]) === room.room || Number(one[1]) === room.map)) {
    return title.slice(0, one.index).trim();
  }
  return title;
}

/**
 * One path file's text, read against `world`.
 *
 * `loop` says the path is a ring whatever its last room is (a file named
 * `*LOOP*`); otherwise it is a ring only if it ends where it began.
 */
export function readMegamudPath(
  world: WorldGraph,
  file: string,
  text: string,
  traveller: Traveller = {}
): MegamudPath {
  const lines = text.split(/\r?\n/);
  const header = /^\[(\w+):([^:]+):(.+)\]$/.exec(lines[1] ?? '');
  if (!header) return { ok: false, file, reason: 'header' };
  const from = startRoom(world, header[3] ?? '');
  if (!from) return { ok: false, file, reason: 'start' };
  const walked = replay(
    world,
    from,
    stepLines(lines).map((step) => step.command)
  );
  if (!walked) return { ok: false, file, reason: 'steps' };
  const path = walked.rooms.map((room) => roomId(room.map, room.room));
  const first = path[0];
  const last = path[path.length - 1];
  const ring = /LOOP/i.test(file) || first === last;
  const stops = reduceWaypoints(world, path, traveller);
  // A ring ends where it began; the builder draws that as a closing pick.
  if (ring && stops.length > 1 && stops[0] === stops[stops.length - 1]) stops.pop();
  if (stops.length < 2) return { ok: false, file, reason: 'tiny' };
  const area = (header[2] ?? '').trim();
  const title = friendlyTitle(world, lines[0], from);
  const name = `${area}: ${title.length > 0 ? title : (header[3] ?? '')}`;
  const picks = ring ? [...stops, stops[0] as RoomId] : stops;
  return { ok: true, file, name, picks, closed: ring, unread: walked.unread.length };
}
