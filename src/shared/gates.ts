/**
 * Every condition the realm puts on a way, in one vocabulary, and the one
 * judge of it. An exit's instruction (`Level:`, `Class:`, a key) and a text
 * block's step (`minlevel`, `checkitem`, `nomonsters`) are the same kind of
 * fact here. `mudengine-world` › *There is one navigation engine*.
 *
 * A fact nobody has read is `unknown`, which the router prices as unread.
 * `fail` and a need come from a fact that was read, or from what stands in a
 * room the character is not in, which only being there answers.
 */
import { alignmentRank, asAlignment, type Alignment } from './alignment';

/** What `testskill` reads (`TextBlockPart.cs:1155`); `wisdom` is willpower. */
export const TB_STATS = [
  'intellect',
  'strength',
  'health',
  'charm',
  'agility',
  'wisdom',
  'current_hp',
  'traps',
  'thievery',
  'spellcasting',
  'perception',
  'stealth',
  'picklocks',
  'tracking',
  'magicresistance'
] as const;

export type TbStat = (typeof TB_STATS)[number];

/** `testskill`'s chance in percent is clamped to this, except on `current_hp` (`TextBlockPart.cs:72`). */
const ROLL_FLOOR = 2;
const ROLL_CEILING = 98;

export type Gate =
  /** Level within the bounds. */
  | { kind: 'level'; min?: number; max?: number }
  /** Class `id` only (`is`), or every class but it. `name` is for a reader. */
  | { kind: 'class'; id: number; is: boolean; name?: string }
  | { kind: 'race'; id: number; is: boolean; name?: string }
  /** An exit's window on the alignment words (`Alignment: Saint to Seedy`). */
  | { kind: 'standing'; low: Alignment; high: Alignment }
  /** A script's bounds on evil points: `goodaligned` is at most, `evilaligned` at least. */
  | { kind: 'alignment'; atLeast?: number; atMost?: number }
  /** The item is carried. */
  | { kind: 'carry'; item: number; name?: string }
  | { kind: 'lack'; item: number; name?: string }
  /** The item lies in the room (`lying`), or does not. */
  | { kind: 'floor'; item: number; lying: boolean; name?: string }
  /** A granted ability's sum, the quest counters in every case seen; `absent` is never held. */
  | ({ kind: 'ability'; name?: string } & AbilityBounds)
  /** The spell is not on the character. */
  | { kind: 'spell-off'; spell: number; name?: string }
  | { kind: 'lives'; below: number }
  /** Wealth at least the amount, which is taken: a toll, a script's `price`. */
  | { kind: 'copper'; copper: number }
  /** The stat less the value, against 1–100. */
  | { kind: 'roll'; stat: TbStat; value: number }
  /** No monster of any kind stands in the room. */
  | { kind: 'empty-room' }
  /** Monster row `monster` stands in the room. */
  | { kind: 'monster-here'; monster: number; name?: string }
  /** Some monster stands in the room. */
  | { kind: 'occupied' };

export type GateKind = Gate['kind'];

/** A granted ability's sum against bounds; `absent` is never held at all. */
export interface AbilityBounds {
  id: number;
  atLeast?: number;
  atMost?: number;
  absent?: boolean;
}

/** Every kind, the runtime half of `GateKind`: keyed by the type, so neither can drift. */
const GATE_KINDS: Record<GateKind, true> = {
  level: true,
  class: true,
  race: true,
  standing: true,
  alignment: true,
  carry: true,
  lack: true,
  floor: true,
  ability: true,
  'spell-off': true,
  lives: true,
  copper: true,
  roll: true,
  'empty-room': true,
  'monster-here': true,
  occupied: true
};

/** A gate read off the world file, or null for a shape that is not one. */
export function asGate(value: unknown): Gate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(GATE_KINDS, kind)) return null;
  const whole = (key: string): number | undefined => {
    const figure = record[key];
    return typeof figure === 'number' && Number.isFinite(figure) ? figure : undefined;
  };
  // A figure that is present and not a number makes the gate malformed, not open.
  let malformed = false;
  const optional = (key: string): Record<string, number> => {
    if (record[key] === undefined) return {};
    const figure = whole(key);
    if (figure === undefined) malformed = true;
    return figure === undefined ? {} : { [key]: figure };
  };
  const read = readGate(kind as GateKind, record, whole, optional);
  return malformed ? null : read;
}

