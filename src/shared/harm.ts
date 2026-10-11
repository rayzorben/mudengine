/**
 * What each monster did to the character in one fight, beside what the odds
 * book predicted for the same monster and character when it opened (todo 26).
 * `FightRecord` is the other direction: the character's blows on a monster.
 * Written by the parse path through `HarmSink.harm`, kept beside the fight
 * log as `harm.jsonl.gz`, read by `scripts/harm-report.mjs`, which compares
 * each term of the model with the lines. See mudengine-world › *Every fight
 * is written down before anybody asks*.
 */
import type { CharacterState } from './character';
import type { FightGear } from './fights';
import type { MobTerms } from './mobRound';

/** One line of a monster's on the character, as the parse path read it. */
export type HarmBlow =
  { kind: 'miss' } | { kind: 'melee'; damage: number } | { kind: 'spell'; damage: number };

/** The odds book's answer for the monster alone, stamped at the opening. */
export type HarmOdds =
  | { kind: 'unread' | 'pending' | 'unrun' }
  | { kind: 'run'; survives: number; rounds: number; lostMean: number; worstRound: number };

/** What was predicted, at the opening, for this monster against this character. */
export interface HarmPrediction {
  /** The realm's monster the printed name resolved to; null where it names none. */
  row: string | null;
  /** The model's terms; null where the realm cannot weigh the monster. */
  terms: MobTerms | null;
  odds: HarmOdds;
  /** The realm's round at the opening, ms: orohost runs 1 s, the paramud hosts 5 s. */
  roundMs: number;
}

/** How the fight ended for the character. */
export type HarmEnd = 'off' | 'died';

export interface HarmRecord {
  /** Epoch ms the fight ended. */
  at: number;
  /**
   * The `mobKey` of the attacker as printed, modifier and all; null for the
   * lines no attacker could be named for (`A whirlwind of fire burns you`),
   * kept as one record a fight.
   */
  mob: string | null;
  ended: HarmEnd;
  /** Its first and last line on the character, epoch ms. */
  firstAt: number;
  lastAt: number;
  /** Melee swings that missed, were dodged or glanced off. */
  misses: number;
  /** Melee blows that landed, and their damage. */
  hits: number;
  meleeDamage: number;
  /** Spell lines that landed on the character, and their damage. */
  casts: number;
  spellDamage: number;
  /**
   * Whether another monster was already on the character when this one's
   * first line came: a joiner, which the model prices apart.
   */
  joined: boolean;

  /* The character at the opening: what the prediction was made against. */
  level: number | null;
  hp: number | null;
  hpMax: number | null;
  armourClass: number | null;
  damageResist: number | null;
  magicRes: number | null;
  gear: FightGear[];

  /** Null where the session had nothing to predict with (no realm, no sheet). */
  predicted: HarmPrediction | null;
}

/**
 * Where the parse path sends a monster's harm and asks for the prediction at
 * the opening, against the character as that line found it; and what has been
 * settled, for a reader after the fact. `taken` is null where nothing is kept.
 */
export interface HarmSink {
  harm(record: HarmRecord): void;
  predict(mob: string, state: CharacterState): HarmPrediction | null;
  /** The records settled at or after `since` (epoch ms) and still held, oldest first. */
  taken(since: number): readonly HarmRecord[] | null;
}

/** Keeps nothing and predicts nothing: a session with `logging.fights` off, and every test. */
export const NO_HARM: HarmSink = {
  harm: () => {},
  predict: () => null,
  taken: () => null
};

/**
 * The lines of many fights against one realm monster, summed, with what the
 * model predicted over the same rounds summed beside them. Fights with no
 * prediction count in `fights` and in nothing else.
 */
export interface HarmFold {
  fights: number;
  died: number;
  joined: number;
  /** Rounds of the fights that carried terms, at the round length asked. */
  rounds: number;
  misses: number;
  hits: number;
  meleeDamage: number;
  casts: number;
  spellDamage: number;
  /** The model's expectation over the same rounds. */
  expected: {
    swings: number;
    hits: number;
    meleeDamage: number;
    casts: number;
    spellDamage: number;
  };
}

const emptyHarmFold = (): HarmFold => ({
  fights: 0,
  died: 0,
  joined: 0,
  rounds: 0,
  misses: 0,
  hits: 0,
  meleeDamage: 0,
  casts: 0,
  spellDamage: 0,
  expected: { swings: 0, hits: 0, meleeDamage: 0, casts: 0, spellDamage: 0 }
});

