/**
 * What stops a room's own spell, named against the realm's item and spell
 * tables: the one join the room peek (`roomBrief`) and the Room card
 * (`RoomTracker.attachRealm`) both read, so the two say the same thing about
 * the same room (todo 72). See `mudengine-world` › *The realm data answers
 * before the server is asked*.
 */
import type { SpellHazard, SpellStoppers } from '../../shared/world';
import type { WorldGraph } from './WorldGraph';

/** Null where nothing the realm can name stops it. */
export function namedStoppers(
  graph: Pick<WorldGraph, 'item' | 'spellById'>,
  hazard: SpellHazard
): SpellStoppers | null {
  const items = (hazard.avoidedBy ?? []).flatMap((id) => {
    const item = graph.item(id);
    return item === undefined ? [] : [{ id, name: item.name }];
  });
  const spells = (hazard.avoidedBySpell ?? []).flatMap((id) => {
    const spell = graph.spellById(id);
    return spell === null ? [] : [{ id, name: spell.name }];
  });
  return items.length === 0 && spells.length === 0 ? null : { items, spells };
}
