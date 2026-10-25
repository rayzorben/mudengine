/**
 * What stops a room's own spell, named against the realm's item and spell
 * tables: the one join the room peek (`roomBrief`) and the Room card
 * (`RoomTracker.attachRealm`) both read, so the two say the same thing about
 * the same room (todo 72). See `mudengine-world` › *The realm data answers
 * before the server is asked*.
 */
import {
  hazardStoppers,
  type HazardStopper,
  type SpellHazard,
  type SpellStoppers
} from '../../shared/world';
import type { WorldGraph } from './WorldGraph';

/**
 * Every item and spell that takes something off it at some level, named; null
 * where the realm can name none. The card narrows the hazard to the reader's
 * level and keeps the ones that still take something off (`stopperEffects`),
 * so a level-up in the room shows without a move.
 */
export function namedStoppers(
  graph: Pick<WorldGraph, 'item' | 'spellById'>,
  hazard: SpellHazard
): SpellStoppers | null {
  const items = mentioned(hazard, 'fails').flatMap((id) => {
    const item = graph.item(id);
    return item === undefined ? [] : [{ id, name: item.name }];
  });
  const spells = mentioned(hazard, 'wards').flatMap((id) => {
    const spell = graph.spellById(id);
    return spell === null ? [] : [{ id, name: spell.name }];
  });
  return items.length === 0 && spells.length === 0 ? null : { items, spells };
}

/** What any way in fails on, with what stops it outright where it has no ways. */
function mentioned(hazard: SpellHazard, side: HazardStopper): number[] {
  const ways = Object.values(hazard.reach ?? {}).flat();
  const named = [...hazardStoppers(hazard, side), ...ways.flatMap((way) => way[side] ?? [])];
  return [...new Set(named)];
}
