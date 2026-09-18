/**
 * Auto-combat lent for a hold, and given back on arrival (todos 07 and 11).
 *
 * The switch is the character's own file — the toolbar reads it and
 * `SettingsEditor.setAutomationSwitch` writes it, so there is no second copy
 * of *is auto-combat on* — and this module asks for the file to be flipped
 * rather than keeping a session-scoped override the toolbar could not show.
 * Two flips:
 *
 * - **Held on a walk with combat off**: a held character cannot step and is
 *   being hit, so combat is *lent* until the hold wears off, then handed back
 *   — the walk resumes as it was asked for. The player turning the switch
 *   off themselves during the lease ends it: the file is theirs.
 * - **A route the player asked for arrives** with combat off: walking with it
 *   off is how somebody gets somewhere without fighting on the way, and on
 *   arrival that reason is gone (`movement.fightOnArrival`). A loop's leg
 *   and an errand are not journeys with an arrival in them.
 * - **Run it** (todo 06): the switch off before the first step, and the
 *   arrival hands nothing back — the one asked-for walk that declines the
 *   second flip. A hold on the way still lends and returns.
 *
 * A flip asked for is not a flip made: the file answers on the config's next
 * reload, so `asked` holds the request until `configure` sees it land, and
 * nothing is asked twice. See mudengine-automation › *Auto-combat is lent
 * for a hold and given back on arrival*.
 */
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';

export interface CombatLeaseEvents {
  /** Write the combat switch into the character's file; whether it was written. */
  flip(on: boolean): boolean;
  notice(message: string): void;
}

export class CombatLease {
  private enabled = true;
  private fightOnArrival = true;
  /** What was asked of the file and not yet seen back; null when the file is current. */
  private asked: boolean | null = null;
  /** Whether combat is on only because a hold lent it. */
  private lent = false;

  constructor(private readonly events: CombatLeaseEvents) {}

  configure(automation: AutomationConfig): void {
    const was = this.enabled;
    this.enabled = automation.combat.enabled;
    this.fightOnArrival = automation.movement.fightOnArrival;
    if (this.asked !== null) {
      // The file caught up with what was asked; a reload that says something
      // else is the player's own edit and outranks the ask.
      if (this.enabled === this.asked || this.enabled !== was) this.asked = null;
      return;
    }
    // Turned off by hand while lent: the lease is over and nothing is handed back.
    if (this.lent && was && !this.enabled) this.lent = false;
  }

  /** Every state change: the hold beginning and ending. */
  onCharacter(state: CharacterState, walking: boolean): void {
    if (this.asked !== null) return;
    const held = state.afflictions.held === 'yes';
    if (held && walking && !this.enabled && !this.lent) {
      if (!this.events.flip(true)) return;
      this.lent = true;
      this.asked = true;
      this.events.notice(t('automation.combat.lentForHold'));
      return;
    }
    if (!held && this.lent) {
      if (!this.events.flip(false)) return;
      this.lent = false;
      this.asked = false;
      this.events.notice(t('automation.combat.returnedAfterHold'));
    }
  }

  /**
   * A walk ended. `asked` is whether the player asked for it — a route, not a
   * loop's leg or an errand — `arrived` whether it reached its end, and `run`
   * whether it was asked for with *Run it*, whose arrival hands nothing back.
   */
  onWalkEnded(arrived: boolean, asked: boolean, run = false): void {
    if (!arrived || !asked || run || !this.fightOnArrival) return;
    // Arrived while lent for a hold: the destination wants it on, so it stays.
    if (this.lent) {
      this.lent = false;
      return;
    }
    if (this.enabled || this.asked !== null) return;
    if (!this.events.flip(true)) return;
    this.asked = true;
    this.events.notice(t('automation.combat.backOnArrival'));
  }

  /**
   * *Run it* (todo 06): the switch off before the first step, and left off.
   *
   * Written only where the file says on, or is about to — `asked` is the
   * pending truth — so a run pressed with the switch already off asks nothing,
   * and a lend still in flight is overtaken rather than waited for. Whatever a
   * hold lent before this press is not handed back afterwards: the player has
   * just said what the switch should read. Answers whether it could be written.
   */
  run(): boolean {
    this.lent = false;
    if (!(this.asked ?? this.enabled)) return true;
    if (!this.events.flip(false)) return false;
    this.asked = false;
    return true;
  }

  reset(): void {
    this.asked = null;
    this.lent = false;
  }
}
