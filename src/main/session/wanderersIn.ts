/**
 * The monsters that may wander into a room with no lair as the character
 * walks in (todo 25): the rows the realm's group may put there
 * (`WorldRoom.wanderers`), one of them drawn at `WANDERER_CHANCE` a pass,
 * each as likely as the next. The run (`lairRunner`) and the walk
 * (`routeChances`) price the room by them; the monsters the wire timed
 * walking in are the pass share's (`roadPass`). See mudengine-world ›
 * parts/routing.md › *A room's wanderers are priced as a run, beside its timed arrivals*.
 */
import type { MobEntity } from '../../shared/entities';
import { WANDERER_CHANCE } from '../../shared/runPass';
import type { WorldRoom } from '../../shared/world';
import type { WorldGraph } from '../world/WorldGraph';

export type WandererWorld = Pick<WorldGraph, 'wandererEntities'>;

/** One monster that may wander in, and the chance it does on one pass. */
export interface Wanderer {
  entity: MobEntity;
  chance: number;
}

/** The room's wanderers; none for a lair, which fills from its own slots. */
export function wanderersOf(room: WorldRoom, world: WandererWorld): Wanderer[] {
  if (room.lair !== undefined) return [];
  const all = world.wandererEntities(room);
  return all.map((entity) => ({ entity, chance: WANDERER_CHANCE / all.length }));
}