function readGate(
  gate: GateKind,
  record: Record<string, unknown>,
  whole: (key: string) => number | undefined,
  optional: (key: string) => Record<string, number>
): Gate | null {
  const name = typeof record['name'] === 'string' ? { name: record['name'] } : {};
  switch (gate) {
    case 'level':
      return { kind: gate, ...optional('min'), ...optional('max') };
    case 'class':
    case 'race': {
      const id = whole('id');
      const is = record['is'];
      return id === undefined || typeof is !== 'boolean' ? null : { kind: gate, id, is, ...name };
    }
    case 'standing': {
      const low = typeof record['low'] === 'string' ? asAlignment(record['low']) : null;
      const high = typeof record['high'] === 'string' ? asAlignment(record['high']) : null;
      return low === null || high === null ? null : { kind: gate, low, high };
    }
    case 'alignment':
      return { kind: gate, ...optional('atLeast'), ...optional('atMost') };
    case 'carry':
    case 'lack': {
      const item = whole('item');
      return item === undefined ? null : { kind: gate, item, ...name };
    }
    case 'floor': {
      const item = whole('item');
      const lying = record['lying'];
      return item === undefined || typeof lying !== 'boolean'
        ? null
        : { kind: gate, item, lying, ...name };
    }
    case 'ability': {
      const id = whole('id');
      if (id === undefined) return null;
      const absent = record['absent'];
      if (absent !== undefined && typeof absent !== 'boolean') return null;
      return {
        kind: gate,
        id,
        ...optional('atLeast'),
        ...optional('atMost'),
        ...(absent === true ? { absent } : {}),
        ...name
      };
    }
    case 'spell-off': {
      const spell = whole('spell');
      return spell === undefined ? null : { kind: gate, spell, ...name };
    }
    case 'lives': {
      const below = whole('below');
      return below === undefined ? null : { kind: gate, below };
    }
    case 'copper': {
      const copper = whole('copper');
      return copper === undefined ? null : { kind: gate, copper };
    }
    case 'roll': {
      const stat = record['stat'];
      const figure = whole('value');
      return typeof stat !== 'string' ||
        !(TB_STATS as readonly string[]).includes(stat) ||
        figure === undefined
        ? null
        : { kind: gate, stat: stat as TbStat, value: figure };
    }
    case 'empty-room':
    case 'occupied':
      return { kind: gate };
    case 'monster-here': {
      const monster = whole('monster');
      return monster === undefined ? null : { kind: gate, monster, ...name };
    }
    default: {
      const never: never = gate;
      return never;
    }
  }
}

/** A list of gates read off the world file, or null where any is malformed. */
export function asGates(value: unknown): Gate[] | null {
  if (!Array.isArray(value)) return null;
  const gates = value.map(asGate);
  return gates.every((gate): gate is Gate => gate !== null) ? gates : null;
}

/** What would let a gate pass. */
export type Need =
  | { kind: 'item'; item: number }
  | { kind: 'drop'; item: number }
  | { kind: 'floor'; item: number; lying: boolean }
  | { kind: 'level'; min: number }
  | { kind: 'ability'; gate: Extract<Gate, { kind: 'ability' }> }
  | { kind: 'spell-off'; spell: number }
  | { kind: 'copper'; copper: number }
  | { kind: 'clear-room' }
  | { kind: 'monster'; monster: number }
  | { kind: 'occupied' }
  /** A roll that passes this share of the time; trying again is the way. */
  | { kind: 'luck'; chance: number };

/**
 * `pass` and `fail` are read facts; `unknown` is nobody having said; a need
 * is a gate that is shut now and something this character can do opens.
 */
export type Verdict = 'pass' | 'fail' | 'unknown' | { needs: Need };

/** What the judge reads about a character. Every field absent or null is unknown. */
export interface GateFacts {
  level?: number | null;
  classId?: number | null;
  raceId?: number | null;
  alignment?: Alignment | null;
  /** Evil points, where something states them; the word alone is `alignment`. */
  evil?: number | null;
  /** Item row ids carried; `packKnown` once a listing has said what that is. */
  keys?: readonly number[];
  packKnown?: boolean;
  counters?: { sums: Readonly<Record<number, number>>; complete: boolean } | null;
  spellsUp?: readonly number[];
  lives?: number | null;
  wealth?: number | null;
  stats?: Partial<Record<TbStat, number | null>> | null;
}

/**
 * Whether the counters satisfy an ability's bounds, or null where nobody has
 * said: a complete listing (`abil`) names every id it holds, so one it does
 * not name is zero; an incomplete one settles nothing about an id it skips.
 */
export function abilityHeld(
  bounds: AbilityBounds,
  counters: GateFacts['counters']
): boolean | null {
  if (counters === null || counters === undefined) return null;
  const stated = counters.sums[bounds.id];
  if (stated === undefined && !counters.complete) return null;
  const held = stated ?? 0;
  if (bounds.absent === true) return held === 0;
  if (bounds.atLeast !== undefined && held < bounds.atLeast) return false;
  if (bounds.atMost !== undefined && held > bounds.atMost) return false;
  return true;
}

