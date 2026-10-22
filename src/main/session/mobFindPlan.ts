/**
 * The rooms a find walks (`MobFinder`): the monster as the realm spells it,
 * with a regen time of its own (`hasOwnClock`) and more than one lair room
 * (`WorldGraph.lairRoomsOf`), ordered from where the character stands by the
 * navigation engine's `tour`, each room one thing with one place, weighed by
 * the router's cost so a fight on the way is priced and never refused. A
 * monster in one lair room is *Go to*'s; one in more than `tuning.mobFind.
 * maxRooms` is refused, said.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { findable, type MobFindPlan, type Unfindable } from '../../shared/mobFind';
import type { RoomId } from '../../shared/world';
import { tour } from '../world/navigation/tour';
import type { Traveller, WorldGraph } from '../world/WorldGraph';

export interface MobFindParts {
  here(): RoomId | null;
  world(): Pick<WorldGraph, 'mob' | 'lairRoomsOf' | 'sweepTo' | 'byId'> | undefined;
  /** The character as it stands, for the router's prices. */
  traveller(): Traveller;
}

export function planMobFind(parts: MobFindParts, name: string): MobFindPlan | string {
  const world = parts.world();
  if (world === undefined) return t('session.loop.noRealmData');
  const asked = name.trim();
  const mob = asked.length === 0 ? undefined : world.mob(asked);
  if (mob === undefined) return t('automation.mobFind.refusalNoSuchMonster', { name: asked });
  const lairs = world.lairRoomsOf(mob);
  const found = findable(mob, lairs.length);
  if (!found.ok) return unfindableWords(found.why, mob.name, lairs, world);
  const { maxRooms, exactStops } = tuning().mobFind;
  if (lairs.length > maxRooms) {
    return t('automation.mobFind.refusalTooMany', {
      mob: mob.name,
      rooms: lairs.length,
      most: maxRooms
    });
  }
  const origin = parts.here();
  if (origin === null) return t('session.loop.unknownRoom');
  const order = tour(
    world,
    origin,
    { things: lairs.map((room) => [room]), places: 1, exact: exactStops, end: null, by: 'cost' },
    parts.traveller()
  );
  if (order === null || order.stops.length === 0) {
    return t('automation.mobFind.refusalNoWay', { mob: mob.name });
  }
  return {
    mob: mob.name,
    regenHours: found.mob.regenHours,
    rooms: order.stops.map((stop) => stop.room),
    steps: order.stops.reduce((sum, stop) => sum + stop.moves, 0),
    unreached: order.unreached.map((thing) => lairs[thing]!)
  };
}

/** The plan's words for a monster a find does not look for. */
function unfindableWords(
  why: Unfindable,
  mob: string,
  lairs: readonly RoomId[],
  world: Pick<WorldGraph, 'byId'>
): string {
  switch (why) {
    case 'no-clock':
      return t('automation.mobFind.refusalNoClock', { mob });
    case 'no-lair':
      return t('automation.mobFind.refusalNoLair', { mob });
    case 'one-lair': {
      const only = lairs[0]!;
      return t('automation.mobFind.refusalOneLair', { mob, room: world.byId(only)?.name ?? only });
    }
    default: {
      const never: never = why;
      return never;
    }
  }
}
