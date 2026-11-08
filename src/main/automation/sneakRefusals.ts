/**
 * Sneaks refused in a row (`You don't think you're sneaking.`), and the level
 * and Stealth they were counted at: at `movement.sneakGiveUp` nothing asks for
 * `sn` until a new connection, a new level, a new Stealth figure on the sheet
 * (dropping a load: Rayzor, Heavy at -63, gave up and never sneaked again at
 * 64, 2026-11-08) or Auto-Sneak on Move turned on again, said once. One
 * count for every asker (the walk's step, the player's own move, the standing
 * ask in `AutoStealth`), fed and configured through the walk
 * (`SneakBeforeStep.onBlock`), which sees every block, walking or not. A low
 * figure is a refusal the sheet cannot show (`SneakCommand.cs` rolls against
 * Stealth less what is in the room), so it is read off the answers.
 * `mudengine-automation` › `parts/walking.md`.
 */
import type { MovementConfig } from '../../shared/config';
import type { Progress } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import { t } from '../app/i18n';

/** What an asker reads: whether asking is over for now. */
export interface SneakGiveUp {
  givenUp(progress: Basis): boolean;
}

/** What the refusals were counted against; a change in either counts afresh. */
type Basis = Pick<Progress, 'level' | 'stealthSkill'>;

export class SneakRefusals implements SneakGiveUp {
  private count = 0;
  private basis: Basis | null = null;

  constructor(
    private movement: Pick<MovementConfig, 'sneak' | 'sneakGiveUp'>,
    private readonly notice?: NoticeSink
  ) {}

  /** Auto-Sneak on Move turned on (toolbar, settings, `@auto-sneak on`) starts the count again. */
  configure(movement: Pick<MovementConfig, 'sneak' | 'sneakGiveUp'>): void {
    if (movement.sneak && !this.movement.sneak) this.reset();
    this.movement = movement;
  }

  /** A new connection, possibly another server. */
  reset(): void {
    this.count = 0;
    this.basis = null;
  }

  givenUp({ level, stealthSkill }: Basis): boolean {
    const basis = this.basis;
    // The first reading only records what the refusals so far were counted at.
    if (basis !== null && (basis.level !== level || basis.stealthSkill !== stealthSkill)) {
      this.count = 0;
    }
    this.basis = { level, stealthSkill };
    return this.count >= this.movement.sneakGiveUp;
  }

  /** One more sneak refused; at the limit, said once. */
  refused(): void {
    this.count += 1;
    if (this.count !== this.movement.sneakGiveUp) return;
    this.notice?.(t('automation.walk.sneakGaveUp', { count: this.count }), 'walk-sneak');
  }

  /** A move printed `Sneaking...`: the refusals are no longer in a row. */
  sneaked(): void {
    if (this.count < this.movement.sneakGiveUp) this.count = 0;
  }
}