export function judge(gate: Gate, facts: GateFacts): Verdict {
  switch (gate.kind) {
    case 'level': {
      const level = facts.level;
      if (level === null || level === undefined) return 'unknown';
      if (gate.max !== undefined && level > gate.max) return 'fail';
      if (gate.min !== undefined && level < gate.min)
        return { needs: { kind: 'level', min: gate.min } };
      return 'pass';
    }
    case 'class':
    case 'race': {
      const mine = gate.kind === 'class' ? facts.classId : facts.raceId;
      if (mine === null || mine === undefined) return 'unknown';
      return (mine === gate.id) === gate.is ? 'pass' : 'fail';
    }
    case 'standing': {
      const mine = facts.alignment;
      if (mine === null || mine === undefined) return 'unknown';
      const rank = alignmentRank(mine);
      const low = alignmentRank(gate.low);
      const high = alignmentRank(gate.high);
      if (rank === null || low === null || high === null) return 'unknown';
      return rank >= low && rank <= high ? 'pass' : 'fail';
    }
    case 'alignment': {
      const evil = facts.evil;
      if (evil === null || evil === undefined) return 'unknown';
      if (gate.atLeast !== undefined && evil < gate.atLeast) return 'fail';
      if (gate.atMost !== undefined && evil > gate.atMost) return 'fail';
      return 'pass';
    }
    case 'carry':
    case 'lack': {
      const held = facts.keys?.includes(gate.item) === true;
      if (held)
        return gate.kind === 'carry' ? 'pass' : { needs: { kind: 'drop', item: gate.item } };
      if (facts.packKnown !== true) return 'unknown';
      return gate.kind === 'lack' ? 'pass' : { needs: { kind: 'item', item: gate.item } };
    }
    case 'floor':
      // What lies in a room the character is not standing in is not read.
      return { needs: { kind: 'floor', item: gate.item, lying: gate.lying } };
    case 'ability': {
      const held = abilityHeld(gate, facts.counters);
      if (held === null) return 'unknown';
      return held ? 'pass' : { needs: { kind: 'ability', gate } };
    }
    case 'spell-off': {
      if (facts.spellsUp === undefined) return 'unknown';
      return facts.spellsUp.includes(gate.spell)
        ? { needs: { kind: 'spell-off', spell: gate.spell } }
        : 'pass';
    }
    case 'lives': {
      const lives = facts.lives;
      if (lives === null || lives === undefined) return 'unknown';
      return lives < gate.below ? 'pass' : 'fail';
    }
    case 'copper': {
      const wealth = facts.wealth;
      if (wealth === null || wealth === undefined) return 'unknown';
      return wealth >= gate.copper ? 'pass' : { needs: { kind: 'copper', copper: gate.copper } };
    }
    case 'roll': {
      const chance = rollChance(gate, facts);
      if (chance === null) return 'unknown';
      if (chance >= 1) return 'pass';
      return chance <= 0 ? 'fail' : { needs: { kind: 'luck', chance } };
    }
    case 'empty-room':
      return { needs: { kind: 'clear-room' } };
    case 'monster-here':
      return { needs: { kind: 'monster', monster: gate.monster } };
    case 'occupied':
      return { needs: { kind: 'occupied' } };
    default: {
      const never: never = gate;
      return never;
    }
  }
}

/**
 * The chance in percent one try passes a `testskill` roll, or null where the
 * stat is unread: the stat less the value, clamped 2–98, against 1–100
 * (`TextBlockPart.cs:1222`); `current_hp` is not clamped.
 */
export function rollPercent(
  stat: TbStat,
  held: number | null | undefined,
  value: number
): number | null {
  if (held === null || held === undefined) return null;
  const margin = held - value;
  if (stat === 'current_hp') return Math.min(Math.max(margin, 0), 100);
  return Math.min(Math.max(margin, ROLL_FLOOR), ROLL_CEILING);
}

/** The share of tries a roll gate passes, or null where the stat is unread. */
export function rollChance(gate: Extract<Gate, { kind: 'roll' }>, facts: GateFacts): number | null {
  const percent = rollPercent(gate.stat, facts.stats?.[gate.stat], gate.value);
  return percent === null ? null : percent / 100;
}

/**
 * Every gate of a way at once: `fail` if any fails, else the first need, else
 * `unknown` if any is unread, else `pass`.
 */
export function judgeAll(gates: readonly Gate[], facts: GateFacts): Verdict {
  let unknown = false;
  let need: Verdict | null = null;
  for (const gate of gates) {
    const verdict = judge(gate, facts);
    if (verdict === 'fail') return 'fail';
    if (verdict === 'unknown') unknown = true;
    else if (verdict !== 'pass' && need === null) need = verdict;
  }
  return need ?? (unknown ? 'unknown' : 'pass');
}
