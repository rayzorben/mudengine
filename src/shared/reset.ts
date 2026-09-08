/**
 * Noticing that a character is not the character this client remembers.
 *
 * A player who deletes a character and makes a new one on the same account
 * keeps the name — the name is the login — so nothing about the connection
 * changes. What changes is the *character*: a different race, a different
 * class, level 1 after level 34, an experience figure a fraction of what it
 * was. Every record this client keeps against that name is then about somebody
 * who no longer exists: a vault balance, a loadout of kit that is gone, a
 * spellbook, a map of corridors, a quest counter.
 *
 * **This only ever reports.** Nothing here deletes anything, and nothing acts
 * on a signal: the client cannot tell a reset from a server that renumbered its
 * classes, and throwing away the only copy of what somebody learned is not a
 * decision to take from a heuristic. It says what it noticed, shows both
 * characters side by side, and asks.
 *
 * Dependency-free like the rest of `shared/`: main compares, the renderer draws.
 */
import type { CharacterState } from './character';

/** What was noticed. One per signal, so the prompt can say all of them. */
export const RESET_SIGNALS = ['race', 'class', 'level', 'experience'] as const;
export type ResetSignal = (typeof RESET_SIGNALS)[number];

/**
 * The half of a character that says *which* character it is.
 *
 * Four facts, and every one of them nullable, because every one arrives from a
 * different line and some never arrive at all. A null on either side is
 * **unknown**, and unknown never signals — the standing rule, and here it is
 * load-bearing: a stat sheet nobody has read would otherwise look exactly like
 * a class that changed.
 */
export interface CharacterIdentity {
  race: string | null;
  className: string | null;
  level: number | null;
  exp: number | null;
  /** When this was last true, so the prompt can say how old the record is. */
  at: number;
}

/** What the wire has said about who this is. Null while it has said nothing. */
export function identityOf(state: CharacterState, at: number): CharacterIdentity | null {
  const identity: CharacterIdentity = {
    race: state.race,
    className: state.className,
    level: state.progress.level,
    exp: state.progress.exp,
    at
  };
  const said =
    identity.race !== null ||
    identity.className !== null ||
    identity.level !== null ||
    identity.exp !== null;
  return said ? identity : null;
}

/**
 * What changed between the character this client remembers and the one in the
 * realm now, as reasons to suspect a reset.
 *
 * - **Race or class changed.** Neither is a thing a character does; the realm
 *   has no command for either. Both known and different is the strongest signal
 *   there is.
 * - **Level 1 after higher.** A death costs a life, not a level; nothing in
 *   this family walks a character back to 1.
 * - **Experience fell by more than a share of what it was.** A death does cost
 *   experience, so this is the one signal that has an innocent explanation —
 *   which is why it is a *share* rather than any drop at all, and why it is the
 *   weakest of the four.
 *
 * Every comparison refuses on a null. An empty answer is *nothing noticed*,
 * never *the same character*.
 */
export function resetSignals(
  before: CharacterIdentity,
  after: CharacterIdentity,
  expDropShare: number
): ResetSignal[] {
  const signals: ResetSignal[] = [];

  if (before.race !== null && after.race !== null && !sameWord(before.race, after.race)) {
    signals.push('race');
  }
  if (
    before.className !== null &&
    after.className !== null &&
    !sameWord(before.className, after.className)
  ) {
    signals.push('class');
  }
  if (before.level !== null && after.level !== null && before.level > 1 && after.level === 1) {
    signals.push('level');
  }
  if (
    before.exp !== null &&
    after.exp !== null &&
    before.exp > 0 &&
    expDropShare > 0 &&
    after.exp < before.exp * (1 - expDropShare)
  ) {
    signals.push('experience');
  }

  return signals;
}

/**
 * Case and spacing are the realm's, not the player's.
 *
 * `Battlemage` and `battlemage` are one class; a class printed on the sheet and
 * the same class printed on the roster differ by whitespace often enough that
 * comparing raw strings would raise the strongest signal there is on a
 * formatting change.
 */
function sameWord(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Whether the two identities describe anything at all worth comparing. */
export function comparable(identity: CharacterIdentity): boolean {
  return (
    identity.race !== null ||
    identity.className !== null ||
    identity.level !== null ||
    identity.exp !== null
  );
}