/**
 * Rounds a monster's lines ran over: a fight of *k* rounds runs *k − 1*
 * round lengths from first line to last, as `measuredPerRound` reads it.
 */
export function harmRounds(
  record: Pick<HarmRecord, 'firstAt' | 'lastAt'>,
  roundMs: number
): number {
  return Math.max(0, record.lastAt - record.firstAt) / roundMs + 1;
}

/**
 * Adds one record into the folds, under its predicted row or its printed
 * name, at the round length stamped on its prediction unless `roundMs` is given.
 */
export function foldHarm(into: Map<string, HarmFold>, record: HarmRecord, roundMs?: number): void {
  const key = record.predicted?.row ?? record.mob ?? '';
  const fold = into.get(key) ?? emptyHarmFold();
  fold.fights += 1;
  if (record.ended === 'died') fold.died += 1;
  if (record.joined) fold.joined += 1;
  const terms = record.predicted?.terms ?? null;
  if (terms !== null && record.mob !== null && record.predicted !== null) {
    const rounds = harmRounds(record, roundMs ?? record.predicted.roundMs);
    fold.rounds += rounds;
    fold.misses += record.misses;
    fold.hits += record.hits;
    fold.meleeDamage += record.meleeDamage;
    fold.casts += record.casts;
    fold.spellDamage += record.spellDamage;
    fold.expected.swings += terms.swings * rounds;
    fold.expected.hits += terms.swings * (terms.lands ?? 0) * rounds;
    fold.expected.meleeDamage += terms.swings * (terms.lands ?? 0) * (terms.perHit ?? 0) * rounds;
    fold.expected.casts += terms.casts * rounds;
    fold.expected.spellDamage += terms.casts * (terms.perCast ?? 0) * rounds;
  }
  into.set(key, fold);
}

/** The terms a fold is read by, in the order a report lists them. */
export const HARM_TERMS = ['swings', 'lands', 'perHit', 'casts', 'perCast'] as const;
export type HarmTerm = (typeof HARM_TERMS)[number];

/** One term of one monster: what the lines showed, what was predicted, and how far apart. */
export interface HarmCheck {
  term: HarmTerm;
  seen: number;
  predicted: number;
  /** How many standard errors apart, signed (seen above predicted is positive); null where the spread is unknown. */
  z: number | null;
}

/**
 * Each term of a fold set against its prediction. Counts (swings, casts a
 * round) are read as Poisson and the landing share as binomial; a damage
 * term has no spread the record keeps, so its `z` is null and the ratio is
 * the reader's.
 */
export function harmChecks(fold: HarmFold): HarmCheck[] {
  const out: HarmCheck[] = [];
  const swings = fold.hits + fold.misses;
  const count = (term: HarmTerm, seen: number, predicted: number): void => {
    if (predicted <= 0 && seen <= 0) return;
    out.push({
      term,
      seen,
      predicted,
      z: predicted > 0 ? (seen - predicted) / Math.sqrt(predicted) : null
    });
  };
  for (const term of HARM_TERMS) {
    switch (term) {
      case 'swings':
        count(term, swings, fold.expected.swings);
        break;
      case 'lands': {
        if (swings === 0 || fold.expected.swings <= 0) break;
        const p = fold.expected.hits / fold.expected.swings;
        const spread = Math.sqrt((p * (1 - p)) / swings);
        out.push({
          term,
          seen: fold.hits / swings,
          predicted: p,
          z: spread > 0 ? (fold.hits / swings - p) / spread : null
        });
        break;
      }
      case 'perHit':
        if (fold.hits > 0 && fold.expected.hits > 0) {
          out.push({
            term,
            seen: fold.meleeDamage / fold.hits,
            predicted: fold.expected.meleeDamage / fold.expected.hits,
            z: null
          });
        }
        break;
      case 'casts':
        count(term, fold.casts, fold.expected.casts);
        break;
      case 'perCast':
        if (fold.casts > 0 && fold.expected.casts > 0) {
          out.push({
            term,
            seen: fold.spellDamage / fold.casts,
            predicted: fold.expected.spellDamage / fold.expected.casts,
            z: null
          });
        }
        break;
      default: {
        const never: never = term;
        throw new Error(`unhandled harm term ${String(never)}`);
      }
    }
  }
  return out;
}
