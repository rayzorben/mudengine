/**
 * Whether a character can learn a spell from a scroll, as the server's
 * `Spell.CanPlayerUseSpell` decides it (`read` answers `Unable to learn
 * magic missile!` otherwise, captures/219): the spell's magery type is the
 * class's or 0, its magery level is no higher than the class's, then its
 * `MinLevel`, `MaxLevel` and alignment rows, then its `ReqLevel`.
 *
 * Unknown never refuses: a class whose magery type the world file does not
 * state (one converted before format 55) or an unread level or alignment is
 * `unknown`, and the server's answer settles it.
 *
 * Dependency-free, like everything in `shared/`.
 */
import type { Alignment } from './alignment';
import { LEARN_SPELL_ABILITY, MAX_LEVEL_ABILITY, MIN_LEVEL_ABILITY } from './abilities';
import type { CharacterState, KnownSpell } from './character';
import { alignmentGated, alignmentRefuses } from './gear';
import { abilitySum } from './light';
import type { GearCounter } from './upgrades';
import type { WorldItem, WorldSpell } from './world';

/** Why the server would refuse to teach a spell, in the order it asks. */
export const LEARN_REFUSALS = [
  'magery',
  'magery-level',
  'too-low',
  'too-high',
  'alignment',
  'req-level'
] as const;

export type LearnRefusal = (typeof LEARN_REFUSALS)[number];

export type LearnVerdict =
  { kind: 'learns' } | { kind: 'refused'; why: LearnRefusal } | { kind: 'unknown' };

/** Who is learning, as the server's check reads them; null is unread. */
export interface Learner {
  /** The class row's `MageryType`. */
  mageryType: number | null;
  /** The class row's `MageryLVL`, 0 for a class with none. */
  mageryLevel: number | null;
  level: number | null;
  alignment: Alignment | null;
}

type LearnedSpell = Pick<WorldSpell, 'mageryType' | 'mageryLevel' | 'abilities' | 'level'>;

/** The `Spells` rows an item's `LearnSp` names: what reading it teaches (`ReadCommand`). */
export function taughtBy(item: Pick<WorldItem, 'abilities'>): number[] {
  return (item.abilities ?? []).flatMap(([id, value]) =>
    id === LEARN_SPELL_ABILITY ? [value] : []
  );
}

export function learnVerdict(spell: LearnedSpell, learner: Learner): LearnVerdict {
  let unknown = false;
  const type = spell.mageryType ?? 0;
  const needs = spell.mageryLevel ?? 0;
  if (learner.mageryType === null || learner.mageryLevel === null) unknown = true;
  else if (type !== 0 && type !== learner.mageryType) return { kind: 'refused', why: 'magery' };
  else if (needs > learner.mageryLevel) return { kind: 'refused', why: 'magery-level' };

  const abilities = spell.abilities ?? [];
  const has = (id: number): boolean => abilities.some(([ability]) => ability === id);
  if (has(MIN_LEVEL_ABILITY) || has(MAX_LEVEL_ABILITY)) {
    const level = learner.level;
    if (level === null) unknown = true;
    else if (has(MIN_LEVEL_ABILITY) && abilitySum(abilities, MIN_LEVEL_ABILITY) > level) {
      return { kind: 'refused', why: 'too-low' };
    } else if (has(MAX_LEVEL_ABILITY) && abilitySum(abilities, MAX_LEVEL_ABILITY) < level) {
      return { kind: 'refused', why: 'too-high' };
    }
  }
  // Unlike an item's, a spell's alignment rows take no threshold from their value: the server uses -50 and 40.
  const gates = abilities.map(([id]) => [id, 0] as const);
  if (alignmentGated(abilities)) {
    if (learner.alignment === null) unknown = true;
    else if (alignmentRefuses(gates, learner.alignment))
      return { kind: 'refused', why: 'alignment' };
  }
  if (spell.level !== undefined && spell.level > 0) {
    if (learner.level === null) unknown = true;
    else if (spell.level > learner.level) return { kind: 'refused', why: 'req-level' };
  }
  return unknown ? { kind: 'unknown' } : { kind: 'learns' };
}

/** Whether a book already lists a spell by this name. */
export function listsSpell(book: readonly KnownSpell[], name: string): boolean {
  return book.some((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

/**
 * The book with `name` appended, its short word, level and cost from the
 * realm's row where there is one; the same book where it is listed already.
 */
export function withSpell(
  book: readonly KnownSpell[],
  name: string,
  realm: Pick<WorldSpell, 'short' | 'level' | 'mana'> | null
): readonly KnownSpell[] {
  if (listsSpell(book, name)) return book;
  return [
    ...book,
    { name, short: realm?.short ?? null, level: realm?.level ?? null, cost: realm?.mana ?? null }
  ];
}

/** A scroll a counter sells that teaches a spell the character does not know and is not refused. */
export interface SpellScroll {
  /** The scroll's `Items` row. */
  item: number;
  name: string;
  spell: WorldSpell;
  verdict: Exclude<LearnVerdict, { kind: 'refused' }>;
  /** The counter least out of the way that sells it. */
  sold: GearCounter;
}

/** The character with spells added to its book, and the names that went in. */
export interface Learning {
  state: CharacterState;
  learned: string[];
}
