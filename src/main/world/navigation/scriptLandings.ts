/**
 * Where a command's run puts the character, and how often (format 73): its
 * steps followed through roll tables, shown blocks, a spell's own landing or
 * draw, the spell's scripts and its `EndCast` chain, each landing with the
 * share of tries that reach it, the gates on the way, and what the run takes.
 * `dig grave` is `random 9121`, whose 7% line casts *musty teleport*; the
 * wharf's passage casts *board ship* and then three timed spells that end on
 * the beach. `mudengine-world` › *There is one navigation engine*.
 */
import { HAZARD_ABILITY } from '../../../shared/abilities';
import {
  asRoomReference,
  landingRooms,
  roomId,
  scatters,
  type CommandLanding,
  type CommandWait,
  type Landing,
  type RoomCommand,
  type RoomId
} from '../../../shared/world';
import { SCRIPT_DEPTH, scriptsOf, type Blocks, type SpellScriptRow } from './scriptWays';
import { spellLanding, teleportRoomOf } from './spellLanding';
import { blockRun, linesRun, roleOf, rollOf, stepsRun, untilUnrun, type TbStep } from './textblock';
import { gatesOf, nameGate, type GateNames } from './stepGates';

/** A spell as a run reads it: its abilities, `MinBase..MaxBase` and its duration in ticks. */
export interface LandingSpell extends SpellScriptRow {
  duration?: number;
  name?: string;
}

/** What a run reads of the realm, and the room it starts in: null for a monster's answer, asked wherever it stands. */
export interface LandingRealm {
  here: RoomId | null;
  blocks: Blocks;
  spell(id: number): LandingSpell | undefined;
}

/** One way a run can end: where it put the character, and how. */
export interface RunEnd {
  /** The rooms it may have put the character in, one of them at random; empty where it moved nobody. */
  rooms: RoomId[];
  /** The share of tries that end this way. */
  chance: number;
  /** The gate steps run inside the blocks the run reached, beyond the command's own. */
  inner: TbStep[];
  /** Items the run takes. */
  takes: number[];
  /** A ship's passage: the rooms the character waits in, and the ticks until it lands. */
  waits?: CommandWait;
  /** A `teleport` step of the command's own line put it there, which a later cast's landing does not undo. */
  stated?: true;
  /** The rooms are a spell's own roll, `MinBase..MaxBase`: a draw, planned to and never through. */
  drawn?: Landing;
}

/** Where tries end up once identical ways are one: a roll table of loot is one way that stays. */
const MAX_ENDS = 256;

/** Every way a run of `steps` can end, the shares summing to one. */
export function runEnds(steps: readonly TbStep[], realm: LandingRealm): RunEnd[] {
  const start: RunEnd = { rooms: [], chance: 1, inner: [], takes: [] };
  return merged(walk(untilUnrun(steps), [start], realm, 0, new Set()));
}

function walk(
  steps: readonly TbStep[],
  ends: RunEnd[],
  realm: LandingRealm,
  depth: number,
  seen: ReadonlySet<number>
): RunEnd[] {
  let now = ends;
  for (const step of steps) {
    now = merged(now.flatMap((end) => stepOn(step, end, realm, depth, seen)));
  }
  return now;
}

function stepOn(
  step: TbStep,
  end: RunEnd,
  realm: LandingRealm,
  depth: number,
  seen: ReadonlySet<number>
): RunEnd[] {
  const role = roleOf(step);
  // The command's own gates are the command's; a block's are the landing's.
  const inner =
    depth > 0 && (role === 'gate' || role === 'pays') ? [...end.inner, step] : end.inner;
  const here: RunEnd = { ...end, inner };
  switch (step.verb) {
    case 'teleport': {
      const { drawn: _drawn, ...moved } = here;
      return [
        { ...moved, rooms: [roomId(step.map, step.room)], ...(depth === 0 ? { stated: true } : {}) }
      ];
    }
    case 'takeitem':
      return [{ ...here, takes: [...here.takes, step.item] }];
    case 'cast':
      return castOn(step.spell, here, realm, depth, seen);
    case 'random':
      return rollOn(step.block, here, realm, depth, seen);
    default: {
      // A shown block runs what it links to. A failed roll's or spell check's
      // `otherwise` leaves the character wherever it puts them, and the walk
      // plans again from there.
      const next = blockRun(step);
      if (next === null || next[1] !== 'shown') return [here];
      const linked = realm.blocks.get(next[0])?.linkTo ?? null;
      return linked === null || linked <= 0 ? [here] : blockOn(linked, here, realm, depth, seen);
    }
  }
}

