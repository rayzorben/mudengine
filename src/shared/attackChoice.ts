/**
 * The attack and the opener a fight is fought with when `combat.attack` and
 * `combat.opener` are blank (todo 47): the attack with the most damage a round
 * that lands, out of what the class and race rows allow (`attackOptions`), and
 * a backstab to open with where the class row grants hiding and the hand can
 * backstab. A typed word is the player's and always wins. `ju` is never chosen
 * as an opener: where a jumpkick is the best round it is the attack already.
 */
import { PLAIN_ATTACK_VERB, type AttackOption } from './attackOptions';

/** Why the word is the word: typed by the player, the best round priced, or nothing priced. */
export type AttackChoiceWhy = 'typed' | 'best' | 'unpriced';

export interface AttackChoice {
  verb: string;
  why: AttackChoiceWhy;
  /** The chosen attack's damage a round where `why` is `best`; null otherwise. */
  perRound: number | null;
}

/** What blank `combat.attack` and `combat.opener` choose, for the Combat page (`world:attack`). */
export interface ChosenWords {
  attack: AttackChoice;
  /** `bs`, or blank for none. */
  opener: string;
}

/** The only opener chosen for the player: the command table's one spelling of `BackStab`. */
export const BACKSTAB_VERB = 'bs';

/**
 * `typed` where the player typed one, else the option whose round lands the
 * most, the earlier in `attackOptions`' order on a tie (so the plain attack
 * keeps a draw). Nothing priced is the plain attack: an unread sheet or a
 * monster nobody can place says nothing about which hits harder.
 */
export function chooseAttack(typed: string, options: readonly AttackOption[]): AttackChoice {
  const word = typed.trim();
  if (word.length > 0) return { verb: word, why: 'typed', perRound: null };
  let best: AttackOption | null = null;
  for (const option of options) {
    const value = option.perRound?.value;
    if (value === undefined) continue;
    if (best === null || value > (best.perRound?.value ?? -Infinity)) best = option;
  }
  return best === null
    ? { verb: PLAIN_ATTACK_VERB, why: 'unpriced', perRound: null }
    : { verb: best.verb, why: 'best', perRound: best.perRound?.value ?? null };
}

/**
 * `typed` where the player typed one, else `bs` where the class row grants
 * hiding (`ClassStealth`) and the hand can backstab (`backstabsWith`), else
 * none. Hiding unknown chooses none: a backstab the class can never land is a
 * round thrown away, and `AutoCombat.opener` drops it out loud anyway. A hand
 * of unknown kind is let through, as the survey credits it.
 *
 * `outdone` is a backstab blow worth less than a plain round before armour
 * (todo 76): the backstab round is that one blow, so the plain round opens
 * instead. Unknown on either side keeps the backstab.
 */
export function chooseOpener(
  typed: string,
  can: { hides: boolean | null; backstabs: boolean | null; outdone?: boolean }
): string {
  const word = typed.trim();
  if (word.length > 0) return word;
  return can.hides === true && can.backstabs !== false && can.outdone !== true ? BACKSTAB_VERB : '';
}
