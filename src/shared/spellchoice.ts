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
import type { Vitals } from './character';
import type { SpellsConfig } from './config';
import { magicResistance, scaledPower } from './menace';
import { castOdds, castsARound, MAGERY, manaARound, type ProwessSheet } from './prowess';
import type { RealmFamily } from './realm';
import {
  castsOnOthers,
  castsOnSelf,
  resolveSpell,
  spellCost,
  spellTargeting,
  type CastableSpell,
  type SpellTargeting
} from './spellcraft';
import { spellReaches, type MonsterNature } from './spellReach';
import type { WorldSpell } from './world';

/** The pool a book is spent from: the wire's word, else the class row's magery type; null unknown. */
export function poolOf(
  stated: Vitals['manaType'],
  mageryType: number | undefined
): Vitals['manaType'] {
  if (stated !== null) return stated;
  if (mageryType === undefined || mageryType === 0) return null;
  return mageryType === MAGERY.mystic ? 'KAI' : 'MA';
}

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
  /** What it is, as the server asks before a spell lands (`spellReaches`); absent unknown. */
  nature?: MonsterNature | undefined;
}

export interface SpellChoiceInput {
  book: ReadonlyArray<CastableSpell & { level?: number | null }>;
  realm: (name: string) => WorldSpell | null;
  level: number | null;
  mana: number | null;
  sheet: ProwessSheet;
  family: RealmFamily | null;
  /**
   * What the book is spent from: the sheet's `Mana:` or `Kai:`. A Mystic's
   * kai goes to its other powers, and its hands outfight the attack
   * powers, so a kai book attacks with nothing (the user, 2026-10-03).
   */
  pool: Vitals['manaType'];
  target: SpellTarget | null;
  /** Spells capped this fight or passed over, by the book's spelling. */
  excluded: ReadonlySet<string>;
  /**
   * Spells the server has said have no effect on this target, this fight or
   * before on the realm, by the book's spelling: counted with the ones the
   * world database rules out, so the refusal names the reason.
   */
  noEffect?: ReadonlySet<string> | undefined;
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
  /** Attempts the server makes in one round (`castsARound`). */
  casts: number;
  /** Mean damage a round: `expected` for every attempt. */
  perRound: number;
  /** Chance one cast finishes the monster, where its remaining health is known. */
  killChance: number | null;
  cost: number | null;
  /** Mana a round: every attempt, a failed one charged half (`castOdds`); null where the cost is. */
  manaPerRound: number | null;
}

export type SpellChoiceRefusal =
  'no-book' | 'empty-book' | 'kai' | 'no-attack-spells' | 'all-resisted' | 'no-effect' | 'no-mana';

/** A refusal meaning the book holds no attack spell or power this character casts. */
export function attacksWithNothing(refusal: SpellChoiceRefusal | null): boolean {
  return refusal === 'kai' || refusal === 'no-attack-spells';
}

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
  if (input.pool === 'KAI') return { chosen: null, why: null, considered: [], refusal: 'kai' };

  const candidates: SpellCandidate[] = [];
  let attackSpells = 0;
  let affordable = 0;
  let noEffect = 0;
  for (const spell of input.book) {
    if (input.excluded.has(spell.name)) continue;
    const realm = input.realm(spell.name);
    if (realm === null) continue;
    if (!weighsAsAttack(realm)) continue;
    const power = realm.power;
    if (power === undefined) continue;
    attackSpells += 1;
    const required = spell.level ?? realm.level ?? null;
    if (input.level !== null && required !== null && required > input.level) continue;
    const cost = spell.cost ?? realm.mana ?? null;
    if (input.mana !== null && cost !== null && cost > input.mana) continue;
    affordable += 1;
    // The server answers `Your spell has no effect on` and breaks the fight.
    if (
      input.noEffect?.has(spell.name) === true ||
      spellReaches(realm, input.target?.nature) === false
    ) {
      noEffect += 1;
      continue;
    }

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
    const casts = castsARound(realm);
    const remaining = input.target?.remaining ?? null;
    let killChance: number | null = null;
    if (remaining !== null && remaining > 0) {
      const rolls = max - min + 1;
      const enough = Math.max(0, Math.min(rolls, max - remaining + 1));
      killChance = lands * (enough / rolls);
    }
    candidates.push({
      spell,
      realm,
      min,
      max,
      expected,
      casts,
      perRound: expected * casts,
      killChance,
      cost,
      manaPerRound: manaARound(realm, cost, input.sheet, input.family)
    });
  }

  if (attackSpells === 0)
    return { chosen: null, why: null, considered: [], refusal: 'no-attack-spells' };
  if (affordable === 0) return { chosen: null, why: null, considered: [], refusal: 'no-mana' };
  if (candidates.length === 0) {
    const refusal = noEffect === affordable ? 'no-effect' : 'all-resisted';
    return { chosen: null, why: null, considered: [], refusal };
  }

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
  // By the round, since the server repeats a cheap-energy spell inside one (`castsARound`).
  const hardest = [...candidates].sort((a, b) => b.perRound - a.perRound || byCost(a, b));
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

