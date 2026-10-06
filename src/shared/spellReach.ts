/**
 * Whether a spell can touch a monster at all: `Spell.CanSpellAffectTarget`
 * transcribed (GreaterMUD `Spells/Spell.cs`). Where it says no, the server
 * prints `Your spell has no effect on <name>.` and breaks the caster's combat
 * without a `*Combat Off*` (`Player.InitiateSpell`, `BreakCombat(false)`), so
 * a spell the world database already rules out costs the round. The
 * `Enslave` check is left out: it reads a charm spell, never an attack. See
 * `mudengine-automation` › `parts/combat.md` › *A spell the world database
 * says has no effect is never cast*.
 */
import { carriesAbility, SPELL_REACH_ABILITY } from './abilities';
import { abilitySum } from './light';
import type { WorldSpell } from './world';

/**
 * What a monster is, as the server asks before a spell lands. Each field is
 * null where the realm's rows for the name disagree or the realm file does
 * not say, which is never read as the answer either way.
 */
export interface MonsterNature {
  nonLiving: boolean | null;
  animal: boolean | null;
  undead: boolean | null;
  /** `SpellImmu` (each row's sum), least and most over the rows. */
  spellImmunity: readonly [number, number] | null;
}

/** One `Monsters` row as `natureOf` reads it; `abilities` undefined is a row whose effects the file does not carry. */
export interface NatureRow {
  abilities?: ReadonlyArray<readonly [number, number]> | undefined;
  undead?: boolean | undefined;
}

/** `SpellImmu` at or above this is immune to every spell (`CanSpellAffectTarget`). */
const IMMUNE_TO_ALL = 999;

/** `SpellTargetType.FullAttackArea`: the immunity level is not checked for it. */
const FULL_ATTACK_AREA = 12;

/** What every row of a name agrees it is; one row is that row. */
export function natureOf(rows: readonly NatureRow[]): MonsterNature {
  const agreed = (read: (row: NatureRow) => boolean | null): boolean | null => {
    const seen = new Set(rows.map(read));
    if (seen.size !== 1) return null;
    return [...seen][0] ?? null;
  };
  const has = (id: number) => (row: NatureRow) =>
    row.abilities === undefined ? null : carriesAbility(row.abilities, id);
  const immunities = rows.map((row) =>
    row.abilities === undefined
      ? null
      : abilitySum(row.abilities, SPELL_REACH_ABILITY.spellImmunity)
  );
  const known = immunities.filter((value): value is number => value !== null);
  return {
    nonLiving: agreed(has(SPELL_REACH_ABILITY.nonLiving)),
    animal: agreed(has(SPELL_REACH_ABILITY.animal)),
    undead: agreed((row) => row.undead ?? false),
    spellImmunity:
      rows.length === 0 || known.length < rows.length
        ? null
        : [Math.min(...known), Math.max(...known)]
  };
}

/**
 * Whether the spell can touch a monster of this nature: false where the
 * server is sure to answer *no effect*, true where it is sure not to, null
 * where the rows disagree or nothing says.
 */
export function spellReaches(spell: WorldSpell, nature: MonsterNature | undefined): boolean | null {
  if (nature === undefined) return null;
  const spellCarries = (id: number): boolean => carriesAbility(spell.abilities, id);
  const answers: Array<boolean | null> = [];
  const refusedWhen = (asked: boolean, monster: boolean | null): void => {
    if (asked) answers.push(monster === null ? null : !monster);
  };
  refusedWhen(spellCarries(SPELL_REACH_ABILITY.affectsUndead), invert(nature.undead));
  refusedWhen(spellCarries(SPELL_REACH_ABILITY.affectsLiving), nature.nonLiving);
  refusedWhen(spellCarries(SPELL_REACH_ABILITY.affectsAnimals), invert(nature.animal));
  answers.push(immunityLets(spell, nature.spellImmunity));
  if (answers.includes(false)) return false;
  return answers.includes(null) ? null : true;
}

const invert = (value: boolean | null): boolean | null => (value === null ? null : !value);

/** `SpellImmu` 999 stops every spell; a lower one stops a spell whose `ReqLevel` is below it, unless the spell fills the room. */
function immunityLets(spell: WorldSpell, range: readonly [number, number] | null): boolean | null {
  if (range === null) return null;
  const stops = (immunity: number): boolean | null => {
    if (immunity <= 0) return false;
    if (immunity >= IMMUNE_TO_ALL) return true;
    if (spell.targets === FULL_ATTACK_AREA) return false;
    return spell.level === undefined ? null : spell.level < immunity;
  };
  // The least immune row stopping it is every row stopping it.
  const [least, most] = range.map(stops);
  if (least === true) return false;
  return least === false && most === false ? true : null;
}