/** A roll of 1–100 against the table: the first line whose threshold reaches it runs (`ExecuteRandom`). */
function rollOn(
  id: number,
  end: RunEnd,
  realm: LandingRealm,
  depth: number,
  seen: ReadonlySet<number>
): RunEnd[] {
  const block = realm.blocks.get(id);
  if (block === undefined || depth >= SCRIPT_DEPTH || seen.has(id)) return [end];
  const inside = new Set(seen).add(id);
  const out: RunEnd[] = [];
  let below = 0;
  for (const line of linesRun(block, 'roll')) {
    const threshold = Math.min(rollOf(line) ?? 0, 100);
    const share = (threshold - below) / 100;
    below = Math.max(below, threshold);
    if (share <= 0) continue;
    const steps = untilUnrun(stepsRun(line, 'roll'));
    out.push(...walk(steps, [{ ...end, chance: end.chance * share }], realm, depth + 1, inside));
  }
  // A roll above every threshold runs nothing.
  if (below < 100) out.push({ ...end, chance: (end.chance * (100 - below)) / 100 });
  return out;
}

/**
 * A block run as steps: its lines are alternatives, the first that succeeds
 * winning, so a line with no condition is the last one that can run.
 */
function blockOn(
  id: number,
  end: RunEnd,
  realm: LandingRealm,
  depth: number,
  seen: ReadonlySet<number>
): RunEnd[] {
  const block = realm.blocks.get(id);
  if (block === undefined || depth >= SCRIPT_DEPTH || seen.has(id)) return [end];
  const inside = new Set(seen).add(id);
  const out: RunEnd[] = [];
  for (const line of linesRun(block, 'steps')) {
    const steps = untilUnrun(stepsRun(line, 'steps'));
    out.push(...walk(steps, [end], realm, depth + 1, inside));
    if (gatesOf(steps).length === 0) return out;
  }
  // Every line has a condition: one that fails them all runs nothing.
  return out.length === 0 ? [end] : [...out, end];
}

/**
 * A spell cast on the character: its own landing or draw, its scripts, then
 * its `EndCast` chain, whose ticks the character waits through where a
 * later spell of it lands them (the Swiftwind's three trips).
 */
function castOn(
  id: number,
  end: RunEnd,
  realm: LandingRealm,
  depth: number,
  seen: ReadonlySet<number>
): RunEnd[] {
  let now: RunEnd[] = [end];
  let ticks = 0;
  const chain = new Set<number>();
  for (let next: number | undefined = id; next !== undefined && next > 0;) {
    const spell = realm.spell(next);
    if (spell === undefined || chain.has(next) || chain.size >= SCRIPT_DEPTH) break;
    chain.add(next);
    const lands = landingOf(next, spell, now[0] ?? end, realm.here);
    // The realm's own `teleport` on the command's line is where it says the
    // character goes (format 29): `dive pool:teleport 121 12:cast 336`.
    if (lands.rooms.length > 0 && !(depth === 0 && end.stated === true)) {
      now = now.map(({ drawn: _drawn, ...each }) => {
        const waited = ticks > 0 ? { waits: { in: roomsOrStart(each, realm), ticks } } : {};
        const drawn = lands.drawn === undefined ? {} : { drawn: lands.drawn };
        return { ...each, rooms: lands.rooms, ...waited, ...drawn };
      });
    }
    for (const rows of scriptsOf(spell)) {
      // A column naming several blocks runs one of them at random.
      now = merged(
        now.flatMap((each) =>
          rows.flatMap((row) =>
            blockOn(row, { ...each, chance: each.chance / rows.length }, realm, depth + 1, seen)
          )
        )
      );
    }
    ticks += spell.duration ?? 0;
    next = spell.abilities.find(([ability]) => ability === HAZARD_ABILITY.endCast)?.[1];
  }
  return now;
}

/**
 * The rooms a spell puts its target in (`spellLanding`), a draw where it rolls
 * them; none where it moves nobody, or where it names no map and the target's
 * is not known.
 */
function landingOf(
  id: number,
  spell: LandingSpell,
  end: RunEnd,
  here: RoomId | null
): { rooms: RoomId[]; drawn?: Landing } {
  const stated = teleportRoomOf(spell.abilities);
  if (stated === null) return { rooms: [] };
  const standing = end.rooms[0] ?? here;
  const onMap = standing === null ? 0 : (asRoomReference(standing)?.map ?? 0);
  const landing = spellLanding({ ...spell, id, name: spell.name ?? '' }, stated, onMap);
  if (landing === null || landing.map <= 0) return { rooms: [] };
  const rooms = landingRooms(landing);
  return scatters(landing) ? { rooms, drawn: landing } : { rooms };
}

