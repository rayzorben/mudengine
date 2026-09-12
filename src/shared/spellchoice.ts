/**
 * Which attack spell to cast at this monster, now: the reviewer's rule for
 * *Auto Choose Best Spell* (todo 09, 2026-09-12). A spell the target resists
 * is not cast; one whose least roll finishes what is left of the monster is
 * cast if it is the cheapest that does; otherwise the hardest hitter the
 * pool can pay for. Every figure is the realm's, scaled by the server's own
 * arithmetic (`scaledPower`, `magicResistance`, `castOdds`, `Spell.cs`'s
 * `CheckResistance`). See `mudengine-automation` § *A spell the server says
 * has no effect is not cast again this fight*.
 */
import { magicResistance, scaledPower } from './menace';
import { castOdds, type ProwessSheet } from './prowess';
import type { RealmFamily } from './realm';
import { spellTargeting, type CastableSpell } from './spellcraft';
import type { WorldSpell } from './world';

/** `Spell.GetMagicResModifierByValue`'s pivot: the resistance at which a cast lands as stated. */
const MAGIC_RES_PIVOT = 50;

/**
 * `Spells.AttType`, as `Spell.GetSpellAttackType` reads the column: 0 cold,
 * 1 hot, 2 stone, 3 lightning, 4 normal, 5 water, 6 poison; anything else is
 * normal. The realm's own words for the elements, not this client's.
 */
export type SpellElement = 'cold' | 'fire' | 'stone' | 'lightning' | 'normal' | 'water' | 'poison';

export function spellElementOf(code: number | null | undefined): SpellElement | undefined {
  switch (code) {
    case 0:
      return 'cold';
    case 1:
      return 'fire';
    case 2:
      return 'stone';
    case 3:
      return 'lightning';
    case 4:
      return 'normal';
    case 5:
      return 'water';
    case 6:
      return 'poison';
    default:
      return undefined;
  }
}

/**
 * The ability a monster resists each element with, as `Spell.CheckResistance`
 * reads it off the target: a percentage taken off the damage. Poison is the
 * odd one — `ImmuPoison` at 100 or more turns the whole cast to nothing and
 * anything less lets all of it through.
 */
export const RESIST_ABILITY: Record<Exclude<SpellElement, 'normal' | 'poison'>, number> = {
  cold: 3,
  fire: 5,
  stone: 65,
  lightning: 66,
  water: 147
};
const IMMUNE_TO_POISON = 21;

/** What the target is, as far as the choice needs. */
export interface SpellTarget {
  /** Hit points believed left, or null while nothing has said. */
  remaining: number | null;
  magicRes: number | null;
  /** `Monsters.Abil-n`, where the realm places the monster. */
  abilities: ReadonlyArray<readonly [number, number]> | undefined;
}

export interface SpellChoiceInput {
  book: ReadonlyArray<CastableSpell & { level?: number | null }>;
  realm: (name: string) => WorldSpell | null;
  level: number | null;
  mana: number | null;
  sheet: ProwessSheet;
  family: RealmFamily | null;
  target: SpellTarget | null;
  /** Spells refused on this target or capped this fight, by the book's spelling. */
  excluded: ReadonlySet<string>;
  /** How sure a kill has to be before the cheapest killer outranks the hardest hitter. */
  killConfidence: number;
}

export interface SpellCandidate {
  spell: CastableSpell;
  realm: WorldSpell;
  /** Damage after the target's element and magic resistance, at this level. */
  min: number;
  max: number;
  /** Mean damage a cast is expected to do, the cast's own odds folded in. */
  expected: number;
  /** Chance one cast finishes the monster, where its remaining health is known. */
  killChance: number | null;
  cost: number | null;
}

export type SpellChoiceRefusal =
  'no-book' | 'empty-book' | 'no-attack-spells' | 'all-resisted' | 'no-mana';

export interface SpellChoice {
  chosen: SpellCandidate | null;
  /** Why the chosen one won. */
  why: 'kills' | 'hardest' | null;
  considered: SpellCandidate[];
  refusal: SpellChoiceRefusal | null;
}