/** What the book, the level and the pool allow of the heals a targeting accepts. */
export type HealCastInput = Omit<HealChoiceInput, 'deficit' | 'aim'>;

/**
 * Every heal in the book whose targeting `accepts`, priced at this level:
 * what a cast mends, the cast's own odds folded in, and what it costs. `heals`
 * counts those the realm marks as heals before the level and the pool filter
 * them, which is how *no heal spells* is told from *none affordable*.
 */
export function healCasts(
  input: HealCastInput,
  accepts: (aim: SpellTargeting) => boolean
): { heals: number; casts: Omit<HealCandidate, 'covers'>[] } {
  const casts: Omit<HealCandidate, 'covers'>[] = [];
  let heals = 0;
  for (const spell of input.book) {
    const realm = input.realm(spell.name);
    if (realm === null) continue;
    if (!accepts(spellTargeting(realm.targets))) continue;
    const required = spell.level ?? realm.level ?? null;
    const power = healPower(realm, input.level ?? required ?? 1);
    if (power === null) continue;
    heals += 1;
    if (input.level !== null && required !== null && required > input.level) continue;
    const cost = spell.cost ?? realm.mana ?? null;
    if (input.mana !== null && cost !== null && cost > input.mana) continue;
    const [min, max] = power;
    const odds = castOdds(realm, input.sheet, input.family)?.chance.value ?? 1;
    casts.push({ spell, realm, min, max, expected: ((min + max) / 2) * odds, cost });
  }
  return { heals, casts };
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

  /*
   * A party-wide heal is never one target's heal: it reaches everybody, and
   * whether that is worth its price is `planHeal`'s question, asked of the
   * whole party at once.
   */
  const accepts =
    input.aim === 'self'
      ? (aim: SpellTargeting) => castsOnSelf(aim) && aim !== 'party'
      : (aim: SpellTargeting) => castsOnOthers(aim) && aim !== 'party';
  const { heals, casts } = healCasts(input, accepts);
  const candidates = casts.map((cast) => ({ ...cast, covers: cast.expected >= input.deficit }));

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

/** The share of the bar the healing runs to: `healTo`, or the top where it states none. */
export function healCeiling(healTo: number): number {
  return healTo > 0 ? Math.min(1, healTo) : 1;
}

/**
 * Hit points the healing wants back: the ceiling it runs to (`healCeiling`)
 * less what the bar holds. Null while either figure is unread, which is
 * unknown and never 0.
 */
export function healDeficit(
  healTo: number,
  hp: number | null,
  hpMax: number | null
): number | null {
  if (hp === null || hpMax === null || hpMax <= 0) return null;
  return Math.max(0, Math.ceil(healCeiling(healTo) * hpMax) - hp);
}

/**
 * Whether a chosen heal is worth the round in a fight: casting ends the
 * attack, so one expected to mend less than `floor`, what the round is worth
 * (`FightHeal`), is not cast at all (todo 23).
 */
export function mendsTheRound(expected: number, floor: number): boolean {
  return expected >= floor;
}

/** What `AutoHeal` casts for a deficit, and why. */
export type HealPick<F> =
  | { kind: 'configured'; why: 'switched-off' | 'no-figures' }
  | { kind: 'refused'; refusal: HealChoiceRefusal | null }
  | { kind: 'chosen'; choice: HealChoice; chosen: HealCandidate; deficit: number }
  | { kind: 'too-little'; chosen: HealCandidate; deficit: number; floor: F };

/**
 * Which heal `AutoHeal` casts: under Auto Choose Best Heal, `chooseHealSpell`
 * against the deficit; the configured spell with the switch off, the deficit
 * unread, or the choice naming nothing, since a heal not cast is a death. In
 * a fight (`inFight`, asked only then) a chosen heal that does not mend the
 * round is not cast and does not fall back. `AutoHeal` casts by it and
 * `thresholdHeal` prices by it.
 */
export function pickHeal<F extends { floor: number }>(
  autoChooseHeal: boolean,
  deficit: number | null,
  choose: (deficit: number) => HealChoice,
  inFight: ((deficit: number) => F) | null
): HealPick<F> {
  if (!autoChooseHeal) return { kind: 'configured', why: 'switched-off' };
  if (deficit === null) return { kind: 'configured', why: 'no-figures' };
  const choice = choose(deficit);
  const chosen = choice.chosen;
  if (chosen === null) return { kind: 'refused', refusal: choice.refusal };
  const floor = inFight?.(deficit) ?? null;
  if (floor !== null && !mendsTheRound(chosen.expected, floor.floor)) {
    return { kind: 'too-little', chosen, deficit, floor };
  }
  return { kind: 'chosen', choice, chosen, deficit };
}

/** A heal priced for a fight or a cycle that is run rather than cast. */
export interface PricedHeal {
  realm: WorldSpell;
  /** What one cast mends at this level (`healPower`). */
  restores: [number, number];
  /** The book's own figure, else the realm's; null where neither states one. */
  cost: number | null;
  /**
   * What a cast is expected to mend, its odds folded in, where the choice
   * named it, so a fight weighs it against the round (`mendsTheRound`); null
   * for the configured spell, which is cast whatever the round is worth.
   */
  chosenMends: number | null;
}

export interface ThresholdHealInput extends Omit<HealCastInput, 'book'> {
  book: HealCastInput['book'] | null;
  spells: Pick<SpellsConfig, 'heal' | 'healTo' | 'autoChooseHeal'>;
  /** The share of the bar the heal is cast under (`healFloor`). */
  below: number;
  hpMax: number | null;
}

/**
 * The heal `AutoHeal` casts on this character when the bar falls under
 * `below`, by `pickHeal` against the deficit there. The fight the simulator
 * runs (`FightSetup`) and the hunting survey's cycle (`Errands`) both read
 * it; a run fight weighs a chosen one against each round as `AutoHeal` does.
 * Null where none would be cast, the level is unread, or the realm marks no
 * heal on the row.
 */
export function thresholdHeal(input: ThresholdHealInput): PricedHeal | null {
  const { spells, below, hpMax, book, level } = input;
  if (below <= 0 || level === null) return null;
  // Cast while the share is under `below`: the bar one point beneath it.
  const hp = hpMax === null ? null : Math.max(0, Math.ceil(below * hpMax) - 1);
  const pick = pickHeal(
    spells.autoChooseHeal,
    healDeficit(spells.healTo, hp, hpMax),
    (deficit) =>
      chooseHealSpell(book === null ? { book } : { ...input, book, deficit, aim: 'self' }),
    null
  );
  switch (pick.kind) {
    case 'chosen':
    case 'too-little': {
      const { realm, min, max, cost, expected } = pick.chosen;
      return { realm, restores: [min, max], cost, chosenMends: expected };
    }
    case 'configured':
    case 'refused': {
      const configured = resolveSpell(spells.heal, book, input.realm);
      const realm = configured.realm;
      const restores = realm === null ? null : healPower(realm, level);
      return realm === null || restores === null
        ? null
        : { realm, restores, cost: spellCost(configured), chosenMends: null };
    }
    default: {
      const unreachable: never = pick;
      return unreachable;
    }
  }
}

/**
 * How many rounds of the spell this character would choose bring a monster of
 * `hp` hit points down, its damage a round, and its mana a round — the
 * caster's half of a fight the lair survey prices (todo 108, 2026-09-13).
 * `verdictFor` gets a melee character's rounds from the swing; a caster has
 * no swing worth the name, and this is the same question asked of the book:
 * the spell `chooseAttackSpell` picks against this monster's resistances, as
 * many casts a round as its energy buys (`castsARound`), over its full pool.
 * Null where nothing casts, nothing is affordable, everything is resisted, or
 * the monster's health is unknown — an unknown is never a number of rounds.
 */
export function castsToKill(
  input: Omit<SpellChoiceInput, 'target' | 'excluded'> | { book: null },
  monster: {
    hp: number | null;
    magicRes: number | null;
    abilities?: SpellTarget['abilities'];
    nature?: SpellTarget['nature'];
  }
): { rounds: number; perRound: number; mana: number | null; spell: string } | null {
  if (input.book === null) return null;
  if (monster.hp === null || monster.hp <= 0) return null;
  const choice = chooseAttackSpell({
    ...input,
    target: {
      remaining: monster.hp,
      magicRes: monster.magicRes,
      abilities: monster.abilities,
      nature: monster.nature
    },
    excluded: new Set()
  });
  const chosen = choice.chosen;
  if (chosen === null || chosen.perRound <= 0) return null;
  return {
    rounds: Math.max(1, Math.ceil(monster.hp / chosen.perRound)),
    perRound: chosen.perRound,
    mana: chosen.manaPerRound,
    spell: chosen.spell.name
  };
}

/**
 * Whether `chooseAttackSpell` weighs this realm row at all: aimed at a single
 * monster, with power. `DrainWhenHurt` asks it before announcing a drain the
 * choice could pick (todo 841).
 */
export function weighsAsAttack(realm: WorldSpell): boolean {
  return spellTargeting(realm.targets) === 'enemy' && (realm.power?.[1] ?? 0) > 0;
}
