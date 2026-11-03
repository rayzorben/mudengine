/**
 * What a room command's own spell does to whoever says it (`RoomCommand.casts`,
 * format 43): the spell and what it ends in (`EndCast`), and the one-off hit
 * of a spell that lands once. `WorldGraph.castWay` reads both: the chain for
 * the timed passage, the hit for the router's price (`Router.hitCost`).
 */
import { tuning } from '../../app/tuning';
import { HAZARD_ABILITY, abilityWound } from '../../../shared/abilities';
import type { CommandHit, WorldSpell } from '../../../shared/world';

/** The spell and what it ends in, five deep, stopping at a row the realm lacks or a loop. */
export function castChain(
  first: number,
  spellById: (id: number) => WorldSpell | null
): WorldSpell[] {
  const chain: WorldSpell[] = [];
  const seen = new Set<number>();
  for (let next: number | undefined = first; next !== undefined && next > 0;) {
    if (seen.has(next) || chain.length > 4) break;
    seen.add(next);
    const spell = spellById(next);
    if (spell === null) break;
    chain.push(spell);
    next = spell.abilities?.find(([ability]) => ability === HAZARD_ABILITY.endCast)?.[1];
  }
  return chain;
}

/**
 * The hit the chain's first spell lands as the command is said, where it has
 * no duration and wounds: `fall` is `Damage 0` at 5–15, `fire portal` 100.
 * Its columns add, each a 0 taking the roll (`abilityWound`). A spell that
 * lasts is a passage's (`corridorFrom`), not a hit.
 */
export function commandHit(chain: readonly WorldSpell[]): CommandHit | null {
  const spell = chain[0];
  if (spell === undefined || (spell.duration ?? 0) > 0) return null;
  let mean = 0;
  let most = 0;
  for (const [ability, value] of spell.abilities ?? []) {
    const wound = abilityWound(ability, value, spell.power);
    if (wound === null) continue;
    mean += wound.mean;
    most += wound.most;
  }
  return most > 0 ? { name: spell.name, mean, most } : null;
}

/**
 * Whether a hit taking this share of the bar at its most roll is a wall: one
 * that empties it, or a bar unread (null). The router's price and the reach
 * key ask this one rule.
 */
export function hitWalls(share: number | null): boolean {
  return share === null || share >= tuning().world.deadlyShare;
}
