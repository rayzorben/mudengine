/**
 * The header's `supply` (format 56, `supplyIndex.ts`) as typed rows, parsed
 * at the boundary: a row that is not the shape is dropped, never guessed at.
 * What the realm makes and what each run of something makes; the rates are
 * `itemRarity.ts`'s.
 */
import type { MonsterRun } from '../../shared/rarity';
import { asRoomReference, roomId, type RoomId } from '../../shared/world';

/** What a typed phrase asks first: nothing, items it uses up, or a quest flag. */
export type SupplyGate =
  { kind: 'onDemand' } | { kind: 'uses'; items: number[] } | { kind: 'quest' };

/** What runs; `chance` is a fight's per round. Monster and item numbers are rows. */
export type SupplyTrigger =
  | { kind: 'drop' | 'arrive' | 'death'; monster: number }
  | { kind: 'fight' | 'attack'; monster: number; chance: number }
  | { kind: 'use'; item: number }
  | { kind: 'ask'; monster: number; say: string; gate: SupplyGate }
  /** A phrase typed in any of `rooms`, which share one command block. */
  | { kind: 'say'; rooms: [RoomId, ...RoomId[]]; say: string; gate: SupplyGate };

/** The monster whose own spell a run is, and when it casts it; null for a drop, a use or a phrase. */
export function castBy(by: SupplyTrigger): { monster: number; when: MonsterRun } | null {
  switch (by.kind) {
    case 'arrive':
    case 'death':
    case 'fight':
    case 'attack':
      return { monster: by.monster, when: by.kind };
    case 'drop':
    case 'use':
    case 'ask':
    case 'say':
      return null;
    default: {
      const never: never = by;
      return never;
    }
  }
}

/** One run of a trigger: copies of each item and monster it makes, on average. */
export interface SupplyRun {
  by: SupplyTrigger;
  items: ReadonlyMap<number, number>;
  monsters: ReadonlyMap<number, number>;
}

/** A shop slot restocked on a timer: `amount` at `percent` every `minutes`. */
export interface Shelf {
  shop: number;
  item: number;
  amount: number;
  percent: number;
  minutes: number;
}

export interface WorldSupply {
  shelves: readonly Shelf[];
  /** Monster row → `RegenTime` hours, where stated above zero. */
  clocks: ReadonlyMap<number, number>;
  /** Monster rows that roam. */
  roams: ReadonlySet<number>;
  runs: readonly SupplyRun[];
}

/** A realm whose file states no supply: nothing is rated, so every item is unknown. */
export const NO_SUPPLY: WorldSupply = {
  shelves: [],
  clocks: new Map(),
  roams: new Set(),
  runs: []
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const rowsOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function madeOf(value: unknown): Map<number, number> {
  const made = new Map<number, number>();
  for (const pair of rowsOf(value)) {
    if (!Array.isArray(pair)) continue;
    const [id, copies] = pair as unknown[];
    if (isCount(id) && isCount(copies)) made.set(id, copies);
  }
  return made;
}

function gateOf(record: Record<string, unknown>): SupplyGate {
  if (record['q'] === 1) return { kind: 'quest' };
  const uses = rowsOf(record['u']).filter(isCount);
  return uses.length > 0 ? { kind: 'uses', items: uses } : { kind: 'onDemand' };
}

function triggerOf(record: Record<string, unknown>): SupplyTrigger | null {
  const kind = record['k'];
  const monster = record['m'];
  const say = typeof record['say'] === 'string' ? record['say'] : null;
  switch (kind) {
    case 'drop':
    case 'arrive':
    case 'death':
      return isCount(monster) ? { kind, monster } : null;
    case 'fight':
    case 'attack': {
      const chance = record['p'];
      return isCount(monster) && isCount(chance) ? { kind, monster, chance } : null;
    }
    case 'use':
      return isCount(record['it']) ? { kind, item: record['it'] } : null;
    case 'ask':
      return isCount(monster) && say !== null ? { kind, monster, say, gate: gateOf(record) } : null;
    case 'say': {
      const rooms = rowsOf(record['at']).flatMap((at) => {
        const place = typeof at === 'string' ? asRoomReference(at) : null;
        return place === null ? [] : [roomId(place.map, place.room)];
      });
      const [first, ...rest] = rooms;
      return first === undefined || say === null
        ? null
        : { kind, rooms: [first, ...rest], say, gate: gateOf(record) };
    }
    default:
      return null;
  }
}

/** The header's `supply`, typed; anything else is no supply. */
export function readSupply(raw: unknown): WorldSupply {
  if (raw === null || typeof raw !== 'object') return NO_SUPPLY;
  const record = raw as Record<string, unknown>;
  const shelves: Shelf[] = [];
  for (const row of rowsOf(record['sh'])) {
    if (!Array.isArray(row)) continue;
    const [shop, item, amount, percent, minutes] = row as unknown[];
    if ([shop, item, amount, percent, minutes].every(isCount)) {
      shelves.push({
        shop: shop as number,
        item: item as number,
        amount: amount as number,
        percent: percent as number,
        minutes: minutes as number
      });
    }
  }
  const clocks = new Map<number, number>();
  for (const pair of rowsOf(record['rt'])) {
    if (!Array.isArray(pair)) continue;
    const [monster, hours] = pair as unknown[];
    if (isCount(monster) && isCount(hours)) clocks.set(monster, hours);
  }
  const runs: SupplyRun[] = [];
  for (const row of rowsOf(record['runs'])) {
    if (row === null || typeof row !== 'object') continue;
    const fields = row as Record<string, unknown>;
    const by = triggerOf(fields);
    if (by !== null) runs.push({ by, items: madeOf(fields['gi']), monsters: madeOf(fields['sm']) });
  }
  return { shelves, clocks, roams: new Set(rowsOf(record['ro']).filter(isCount)), runs };
}