/** The share of an element the target turns away, `CheckResistance` transcribed. */
function elementFactor(element: SpellElement | undefined, target: SpellTarget | null): number {
  if (element === undefined || element === 'normal' || target === null) return 1;
  const sum = (id: number): number =>
    (target.abilities ?? []).reduce(
      (total, [ability, value]) => (ability === id ? total + value : total),
      0
    );
  if (element === 'poison') return sum(IMMUNE_TO_POISON) >= 100 ? 0 : 1;
  return Math.max(0, 1 - sum(RESIST_ABILITY[element]) / 100);
}

/**
 * The choice. Null `book` is *never read*, which is a different refusal from
 * an empty one — the first asks for the listing, the second says the
 * character has no spells yet.
 */
export function chooseAttackSpell(input: SpellChoiceInput | { book: null }): SpellChoice {
  if (input.book === null) return { chosen: null, why: null, considered: [], refusal: 'no-book' };
  if (input.book.length === 0)
    return { chosen: null, why: null, considered: [], refusal: 'empty-book' };

  const candidates: SpellCandidate[] = [];
  let attackSpells = 0;
  let affordable = 0;
  for (const spell of input.book) {
    if (input.excluded.has(spell.name)) continue;
    const realm = input.realm(spell.name);
    if (realm === null) continue;
    if (spellTargeting(realm.targets) !== 'enemy') continue;
    const power = realm.power;
    if (power === undefined || power[1] <= 0) continue;
    attackSpells += 1;
    const required = spell.level ?? realm.level ?? null;
    if (input.level !== null && required !== null && required > input.level) continue;
    const cost = spell.cost ?? realm.mana ?? null;
    if (input.mana !== null && cost !== null && cost > input.mana) continue;
    affordable += 1;

    const [rawMin, rawMax] = scaledPower(realm, input.level ?? required ?? 1);
    const element = elementFactor(realm.element, input.target);
    /*
     * The pivot, not zero, for a resistance nobody has read: `magicResistance`
     * reads null as none and prices the cast at 150%, which is the safe
     * direction for a hazard *against* the character and the wrong one here —
     * the choice between two spells does not move with a common factor, but
     * a kill's certainty does, and a kill the client is 150% sure of is a
     * monster still standing.
     */
    const { factor, resist } = magicResistance(realm, input.target?.magicRes ?? MAGIC_RES_PIVOT);
    const min = Math.max(0, Math.trunc(Math.max(0, rawMin) * element * factor));
    const max = Math.max(min, Math.trunc(Math.max(0, rawMax) * element * factor));
    if (max <= 0) continue;
    const odds = castOdds(realm, input.sheet, input.family)?.chance.value ?? 1;
    const lands = odds * (1 - resist);
    const expected = ((min + max) / 2) * lands;
    const remaining = input.target?.remaining ?? null;
    let killChance: number | null = null;
    if (remaining !== null && remaining > 0) {
      const rolls = max - min + 1;
      const enough = Math.max(0, Math.min(rolls, max - remaining + 1));
      killChance = lands * (enough / rolls);
    }
    candidates.push({ spell, realm, min, max, expected, killChance, cost });
  }

  if (attackSpells === 0)
    return { chosen: null, why: null, considered: [], refusal: 'no-attack-spells' };
  if (affordable === 0) return { chosen: null, why: null, considered: [], refusal: 'no-mana' };
  if (candidates.length === 0)
    return { chosen: null, why: null, considered: [], refusal: 'all-resisted' };

  const byCost = (a: SpellCandidate, b: SpellCandidate): number =>
    (a.cost ?? Number.MAX_SAFE_INTEGER) - (b.cost ?? Number.MAX_SAFE_INTEGER);
  const killers = candidates
    .filter(
      (candidate) => candidate.killChance !== null && candidate.killChance >= input.killConfidence
    )
    .sort((a, b) => byCost(a, b) || (b.killChance ?? 0) - (a.killChance ?? 0));
  if (killers.length > 0) {
    return { chosen: killers[0]!, why: 'kills', considered: candidates, refusal: null };
  }
  const hardest = [...candidates].sort((a, b) => b.expected - a.expected || byCost(a, b));
  return { chosen: hardest[0]!, why: 'hardest', considered: candidates, refusal: null };
}
