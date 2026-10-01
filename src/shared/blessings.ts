/**
 * The blessings kept up on this character and its party, as the options file
 * states them (`automation.spells.blessings`): the row's shape and how a row
 * is read. Out of `config.ts` (todo 20) the way `loops.ts` and `mobRules.ts`
 * are; `Blessings` (`src/main/automation/`) casts them.
 *
 * Dependency-free like everything in `shared/`.
 */
import { bool, fraction, int, isRecord, str } from './values';

/** Whom a blessing is cast on: this character, or every listed party member. */
export const BLESSING_TARGETS = ['self', 'party'] as const;

export type BlessingTarget = (typeof BLESSING_TARGETS)[number];

export interface BlessingConfig {
  /**
   * The whole spell name, as `c` wants it — and the row's identity: the key
   * it is coalesced and remembered by. There is deliberately no separate
   * display name. The list first shipped with one, and the first person to
   * use it typed the spell into the name box, left the spell box empty, and
   * lost the row to the silent no-spell filter below — two words for one
   * thing is a form that invites exactly that.
   */
  spell: string;
  target: BlessingTarget;
  /** Fraction of maximum mana below which this blessing waits. 0 never waits. */
  minMana: number;
  /**
   * Recast this before healing when both are due — for the shield a caster
   * dies without. Default off: a heal answers a number that is already bad.
   */
  prioritizeOverHeal: boolean;
  /**
   * Allow the recast mid-fight, in the combat band. Off, it waits for
   * `*Combat Off*`. Defaults on for `self` and off for `party` when absent,
   * because a follower's shield mid-fight is its own business and a cast on
   * somebody else's round is a command the fight paid for.
   */
  inCombat: boolean;
  /**
   * Party rows only: the recast interval, since a member's wear-off lands on
   * *their* screen (the `@bless-expired` notification, where both ends run
   * mudengine, is what upgrades that to event-driven). Absent on a self row
   * and ignored there: the character's own wear-off frames drive the recast,
   * and the watchdog behind unreadable endings is the duration *measured*
   * from earlier cast→wear-off pairs — never the realm's `Dur` column, whose
   * units nothing on hand establishes, and never a number typed here.
   */
  fallbackSeconds?: number;
}

/** The floor on a blessing's fallback clock: a typo must not cast every tick. */
export const BLESSING_FALLBACK_MIN_S = 30;
/** More blessings than this is a list nobody typed. */
const MAX_BLESSINGS = 16;

/**
 * A blessing without a spell is dropped rather than defaulted: the spell is
 * both what is sent and the key the row is coalesced and remembered by, and
 * it has no value that means anything when absent. Two rows naming one spell
 * **and one target** are one row — the first wins, since the order is the
 * priority. The same spell on `self` and on `party` is two legitimate rows:
 * they recast on different mechanisms (the wear-off frame against the
 * member's clock), and folding them would silently drop whichever was typed
 * second. `inCombat` defaults by target — a self-shield mid-fight is the
 * point, a cast on somebody else's round is a command the fight paid for —
 * and the fallback clock exists only on party rows: a self row's watchdog is
 * measured, not configured.
 */
export function normalizeBlessings(value: unknown): BlessingConfig[] {
  if (!Array.isArray(value)) return [];
  const blessings: BlessingConfig[] = [];
  for (const entry of value) {
    if (blessings.length >= MAX_BLESSINGS) break;
    if (!isRecord(entry)) continue;
    const spell = str(entry['spell'], '').trim();
    if (spell.length === 0) continue;
    const target: BlessingTarget = entry['target'] === 'party' ? 'party' : 'self';
    if (
      blessings.some(
        (row) => row.spell.toLowerCase() === spell.toLowerCase() && row.target === target
      )
    )
      continue;
    blessings.push({
      spell,
      target,
      minMana: fraction(entry['minMana'], 0),
      prioritizeOverHeal: bool(entry['prioritizeOverHeal'], false),
      inCombat: bool(entry['inCombat'], target === 'self'),
      ...(target === 'party'
        ? { fallbackSeconds: int(entry['fallbackSeconds'], 300, BLESSING_FALLBACK_MIN_S, 86_400) }
        : {})
    });
  }
  return blessings;
}
