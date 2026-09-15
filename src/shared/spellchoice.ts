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
import { HAZARD_ABILITY } from './abilities';
import { magicResistance, scaledPower } from './menace';
import { castOdds, type ProwessSheet } from './prowess';
import type { RealmFamily } from './realm';
import { castsOnOthers, castsOnSelf, spellTargeting, type CastableSpell } from './spellcraft';
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

/**
 * What one cast of a heal mends, as the server rolls it.
 *
 * The `Heal` ability's own figure where it states one, else the spell's power
 * scaled to this level — `Spell.RollAndApplySpellAbilities`'s
 * `abil.Sum == 0 ? modifiedValue : abil.Sum`, which is the same reading
 * `menace.hazardOf` takes of the same ability from the other side (there a
 * *negative* heal is a wound). `[min, max]`, equal where the ability states a
 * flat figure; null where the realm marks no heal on the row at all, which is
 * every attack spell and is how a book is filtered down to the heals in it.
 */
export function healPower(spell: WorldSpell, level: number): [number, number] | null {
  const stated = (spell.abilities ?? []).find(([id]) => id === HAZARD_ABILITY.heal)?.[1];
  if (stated === undefined) return null;
  if (stated > 0) return [stated, stated];
  // A negative figure is damage over time (`damnation`), not a heal.
  if (stated < 0) return null;
  const [low, high] = scaledPower(spell, level);
  const min = Math.max(0, low);
  const max = Math.max(min, high);
  return max > 0 ? [min, max] : null;
}

/** Who the cast has to reach. A heal for somebody else is a different column. */
export type HealAim = 'self' | 'party';

export interface HealChoiceInput {
  book: ReadonlyArray<CastableSpell & { level?: number | null }>;
  realm: (name: string) => WorldSpell | null;
  level: number | null;
  /** What the pool holds now: a spell it cannot pay for is not a candidate. */
  mana: number | null;
  /**
   * Hit points wanted back — the ceiling the healing runs to, less what the
   * bar holds. The figure the choice is made against, and the whole reason
   * this is decided per cast rather than configured once.
   */
  deficit: number;
  aim: HealAim;
  sheet: ProwessSheet;
  family: RealmFamily | null;
}

export interface HealCandidate {
  spell: CastableSpell;
  realm: WorldSpell;
  /** What one cast mends, at this level. */
  min: number;
  max: number;
  /** The mean, the cast's own odds folded in — a spell often fumbled mends less. */
  expected: number;
  cost: number | null;
  /** Whether one cast is expected to reach the ceiling. */
  covers: boolean;
}

export type HealChoiceRefusal = 'no-book' | 'empty-book' | 'no-heal-spells' | 'no-mana';

export interface HealChoice {
  chosen: HealCandidate | null;
  /** Why the chosen one won: it reaches the ceiling, or it mends the most. */
  why: 'covers' | 'most' | null;
  considered: HealCandidate[];
  refusal: HealChoiceRefusal | null;
}

/**
 * Which heal to cast, now: **the cheapest whose cast is expected to reach the
 * ceiling, else the one that mends most** (todo 01, 2026-09-13).
 *
 * The complaint, in the player's own figures: at 145/150 a character carrying
 * *major healing* spends a major heal's mana to mend five points, and at
 * 90/150 a character carrying *minor healing* spends round after round not
 * getting ahead of the damage. One configured spell is the wrong answer at one
 * end of the bar or the other, and which end changes every second — so the
 * spell is chosen against the **deficit**, which is a stated figure rather
 * than an estimate: `hp` and `hpMax` are the server's own numbers.
 *
 * *Expected*, not the least roll, and the reason is the pair
 * `healBelow`/`healTo`: a cast that falls short is followed by another, so
 * under-healing costs a round and over-healing costs mana that cannot be got
 * back. A guarantee would buy the dearest spell every time the deficit sat
 * above a cheap spell's floor. Where nothing is expected to reach the ceiling
 * the biggest is right — it closes the most of the gap for the round spent.
 *
 * Targeting is the realm's (`castsOnSelf` / `castsOnOthers`), never a guess:
 * `way of the swan` reaches the caster alone and `c swan <name>` is a refusal
 * printed out loud in the room.
 */
