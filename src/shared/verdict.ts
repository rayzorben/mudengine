import {
  rankByMenace,
  type Menace,
  type MenacePlayer,
  type MenaceSubject,
  type MenaceWeights,
  weighRoom
} from './menace';
import { swing, type ProwessSheet, type ProwessWeapon, type Reckoning } from './prowess';
import type { RealmFamily } from './realm';

/**
 * *Can I fight this?* — one answer, read by the card and by the engine.
 *
 * The client has had both halves of this for a while and never put them
 * together. `menace.ts` says what a monster costs to **leave standing**;
 * `prowess.ts` (2026-09-04) says what it costs to **kill**. The question a
 * player asks a hundred times an evening is the comparison, and until now they
 * had to do it in their head — with `100 − (AC/10)² / max((Acc²/14)/10, 1)` in
 * one of them and a wild dog biting them.
 *
 * ## Why this is one function and not two implementations
 *
 * `AutoCombat` picks a target and the Reference card explains one. **If the
 * card says a monster is a bad fight and the engine picks it anyway, one of
 * them is lying**, and the only way that stays true is if both read the same
 * function. So the verdict is computed here, in `src/shared/`, dependency-free
 * — the engine ranks with `rankByVerdict` and the surface renders the same
 * `Verdict` it ranked on.
 *
 * ## What changed about the ranking, and why health was only ever a proxy
 *
 * `rankByMenace` orders by `perRound / hp` — Smith's rule, with a monster's
 * *health* standing in for the time it takes to remove. That was right when the
 * client could not compute the other factor: health is proportional to
 * time-to-kill when every monster takes the same damage per round, and a factor
 * equal for everything in a room changes no order.
 *
 * It stops being right the moment armour class and dodge differ, which is
 * always. Two monsters with 100 health, one of which this character hits half
 * as often, take twice as long to remove and are worth killing in the other
 * order. `rankByVerdict` uses **rounds** where rounds are knowable and falls
 * back to `menace.weight` where they are not — per monster, not per room, so
 * one unknown does not throw away what is known about the rest.
 */

/** What a monster costs, in both directions, with every figure's provenance. */
export interface Verdict {
  /** What it costs to leave standing. Null when the realm can say nothing about it. */
  menace: Menace | null;
  /**
   * Rounds to bring it down, from `prowess.swing`. Always a `bound` — the
   * accuracy behind it is a floor and neither crits nor hit spells are counted
   * — so the true figure is at most this. Null when it is not knowable at all,
   * never `0` and never `∞`.
   */
  rounds: Reckoning<number> | null;
  /**
   * Health this fight is expected to cost: `menace.perRound × rounds`.
   *
   * **This is the answer.** Not the monster's damage, not its health — what
   * taking it on takes off this character, which is the one number a person
   * standing in the room can compare against the health they have. Null when
   * either half is unknown, because half of a product is not an estimate of it.
   */
  cost: Reckoning<number> | null;
}

/**
 * The two halves for one monster.
 *
 * The menace is passed in rather than computed, because `weighRoom` prices a
 * whole room at once — the hazard unit is *one round of the whole room's blows*
 * and cannot be derived monster by monster.
 */
export function verdictFor(
  menace: Menace | null,
  subject: { armourClass?: number; damageResist?: number; dodge?: number; hp?: number },
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  family: RealmFamily | null
): Verdict {
  const attack = swing(
    sheet,
    weapon,
    {
      armourClass: subject.armourClass ?? null,
      damageResist: subject.damageResist ?? null,
      dodge: subject.dodge ?? null,
      // The menace's own figure first: it is the realm's high end, and where
      // the realm cannot name the monster it is what the lore has learned.
      health: menace?.hp ?? subject.hp ?? null
    },
    family
  );
  const rounds = attack?.rounds ?? null;
  const cost =
    menace === null || rounds === null
      ? null
      : { value: menace.perRound * rounds.value, from: 'bound' as const };
  return { menace, rounds, cost };
}

/**
 * Every monster in a room, weighed both ways.
 *
 * One call, because the menace half must be a room at a time. Same order in as
 * out, so a caller can index straight back into its own list.
 */
export function weighVerdicts(
  subjects: ReadonlyArray<
    MenaceSubject & { armourClass?: number; damageResist?: number; dodge?: number }
  >,
  player: MenacePlayer,
  weights: MenaceWeights,
  sheet: ProwessSheet,
  weapon: ProwessWeapon | null,
  family: RealmFamily | null
): Verdict[] {
  const menaces = weighRoom(subjects, player, weights);
  return subjects.map((subject, index) =>
    verdictFor(menaces[index] ?? null, subject, sheet, weapon, family)
  );
}

/**
 * What this character is actually swinging with.
 *
 * `equipped` is the listing's own word for worn, wielded or lit, and the kind
 * is the realm's — so a lit torch and a worn helm are excluded by kind and a
 * weapon sitting in the pack by `equipped`. **The first one wins and the rest
 * are ignored**: a two-weapon listing is a state this client cannot price (the
 * server swings one attack type at a time) and picking the better of the two
 * would be a guess about which the server chose.
 *
 * `null` for a character fighting unarmed, which is honest: martial arts is on
 * the stat sheet and its conversion to a damage range is not in hand, so
 * `swing()` answers no damage rather than inventing one.
 */
export function wieldedWeapon(
  items: ReadonlyArray<{ equipped: boolean; kind?: string; weapon?: ProwessWeapon }>
): ProwessWeapon | null {
  const found = items.find((item) => item.equipped && item.kind === 'weapon' && item.weapon);
  return found?.weapon ?? null;
}

/**
 * What to hit first — Smith's rule, on rounds where rounds are known.
 *
 * Ordered by *damage rate over time to remove*: killing the thing that costs
 * the most per round of the time it takes to remove minimises the damage
 * absorbed over the whole fight. `menace.weight` is that ratio with health
 * standing in for time; this is the same ratio with the time itself.
 *
 * **Mixed rooms rank honestly.** A monster whose rounds are known is compared
 * on `perRound / rounds` and one whose rounds are not falls back to its
 * `weight`, and the two scales are not the same — so the fallbacks are ordered
 * *among themselves* and placed after every monster the client can actually
 * cost. That is deliberate: a monster nothing is known about is not a monster
 * to open on, and putting it last is the same refusal `rankByMenace` makes of
 * a null menace by putting it first (there, nothing known means nothing to
 * fear; here, nothing known means nothing to promise).
 *
 * A null menace keeps `rankByMenace`'s own answer — first, because a monster
 * the realm cannot place is the one this client has the least right to skip
 * past.
 */
export function rankByVerdict(verdicts: ReadonlyArray<Verdict>): number[] {
  const scored = verdicts.map((verdict, index) => {
    const { menace, rounds } = verdict;
    if (menace === null) return { index, tier: 0, score: 0 };
    if (rounds === null || rounds.value <= 0) return { index, tier: 2, score: menace.weight };
    return { index, tier: 1, score: menace.perRound / rounds.value };
  });
  return scored
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.index - b.index)
    .map((entry) => entry.index);
}

/** Re-exported so a caller that only has menaces still has one ranking to reach for. */
export { rankByMenace };
