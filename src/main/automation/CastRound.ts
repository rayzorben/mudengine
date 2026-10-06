/**
 * One heal, blessing or cure a round (todo 823). The server gives a character
 * one cast's worth of magic energy a round and refills it on the room's tick,
 * in a fight or out of one; a second cast in the round is answered `You have
 * already cast a spell this round!` (`Player.InitiateSpell`, `Room.DoCombat`,
 * and captures/002 and 056 out of combat). The attack spell is exempt, as
 * `DoMagicRound` refills before casting it. A round begins at the blow that
 * opens it (`RoundBeat`); with no blows it is taken to have passed a round and
 * a margin after the cast. See `mudengine-automation` › parts/recovery.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import type { CastGate } from '../../shared/spellcraft';
import type { SessionModule } from './Module';
import { RoundBeat } from './RoundBeat';

export interface CastRoundEvents {
  /** A cast held for the next round, said once a round. */
  decided?(decision: SafetyDecision): void;
}

export class CastRound implements CastGate, SessionModule {
  /** When this round's cast was spent, by us or as the server's refusal says; null for none yet. */
  private spentAt: number | null = null;
  private roundAt = 0;
  private readonly beat: RoundBeat;
  private saidHeld = false;

  constructor(
    private readonly events: CastRoundEvents = {},
    private readonly now: () => number = () => Date.now(),
    /** The session's figure for the realm's speed (`RealmSpeed`). */
    speed: () => number = () => 1
  ) {
    this.beat = new RoundBeat(speed);
  }

  onBlock(block: Block): void {
    if (this.beat.onBlock(block)) this.roundAt = block.at;
    if (block.type === 'spell-refused') this.spend();
  }

  mayCast(spell: string): boolean {
    if (this.open()) return true;
    if (!this.saidHeld) {
      this.saidHeld = true;
      this.events.decided?.({
        at: this.now(),
        action: 'cast',
        because: spell,
        acted: false,
        refused: t('automation.castRound.held')
      });
    }
    return false;
  }

  noteCast(): void {
    this.spend();
  }

  reset(): void {
    this.spentAt = null;
    this.roundAt = 0;
    this.beat.reset();
    this.saidHeld = false;
  }

  private open(): boolean {
    if (this.spentAt === null || this.roundAt > this.spentAt) return true;
    const round = this.beat.roundMs + tuning().spells.castSlackMs;
    return this.now() - this.spentAt >= round;
  }

  private spend(): void {
    this.spentAt = this.now();
    this.saidHeld = false;
  }
}