export function chooseHealSpell(input: HealChoiceInput | { book: null }): HealChoice {
  if (input.book === null) return { chosen: null, why: null, considered: [], refusal: 'no-book' };
  if (input.book.length === 0)
    return { chosen: null, why: null, considered: [], refusal: 'empty-book' };

  const candidates: HealCandidate[] = [];
  let heals = 0;
  for (const spell of input.book) {
    const realm = input.realm(spell.name);
    if (realm === null) continue;
    const aim = spellTargeting(realm.targets);
    if (!(input.aim === 'self' ? castsOnSelf(aim) : castsOnOthers(aim))) continue;
    const required = spell.level ?? realm.level ?? null;
    const power = healPower(realm, input.level ?? required ?? 1);
    if (power === null) continue;
    heals += 1;
    if (input.level !== null && required !== null && required > input.level) continue;
    const cost = spell.cost ?? realm.mana ?? null;
    if (input.mana !== null && cost !== null && cost > input.mana) continue;
    const [min, max] = power;
    const odds = castOdds(realm, input.sheet, input.family)?.chance.value ?? 1;
    const expected = ((min + max) / 2) * odds;
    candidates.push({ spell, realm, min, max, expected, cost, covers: expected >= input.deficit });
  }

  if (heals === 0) return { chosen: null, why: null, considered: [], refusal: 'no-heal-spells' };
  if (candidates.length === 0)
    return { chosen: null, why: null, considered: [], refusal: 'no-mana' };

  const byCost = (a: HealCandidate, b: HealCandidate): number =>
    (a.cost ?? Number.MAX_SAFE_INTEGER) - (b.cost ?? Number.MAX_SAFE_INTEGER);
  // Cheapest that reaches the ceiling; two at one price, the surer of them.
  const covering = candidates
    .filter((candidate) => candidate.covers)
    .sort((a, b) => byCost(a, b) || b.expected - a.expected);
  if (covering.length > 0) {
    return { chosen: covering[0]!, why: 'covers', considered: candidates, refusal: null };
  }
  const most = [...candidates].sort((a, b) => b.expected - a.expected || byCost(a, b));
  return { chosen: most[0]!, why: 'most', considered: candidates, refusal: null };
}

/**
 * How many casts of the spell this character would choose bring a monster of
 * `hp` hit points down, and what each cast costs — the caster's half of a
 * fight the lair survey prices (todo 108, 2026-09-13). `verdictFor` gets a
 * melee character's rounds from the swing; a caster has no swing worth the
 * name, and this is the same question asked of the book: the spell
 * `chooseAttackSpell` picks against this monster's resistances, at one cast a
 * round, over its full pool. Null where nothing casts, nothing is affordable,
 * everything is resisted, or the monster's health is unknown — an unknown is
 * never a number of rounds.
 */
export function castsToKill(
  input: Omit<SpellChoiceInput, 'target' | 'excluded'> | { book: null },
  monster: { hp: number | null; magicRes: number | null; abilities?: Array<[number, number]> }
): { rounds: number; mana: number | null; spell: string } | null {
  if (input.book === null) return null;
  if (monster.hp === null || monster.hp <= 0) return null;
  const choice = chooseAttackSpell({
    ...input,
    target: { remaining: monster.hp, magicRes: monster.magicRes, abilities: monster.abilities },
    excluded: new Set()
  });
  const chosen = choice.chosen;
  if (chosen === null || chosen.expected <= 0) return null;
  return {
    rounds: Math.max(1, Math.ceil(monster.hp / chosen.expected)),
    mana: chosen.cost,
    spell: chosen.spell.name
  };
}
