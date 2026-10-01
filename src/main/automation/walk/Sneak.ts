/**
 * Ahead of the next step, when the character is meant to be sneaking and is
 * not.
 *
 * **Immediately before the step, every step, and that is the whole point.**
 * What it decides is whether the things in the *next* room notice the
 * arrival, so the only moment it can be decided from is the one the step
 * goes out in. This used to be asked in two places — once before a route's
 * first step and once when a hold let go — and that left the two cases the
 * walk provokes itself uncovered:
 *
 * - **A retry behind a door.** Picking or opening a barrier breaks stealth
 *   silently (`Door.cs`; the client now reads it, see
 *   `StealthReceipt.broke`), and the retry is not a fresh send, so
 *   nothing asked again. Reported 2026-09-11 as a character that sneaked,
 *   walked into a shut door, picked it, opened it and stepped through in
 *   plain sight.
 * - **Every ordinary step after the first.** A fight, a rest and equipping
 *   all break stealth, and a route's second step inherited whatever the
 *   first believed.
 *
 * Called from `Walker.sendCurrent` after `beforeStep`, so a torch readied for the
 * next room cannot break the stealth this just asked for: the two share the
 * `movement` band and the arbiter keeps a band in order. Coalesced, so a
 * retry that asks again while the first `sn` is still queued is one
 * command.
 *
 * `Stealth` is three-state for the reason this needs: `unknown` means nobody
 * has said, which is not `sneaking`, and a character that believes it is
 * hidden and is not walks into a lair in the open.
 */
import type { CommandQueue } from '../CommandQueue';
import type { CharacterState } from '../../../shared/character';
import { t } from '../../app/i18n';
import { tuning } from '../../app/tuning';
import type { WalkerEvents } from './ports';

export class SneakBeforeStep {
  /** Whether *Stealth 0, not sneaking* has been said this session. */
  private saidNoStealth = false;
  /**
   * Sneaks refused in a row (`You don't think you're sneaking.`), and the
   * level they were counted at: at `tuning.walk.sneakGiveUp` the walk stops
   * asking until a new connection or a new level, said once. A low figure is
   * a refusal the sheet cannot show (`SneakCommand.cs` rolls against Stealth
   * less what is in the room), so it is read off the answers.
   */
  private sneakRefusals = { count: 0, level: null as number | null };

  constructor(
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    private readonly events: Pick<WalkerEvents, 'notice'>,
    /** A room the server refuses `sn` in (`cannotSneakHere`). */
    private readonly blocked: (state: CharacterState) => boolean
  ) {}

  /** A new connection, possibly another server: everything counted starts again. */
  reset(): void {
    this.sneakRefusals = { count: 0, level: null };
  }

  ask(state: CharacterState, wanted: boolean): void {
    if (!wanted) return;
    // Sneaking, by the tracker's own reading: the refusals in a row are over.
    if (state.stealth === 'sneaking') {
      if (this.sneakRefusals.count < tuning().walk.sneakGiveUp) this.sneakRefusals.count = 0;
      return;
    }
    /*
     * **A sheet that says `Stealth: 0` is never asked to sneak** (todo 104).
     * `SneakCommand.cs` rolls `Stealth − (players − 1 + mobs) ≥ rand(1,100)`,
     * so a figure of zero never passes — and a Mage rerolled from a Ninja
     * kept `movement.sneak` and spent one refused `sn` on every step of every
     * lap. The figure is the sheet's own column; an unread sheet (null) never
     * refuses, and a Ninja whose figure is low is still asked every step.
     */
    if (state.progress.stealthSkill === 0) {
      if (!this.saidNoStealth) {
        this.saidNoStealth = true;
        this.events.notice?.(t('automation.walk.sneakNoSkill'));
      }
      return;
    }
    if (this.blocked(state)) return;
    // Refused too often in a row at this level: stopped until it changes.
    if (this.sneakRefusals.level !== state.progress.level) {
      this.sneakRefusals = { count: 0, level: state.progress.level };
    }
    if (this.sneakRefusals.count >= tuning().walk.sneakGiveUp) return;
    this.queue.enqueue({
      command: 'sn',
      priority: 'movement',
      coalesceKey: 'sneak',
      reason: t('automation.walk.reasonSneak')
    });
  }

  /** One more sneak refused; at the limit, said once. See `sneakRefusals`. */
  refused(): void {
    this.sneakRefusals.count += 1;
    if (this.sneakRefusals.count !== tuning().walk.sneakGiveUp) return;
    this.events.notice?.(t('automation.walk.sneakGaveUp', { count: this.sneakRefusals.count }));
  }
}
