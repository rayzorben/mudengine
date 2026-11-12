/**
 * The attack a fight is fought with when `combat.attack` is blank (todo 47):
 * the attack with the most damage a round that lands, out of what the class
 * and race rows allow (`attackOptions`). A typed word is the player's and
 * always wins. No opener is chosen: a blank `combat.opener` is none
 * (the user, 2026-11-12, Yang backstabbing while sneaking with none set).
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

/** What blank `combat.attack` chooses, for the Combat page (`world:attack`). */
export interface ChosenWords {
  attack: AttackChoice;
}

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
