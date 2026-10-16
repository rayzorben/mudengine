/**
 * What a realm's rounds measured (todos 121, 123): the casts of each attack
 * spell and the swings of each attack in the rounds whose target lived
 * through them (`RoundCount`). Paradigm on paramud casts harm once a round
 * where its energy buys two, and a bash the sheet states at 3.402 swings
 * lands 3.06; once enough rounds are folded the measurement outranks the
 * formula and the sheet. Plain data, so it crosses to the odds workers. See
 * `mudengine-automation` › parts/combat.md › *A round is priced at what the
 * realm does in one*.
 */

/** A realm's figures, each past the least rounds. */
export interface MeasuredRounds {
  /** Casts a round, by spell (`spellKey`). */
  casts: Readonly<Record<string, number>>;
  /** Swings a round, by `swingKey`: the attack and the swings the sheet stated for it. */
  swings: Readonly<Record<string, number>>;
}

export type RoundKind = keyof MeasuredRounds;

/** Rounds counted, and the casts or swings in them. */
export interface RoundTally {
  rounds: number;
  count: number;
}

/**
 * A swing measurement's key: the attack, and the swings a round the sheet
 * stated for it. A new sheet (new gear, a level, a load) states another
 * figure and so starts another measurement.
 */
export function swingKey(kind: string, stated: number): string {
  return `${kind}@${stated.toFixed(3)}`;
}

/** Where a realm's rounds are counted and read back. */
export interface RoundLore {
  /** One round the target lived through: `count` casts of one spell, or swings at one sheet figure. */
  observeRound(kind: RoundKind, key: string, count: number): void;
  /** The figures past the least rounds; null where none is. */
  measuredRounds(): MeasuredRounds | null;
}

/** Counts and keeps nothing: a session with no realm lore. */
export const NO_ROUNDS_KEPT: RoundLore = {
  observeRound: () => {},
  measuredRounds: () => null
};

/** The mean of each tally of `least` rounds or more; null where no tally has that many. */
export function measuredFrom(
  tallies: Readonly<Record<RoundKind, ReadonlyMap<string, RoundTally>>>,
  least: number
): MeasuredRounds | null {
  const means = (table: ReadonlyMap<string, RoundTally>): Record<string, number> =>
    Object.fromEntries(
      [...table]
        .filter(([, tally]) => tally.rounds >= Math.max(1, least))
        .map(([key, tally]) => [key, tally.count / tally.rounds])
    );
  const casts = means(tallies.casts);
  const swings = means(tallies.swings);
  return Object.keys(casts).length + Object.keys(swings).length === 0 ? null : { casts, swings };
}
