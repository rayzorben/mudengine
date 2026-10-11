/**
 * The monsters a monster's own spells bring into its room: a call for aid
 * (*The half-orc sentry shouts for aid!*) is a between-round spell whose
 * Summon ability names a row, and a death spell or a blow's spell can do the
 * same (`Spell.ApplySpellAbilities`, Spell.cs:1506; `Room.TrySummon`,
 * Room.cs:268). Read by the fight odds (`survival.ts`), by `Joiners` and by
 * `DeathSummons`, which reads the room again after such a kill.
 * See mudengine-automation › *A fight counts the monsters it draws in*.
 */
import type { Random } from './dice';
import type { MobProfile, WorldSpell } from './world';

/**
 * One `TrySummon`: the rows it may bring and the chance of each, at most one
 * of them. A Summon ability names one row, or with a value of 0 one of the
 * rows the spell's own roll reaches (`columnRows`).
 */
export type SummonPick = ReadonlyArray<readonly [row: number, chance: number]>;

/**
 * What one cast or arrival brings in: a pick for each Summon modifier, since
 * the server merges a spell's Summon abilities into one and summons once per
 * modifier (`AbilityContainer.Add`; Spell.cs:1506).
 */
export type Summons = ReadonlyArray<SummonPick>;

export const NO_SUMMONS: Summons = [];

/**
 * `GMUDServer.maxMobsPerRoom`: `Room.TrySummon` brings nobody into a room
 * holding this many, and a regen or a follow stops there too.
 */
export const MOBS_PER_ROOM = 20;

/** The spell ids a monster casts in a fight or on dying: as a blow, on a hit, between rounds, its death spell. */
export function fightSpellsOf(subject: {
  profiles?: readonly MobProfile[];
  deathSpell?: number;
}): Set<number> {
  const named = new Set<number>();
  for (const profile of subject.profiles ?? []) {
    for (const attack of profile.attacks) {
      if (attack.kind === 'spell') named.add(attack.spell);
      else if (attack.onHit !== undefined) named.add(attack.onHit);
    }
    for (const cast of profile.casts) named.add(cast.spell);
  }
  if (subject.deathSpell !== undefined) named.add(subject.deathSpell);
  return named;
}

/** What one cast of `spell` brings in; none for an unknown spell. */
export function summonsOf(spell: Pick<WorldSpell, 'summons'> | undefined): Summons {
  return spell?.summons ?? NO_SUMMONS;
}

/** What a monster's death spell brings into the room it dies in; none without one. */
export function deathSummons(subject: {
  deathSpell?: number;
  spells?: Readonly<Record<number, Pick<WorldSpell, 'summons'>>>;
}): Summons {
  return subject.deathSpell === undefined
    ? NO_SUMMONS
    : summonsOf(subject.spells?.[subject.deathSpell]);
}

/**
 * Copies on average as picks: a whole copy is a pick of its own and the
 * fraction left one more, for a source that states only the average (a
 * script's yield, the `arrive` runs).
 */
export function picksOf(made: Iterable<readonly [number, number]>): SummonPick[] {
  const picks: SummonPick[] = [];
  for (const [row, copies] of made) {
    const whole = Math.floor(copies);
    for (let n = 0; n < whole; n += 1) picks.push([[row, 1]]);
    if (copies > whole) picks.push([[row, copies - whole]]);
  }
  return picks;
}

/** The copies of each row `summons` brings on average. */
export function copiesOf(summons: Summons): Map<number, number> {
  const copies = new Map<number, number>();
  for (const pick of summons) {
    for (const [row, chance] of pick) copies.set(row, (copies.get(row) ?? 0) + chance);
  }
  return copies;
}

/** Every row the subject's own fight spells can bring into its room. */
export function summonedBy(subject: {
  profiles?: readonly MobProfile[];
  deathSpell?: number;
  spells?: Readonly<Record<number, Pick<WorldSpell, 'summons'>>>;
}): Set<number> {
  const rows = new Set<number>();
  for (const id of fightSpellsOf(subject)) {
    for (const row of copiesOf(summonsOf(subject.spells?.[id])).keys()) rows.add(row);
  }
  return rows;
}

/**
 * The rows one landed summons brings: each pick rolls once and brings the
 * row its roll falls on, or nobody past the chances' sum. Draws nothing for
 * no summons, so a fight without one rolls the same numbers it always did.
 */
export function drawSummons(random: Random, summons: Summons): number[] {
  const rows: number[] = [];
  for (const pick of summons) {
    let roll = random();
    for (const [row, chance] of pick) {
      roll -= chance;
      if (roll < 0) {
        rows.push(row);
        break;
      }
    }
  }
  return rows;
}
