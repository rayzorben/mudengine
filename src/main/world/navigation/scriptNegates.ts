/**
 * Whether a spell takes every spell off whoever it is cast on: `DispellMagic`
 * at 0 (`Spell.cs:1601`, `RemoveSpellEffect` with ability 0), on the spell
 * itself or on one its script casts. A script's `cast` lands on the player
 * who runs it for a self, friendly or any target (`TextBlockPart.cs` `cast`).
 * Every recall token runs `cast 310`, negate magic, ahead of its teleport
 * (format 63). Walked as `scriptWays` walks a move. Read at build, because
 * `TBInfo` does not ship.
 */
import { DISPELL_MAGIC_ABILITY } from '../../../shared/abilities';
import { castsOnSelf, spellTargeting } from '../../../shared/spellcraft';
import { spellDoes, type Blocks, type ScriptProbe, type SpellScriptRow } from './scriptWays';

/** A spell as this reads it: its ability pairs, its power, and `Spells.Targets`. */
export type NegateRow = SpellScriptRow & { targets?: number };

const NEGATES: ScriptProbe<NegateRow> = {
  own: (row) =>
    row.abilities.some(([ability, value]) => ability === DISPELL_MAGIC_ABILITY && value === 0),
  step: () => false,
  follows: (row) => castsOnSelf(spellTargeting(row?.targets))
};

/** True only where the chain is read through to a negate; an unread one is not. */
export function spellNegates(
  spell: number,
  rows: (spell: number) => NegateRow | undefined,
  blocks: Blocks
): boolean {
  return spellDoes(spell, NEGATES, rows, blocks) === true;
}
