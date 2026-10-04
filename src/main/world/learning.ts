/**
 * Who is learning, read off the class row (`learnVerdict`'s half that the
 * sheet does not print), and the character as it would be with other spells
 * in its book: what a planner surveys to price a scroll before buying it, as
 * `wearing` prices an item. A book never read is taken as empty, since the
 * character asked about is a hypothetical one.
 */
import { ownAlignment, type CharacterState, type KnownSpell } from '../../shared/character';
import { withSpell, type Learner, type Learning } from '../../shared/learning';
import type { WorldClass, WorldSpell } from '../../shared/world';

/** Null throughout until a stat sheet has printed and the class row is found. */
export function learnerOf(state: CharacterState, row: WorldClass | null): Learner {
  return {
    mageryType: row?.mageryType ?? null,
    // A row states no level for a class with none; one with no type is unknown.
    mageryLevel: row?.mageryType === undefined ? null : (row.magery ?? 0),
    level: state.progress.level,
    alignment: ownAlignment(state)
  };
}

export function learning(
  state: CharacterState,
  ids: readonly number[],
  realm: { spellById(id: number): WorldSpell | null }
): Learning {
  let book: readonly KnownSpell[] = state.spellbook ?? [];
  const learned: string[] = [];
  for (const id of ids) {
    const spell = realm.spellById(id);
    if (spell === null) continue;
    const next = withSpell(book, spell.name, spell);
    if (next === book) continue;
    book = next;
    learned.push(spell.name);
  }
  return { state: { ...state, spellbook: [...book] }, learned };
}
