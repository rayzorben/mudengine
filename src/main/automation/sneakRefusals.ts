/**
 * Sneaks refused in a row (`You don't think you're sneaking.`), and the level
 * they were counted at: at `movement.sneakGiveUp` nothing asks for `sn` until
 * a new connection, a new level or Auto-Sneak on Move turned on again, said
 * once. One count for every asker (the walk's step, the player's own move,
 * the standing ask in `AutoStealth`), fed and configured through the walk
 * (`SneakBeforeStep.onBlock`), which sees every block, walking or not. A low
 * figure is a refusal the sheet cannot show (`SneakCommand.cs` rolls against
 * Stealth less what is in the room), so it is read off the answers.
 * `mudengine-automation` › `parts/walking.md`.
 */
import type { MovementConfig } from '../../shared/config';
import type { NoticeSink } from '../../shared/decisionSettings';
import { t } from '../app/i18n';

/** What an asker reads: whether asking is over for now. */
export interface SneakGiveUp {
  givenUp(level: number | null): boolean;
}

export class SneakRefusals implements SneakGiveUp {
  private count = 0;
  private level: number | null = null;

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
    this.level = null;
  }

  givenUp(level: number | null): boolean {
    if (this.level !== level) {
      this.count = 0;
      this.level = level;
    }
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
