/**
 * What `chooseAttackSpell` and `castsToKill` are asked with for this
 * character now: the book, the realm's rows, the level, the pool and the
 * sheet. One builder for the round's choice (`AttackSpells.chosenSpell`) and
 * the hold's prices (`SpellHold`), so the two never price a spell apart.
 */
import { tuning } from '../app/tuning';
import type { CharacterState } from '../../shared/character';
import type { ProwessSheet } from '../../shared/prowess';
import type { RealmFamily } from '../../shared/realm';
import type { KillCasting, NoEffectOn } from '../../shared/spellchoice';
import type { WorldSpell } from '../../shared/world';

export function killCasting(
  state: CharacterState,
  book: NonNullable<CharacterState['spellbook']>,
  realm: (name: string) => WorldSpell | null,
  sheet: ProwessSheet,
  family: RealmFamily | null,
  noEffectOn: NoEffectOn
): KillCasting {
  return {
    book,
    realm,
    level: state.progress.level,
    mana: state.vitals.mana,
    sheet,
    family,
    pool: state.vitals.manaType,
    killConfidence: tuning().spells.killConfidence,
    noEffectOn
  };
}
