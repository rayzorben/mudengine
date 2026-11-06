/**
 * The casts of a spell whose landing line names neither the spell nor its
 * caster: soul rip prints `You begin to chant in a fierce tone!` once a round
 * and `A strange force rips into big mangy dog for 137 damage!` once per cast
 * (`Spell.cs:1171-1203`; orohost wire, todo 857). The start line is the only
 * line that says the cast is this character's, so a landing counts only
 * while this character's start line of the spell is the latest one heard. The
 * rules: `mudengine-automation` › `parts/combat.md` › *A landing that names
 * no caster counts after the caster's own start line*.
 */
import type { Block } from '../../shared/blocks';
import { spellKey, splitSpells } from '../../shared/spell-messages';

/** The spell the server repeats, as these lines identify it. */
export interface UnnamedSpell {
  /** The name its casts are counted under. */
  key: string;
  /** The realm's row ids a landing's `spells` carries for it. */
  ids: readonly number[];
  /** The message record of the caster's start line, or null when the table has none. */
  castStart: number | null;
}

export class UnnamedCasts {
  /** The spell whose start line was this character's and the latest of its record, by `key`. */
  private armed: string | null = null;

  /** Whether `block` is one more cast of `spell` by this character. */
  heard(block: Block, spell: UnnamedSpell | null): boolean {
    if (spell === null || spell.castStart === null) {
      this.armed = null;
      return false;
    }
    if (block.type === 'realm-message' && Number(block.groups['message']) === spell.castStart) {
      // Role 1 is the caster's own line; the other two name somebody else.
      this.armed = block.groups['role'] === '1' ? spell.key : null;
      return false;
    }
    // This spell's own fizzle: no landing of this character's follows it this round.
    if (
      block.type === 'spell-failed' &&
      spellKey(block.groups['spell'] ?? '') === spellKey(spell.key)
    ) {
      this.armed = null;
      return false;
    }
    if (block.type !== 'user-hits' || this.armed !== spell.key) return false;
    if (block.groups['attacker'] !== undefined) return false;
    return splitSpells(block.groups['spells']).some((id) => spell.ids.includes(Number(id)));
  }

  /** The fight ended: a start line from it says nothing about the next. */
  clear(): void {
    this.armed = null;
  }
}
