/**
 * Who a character is, in the realm's own row ids: the join the equip check
 * (`src/shared/gear.ts`) needs, made once for the pack card, the console's
 * rewritten listing and a slot's quick view, so a Paladin cannot be one class
 * to one of them and another to the next.
 */
import { ownAlignment, type CharacterState } from '../../shared/character';
import type { Wearer } from '../../shared/gear';
import type { WorldGraph } from './WorldGraph';

/** What of the realm the join reads. */
export type WearerRealm = Pick<WorldGraph, 'classNamed' | 'raceId' | 'namedClasses' | 'namedRaces'>;

/** Null throughout until a stat sheet has printed, and null is unknown. */
export function wearerOf(
  state: Pick<CharacterState, 'className' | 'race' | 'progress' | 'name' | 'online'>,
  world: WearerRealm | null
): Wearer {
  const row = world && state.className ? world.classNamed(state.className) : null;
  return {
    classId: row?.id ?? null,
    raceId: world && state.race ? world.raceId(state.race) : null,
    level: state.progress.level,
    strength: state.progress.strength,
    alignment: ownAlignment(state),
    weaponType: row?.weaponType ?? null,
    armourType: row?.armourType ?? null,
    classNames: world?.namedClasses() ?? {},
    raceNames: world?.namedRaces() ?? {}
  };
}
