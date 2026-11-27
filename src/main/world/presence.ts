/**
 * What a room block shows that can only be where the realm puts it: a monster
 * that never leaves its room and a fixture nobody can carry. Among rooms that
 * share a name and exits, the ones that place it are the rooms the block can
 * be. `mudengine-world` › `parts/realm.md` › *Who is here narrows a room*.
 */
import type { ItemEntity, MobEntity } from '../../shared/entities';
import type { WorldMob, WorldRoom } from '../../shared/world';
import { offersHolding } from './Catalogue';
import { rowsNamedHere } from './mobRowsHere';
import type { WorldSupply } from './supply';
import type { WorldGraph } from './WorldGraph';

/** The rows each monster and fixture in the block can be, one entry per thing. */
export interface Presence {
  mobs: readonly (readonly number[])[];
  items: readonly (readonly number[])[];
}

export type PresenceWorld = Pick<WorldGraph, 'mob' | 'item' | 'sourcesOf' | 'supply'>;

/** `Monsters.Type` 2: a follower, which a leader takes along whatever its own `Follow%` (`Mob.MoveExit`). */
const FOLLOWER_TYPE = 2;

const summonedBySupply = new WeakMap<WorldSupply, ReadonlySet<number>>();

/** Every monster row some run (a spell, a room command, an item) brings into the world. */
function summoned(supply: WorldSupply): ReadonlySet<number> {
  const known = summonedBySupply.get(supply);
  if (known !== undefined) return known;
  const rows = new Set<number>();
  for (const run of supply.runs) for (const id of run.monsters.keys()) rows.add(id);
  summonedBySupply.set(supply, rows);
  return rows;
}

/**
 * The rows of a monster that stays where the realm put it, or null. The server
 * moves one by patrol or by following, each a roll under `Follow%`
 * (`Mob.CheckPatrol`, `Mob.CheckFollow`), and a leader takes its followers
 * along. The fold's `follows` is the highest of the rows and is absent at
 * zero, so it is read only where the realm states the rows' types.
 */
function stillRows(mob: WorldMob, summonedRows: ReadonlySet<number>): readonly number[] | null {
  const types = mob.realmTypes;
  const ids = mob.ids ?? [];
  if (types === undefined || types.length === 0 || types.includes(FOLLOWER_TYPE)) return null;
  if (mob.follows !== undefined || ids.length === 0) return null;
  return ids.some((id) => summonedRows.has(id)) ? null : ids;
}

/**
 * The monsters and fixtures in a block that say which room it is. A charmed
 * monster goes with whoever charmed it. A fixture is an item the realm offers
 * no way to hold (`offersHolding`), so its placement is the only way it lies
 * on a floor.
 */
export function presenceOf(
  world: PresenceWorld,
  occupants: readonly { mob?: Pick<MobEntity, 'name' | 'charmed'> }[],
  items: readonly Pick<ItemEntity, 'ids'>[]
): Presence {
  const rows = summoned(world.supply());
  const mobs: (readonly number[])[] = [];
  for (const { mob } of occupants) {
    if (mob === undefined || mob.charmed) continue;
    // The fold's rows, not the entity's: those were narrowed in the room before the step.
    const fold = world.mob(mob.name);
    const still = fold === undefined ? null : stillRows(fold, rows);
    if (still !== null) mobs.push(still);
  }
  const fixtures: (readonly number[])[] = [];
  for (const { ids = [] } of items) {
    const fixed = ids.every(
      (id) => !offersHolding(world.item(id), () => world.sourcesOf({ id }).shops.length > 0)
    );
    if (ids.length > 0 && fixed) fixtures.push(ids);
  }
  return { mobs, items: fixtures };
}

/**
 * The rooms that place each monster and fixture, one at a time. A thing no
 * room of the set places is the realm and the server disagreeing, and says
 * nothing, so the set stands.
 */
export function placingRooms(rooms: readonly WorldRoom[], presence: Presence): WorldRoom[] {
  let left = [...rooms];
  const narrow = (fits: (room: WorldRoom) => boolean): void => {
    const kept = left.filter(fits);
    if (kept.length > 0) left = kept;
  };
  for (const ids of presence.mobs) {
    const wanted = new Set(ids);
    narrow((room) => rowsNamedHere(room, wanted).length > 0);
  }
  for (const ids of presence.items) {
    narrow((room) => (room.placed ?? []).some((id) => ids.includes(id)));
  }
  return left;
}
