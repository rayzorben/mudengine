/**
 * A blessing in a fight goes in the off-round (the user, 2026-11-21). The
 * cast ends the attack (`*Combat Off*`) and the attack is sent again behind
 * it, so one sent just before a round can leave that attack late for the
 * round. Cretin's mageshield went 1.0 s before a round and 0.35 s before
 * another. In a fight the cast waits for the round's blows and goes in the
 * first `spells.blessOffRoundShare` of the round after them
 * (`blessGoesNow`); out of a fight, or before any round is seen, it is not
 * timed. A hold is one `SafetyDecision` a round. See `mudengine-automation` ›
 * parts/recovery.md › *A blessing in a fight goes in the off-round*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import { blessGoesNow } from '../../shared/roundTiming';
import type { CastGate } from '../../shared/spellcraft';
import type { RoundClock } from './RoundClock';

export interface BlessRoundEvents {
  /** A blessing held for the round, said once a round. */
  decided?(decision: SafetyDecision): void;
}

export class BlessRound implements CastGate {
  /** The round a hold was last said for, so a hold is said once for each round waited for. */
  private saidFor: number | null = null;

  constructor(
    /** The one heal, blessing or cure a round (`CastRound`), asked once the round allows. */
    private readonly inner: CastGate,
    private readonly rounds: Pick<RoundClock, 'next'>,
    /** A fight running or asked for (`fightHere`). */
    private readonly fighting: () => boolean,
    private readonly events: BlessRoundEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  mayCast(spell: string): boolean {
    return !this.held(spell) && this.inner.mayCast(spell);
  }

  noteCast(): void {
    this.inner.noteCast();
  }

  noteFumbled(): void {
    this.inner.noteFumbled();
  }

  private held(spell: string): boolean {
    if (!this.fighting()) return false;
    const now = this.now();
    const next = this.rounds.next(now);
    if (!next.known) return false;
    const share = tuning().spells.blessOffRoundShare;
    if (blessGoesNow(now - next.seenAt, next.at - now, next.periodMs, share)) return false;
    if (this.saidFor !== next.at) {
      this.saidFor = next.at;
      this.events.decided?.({
        at: now,
        action: 'cast',
        because: spell,
        acted: false,
        refused: t('automation.blessRound.held')
      });
    }
    return true;
  }
}