/** Where the character stands while a chain runs: where the run has put it, or where it started. */
function roomsOrStart(end: RunEnd, realm: LandingRealm): RoomId[] {
  return end.rooms.length > 0 ? end.rooms : realm.here === null ? [] : [realm.here];
}

/** Ends that differ only in their share are one, their shares summed. */
function merged(ends: readonly RunEnd[]): RunEnd[] {
  const byKey = new Map<string, RunEnd>();
  for (const end of ends) {
    const key = JSON.stringify([
      end.rooms,
      end.inner.map((step) => step.said),
      end.takes,
      end.waits ?? null,
      end.drawn?.spell ?? null
    ]);
    const held = byKey.get(key);
    if (held === undefined) byKey.set(key, end);
    else byKey.set(key, { ...held, chance: held.chance + end.chance });
  }
  const out = [...byKey.values()];
  if (out.length <= MAX_ENDS) return out;
  // Past the bound the likeliest ends are kept: the rest are under a share
  // of a try that no plan would wait for.
  return out.sort((a, b) => b.chance - a.chance).slice(0, MAX_ENDS);
}

/** The share at which a landing is every try's: what a roll's rounding leaves. */
const EVERY_TRY = 0.999;

/**
 * A run's ends as a command writes them (format 73): `to` where every try
 * lands in one room with nothing more asked, else `landings`, each room of a
 * draw at its share; what the moving ends take, and what a try that moves
 * nobody can take (`breaks`).
 */
export function landingsOf(
  ends: readonly RunEnd[],
  names: GateNames
): Pick<RoomCommand, 'to' | 'landings' | 'draws' | 'takes' | 'breaks'> {
  const moving = ends.filter((end) => end.rooms.length > 0);
  const only = moving.length === 1 ? moving[0]! : null;
  const out: Pick<RoomCommand, 'to' | 'landings' | 'draws' | 'takes' | 'breaks'> = {};
  const draws = moving.filter((end) => end.drawn !== undefined && end.waits === undefined);
  if (draws.length > 0) {
    out.draws = draws.map((end) => {
      const gates = gatesOf(end.inner).map((gate) => nameGate(gate, names));
      return {
        landing: end.drawn!,
        chance: Math.min(1, roundShare(end.chance)),
        ...(gates.length > 0 ? { gates } : {})
      };
    });
  }
  const landed = moving.filter((end) => !draws.includes(end));
  if (
    only !== null &&
    only.chance >= EVERY_TRY &&
    only.rooms.length === 1 &&
    only.inner.length === 0 &&
    only.waits === undefined
  ) {
    out.to = only.rooms[0]!;
  } else if (landed.length > 0) {
    const byRoom = new Map<string, CommandLanding>();
    for (const end of landed) {
      const gates = gatesOf(end.inner).map((gate) => nameGate(gate, names));
      for (const to of end.rooms) {
        const landing: CommandLanding = {
          to,
          chance: end.chance / end.rooms.length,
          ...(end.rooms.length > 1 ? { draw: roundShare(end.chance) } : {}),
          ...(gates.length > 0 ? { gates } : {}),
          ...(end.waits === undefined ? {} : { waits: end.waits })
        };
        const key = JSON.stringify([to, landing.draw, landing.gates ?? [], landing.waits ?? null]);
        const held = byRoom.get(key);
        byRoom.set(
          key,
          held === undefined ? landing : { ...held, chance: held.chance + landing.chance }
        );
      }
    }
    out.landings = [...byRoom.values()].map((landing) => ({
      ...landing,
      chance: Math.min(1, roundShare(landing.chance))
    }));
  }
  const takes = [...new Set(moving.flatMap((end) => end.takes))];
  if (takes.length > 0) out.takes = takes;
  // Only a way can break what it wants; a hand-in that moves nobody just takes it.
  const breaks = new Map<number, number>();
  for (const end of moving.length > 0 ? ends : []) {
    if (end.rooms.length > 0) continue;
    for (const item of new Set(end.takes)) breaks.set(item, (breaks.get(item) ?? 0) + end.chance);
  }
  if (breaks.size > 0) {
    out.breaks = [...breaks].map(([item, chance]) => ({ item, chance: roundShare(chance) }));
  }
  return out;
}

/** A share to four places, so a file written twice reads the same. */
function roundShare(chance: number): number {
  return Math.max(0.0001, Math.round(chance * 10_000) / 10_000);
}
