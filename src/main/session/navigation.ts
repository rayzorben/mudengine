/**
 * The navigation engine for one character: the plan from where it stands
 * (`world/navigation/plan.ts`), with the fights weighed as combat weighs them
 * before opening (`unfoughtShare`, the same rule) and the counters priced
 * against the purse. Every automation that goes somewhere asks this.
 * `mudengine-world` › *There is one navigation engine*.
 */
import { tuning } from '../app/tuning';
import type { CharacterTracker } from '../parse/CharacterTracker';
import { plan, type PlanRealm } from '../world/navigation/plan';
import { standing } from '../world/navigation/standing';
import type { WorldGraph } from '../world/WorldGraph';
import { unfoughtShare } from '../../shared/danger';
import type { FightOdds, NavigationOracle, Plan } from '../../shared/navigation';
import { roomAddress, type RoomId } from '../../shared/world';
import type { Errands } from './Errands';
import type { OddsReader } from './OddsBook';

export interface NavigationParts {
  world():
    | Pick<
        WorldGraph,
        'route' | 'sweepTo' | 'itemSources' | 'byId' | 'lairOf' | 'residentEntities' | 'item'
      >
    | undefined;
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<Errands, 'travellerNow' | 'priceAt'>;
  odds(): OddsReader;
}

export class Navigation {
  constructor(private readonly parts: NavigationParts) {}

  /** The plan from where the character stands to `to`, or null while unplaced or worldless. */
  planTo(to: RoomId): Plan | null {
    const world = this.parts.world();
    const state = this.parts.tracker.current;
    const here = roomAddress(state.room);
    if (world === undefined || here === null) return null;
    const realm: PlanRealm = {
      route: (from, target, traveller, options) => world.route(from, target, traveller, options),
      sweep: (from, rooms, traveller) => world.sweepTo(from, rooms, traveller),
      sources: (item) => world.itemSources(item),
      standing: (room) => standing(world, room),
      roomName: (room) => world.byId(room)?.name ?? room
    };
    return plan(realm, this.oracle(world), here, to, this.parts.errands.travellerNow(state));
  }

  private oracle(world: Pick<WorldGraph, 'byId' | 'lairOf' | 'item'>): NavigationOracle {
    const odds = this.parts.odds();
    return {
      fight: (monster, room) => fightOdds(odds, world, monster, room),
      affords: (item, room) => {
        const wealth = this.parts.tracker.current.inventory.wealth;
        const name = world.item(item)?.name;
        const price = name === undefined ? null : this.parts.errands.priceAt(name, room);
        return wealth === null || price === null ? null : wealth >= price;
      }
    };
  }
}

/**
 * Whether combat would open on a monster where it stands, by the rule it opens
 * by (`unfoughtShare` against `openAbove`): one of the room's lair is weighed
 * with the whole lair at its cap, as combat meets it there; any other monster
 * (a resident, a summoner, one met away from its lair) on its own.
 */
export function fightOdds(
  odds: OddsReader,
  world: Pick<WorldGraph, 'byId' | 'lairOf'>,
  monster: string,
  room: RoomId | null
): FightOdds {
  const known = room === null ? undefined : world.byId(room);
  const inLair = known !== undefined && world.lairOf(known).some((mob) => mob.name === monster);
  const fight = inLair ? odds.lair(known) : odds.mob(monster);
  const survives = unfoughtShare(fight, tuning().combat.openAbove);
  if (survives === undefined) return { kind: 'win' };
  return survives === null ? { kind: 'unread' } : { kind: 'lose', survives };
}
