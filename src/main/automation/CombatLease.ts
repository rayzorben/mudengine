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
 * - **Hit and not moving** (2026-09-23, todo 00): `defendAfterRounds` rounds
 *   of a monster's blows since the last arrival lend it, walking or not, and
 *   the next arrival in another room gives it back. Every hold waits for the
 *   fight to end; with combat off or declined, nothing else ends it.
 *
 * A flip asked for is not a flip made: the file answers on the config's next
 * reload, so `asked` holds the request until `configure` sees it land, and
 * nothing is asked twice. See mudengine-automation › *Auto-combat is lent
 * for a hold and given back on arrival*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';

export interface CombatLeaseEvents {
  /** Write the combat switch into the character's file; whether it was written. */
  flip(on: boolean): boolean;
  notice(message: string): void;
  decided?(decision: SafetyDecision): void;
  /** Whether the journey under way is one the player declined to fight on. */
  declined?(): boolean;
  /**
   * The switch handed back: the off edge the file is about to report is this
   * lease's, not the player's, and the journey's decline is what it was when
   * the switch was lent. See `AutoCombat.leaseReturned`.
   */
  returned?(declined: boolean): void;
}

/** What else has the character, read by the session at the moment it asks. */
export interface DefendFacts {
  /** Under a timed spell the way in put on it: the walk out is the answer. */
  moveOnly: boolean;
  /** An escape chosen or in flight. */
  escaping: boolean;
  /** A typed `break` still in force. */
  stoodDown: boolean;
  /** A move of this client's own is unanswered. */
  movePending: boolean;
  /** Auto-combat would hit back as things stand, journey and all. */
  fighting: boolean;
}

/** Why a lease ended without an arrival. */
export type LeaseEnd = 'died' | 'left' | 'lost' | 'closed';

export class CombatLease {
  private enabled = true;
  private master = true;
  private retaliate = true;
  private fightOnArrival = true;
  private defendAfter = 0;
  /** What was asked of the file and not yet seen back; null when the file is current. */
  private asked: boolean | null = null;
  /** Why combat is on only because this lent it, or null. */
  private lent: 'hold' | 'defend' | null = null;
  /** Whether the journey was declined when the switch was lent, to be put back with it. */
  private declinedAtLend = false;
  /** Rounds of monsters' blows since `arrival`, and when the last blow of the last one came. */
  private rounds = 0;
  private lastBlowAt = 0;
  /** The arrival the rounds are counted from (`RoomState.arrival`). */
  private arrival: number | null = null;
  /**
   * The arrival in which nothing is lent again: the player turned the switch
   * off here, or the file refused the lend. The next arrival asks afresh.
   */
  private stoodBy: number | null = null;
  /** What to say once the switch is handed back, while the file refuses the write. */
  private owed: string | null = null;
  private saidStuck = false;

  constructor(private readonly events: CombatLeaseEvents) {}

  /** Whether combat is on only because this lent it. */
  get lending(): boolean {
    return this.lent !== null;
  }

  /**
   * A reload of the character's file. Answers whether it is this lease's own
   * write landing, so `AutoCombat` does not read the edge as the player's.
   */
  configure(automation: AutomationConfig): boolean {
    const was = this.enabled;
    this.enabled = automation.combat.enabled;
    this.master = automation.enabled;
    this.retaliate = automation.combat.retaliate;
    this.fightOnArrival = automation.movement.fightOnArrival;
    this.defendAfter = automation.combat.defendAfterRounds;
    if (this.asked !== null) {
      // The file caught up with what was asked; a reload that says something
      // else is the player's own edit and outranks the ask.
      const landed = this.enabled === this.asked;
      if (landed || this.enabled !== was) this.asked = null;
      return landed && this.enabled !== was;
    }
    /*
     * Turned off by hand: a lease is over with nothing handed back, and nothing
     * is lent again in this room — the rounds already counted were counted
     * before the player said so (todo 00, on review).
     */
    if (was && !this.enabled) {
      this.lent = null;
      this.owed = null;
      this.saidStuck = false;
      this.rounds = 0;
      this.stoodBy = this.arrival;
    }
    return false;
  }

  /** Every state change: the hold beginning and ending. */
  onCharacter(state: CharacterState, walking: boolean): void {
    if (this.owed !== null) this.settleOwed();
    if (this.asked !== null || this.owed !== null) return;
    const held = state.afflictions.held === 'yes';
    if (held && walking && !this.enabled && this.lent === null) {
      const declined = this.events.declined?.() ?? false;
      if (!this.events.flip(true)) return;
      this.lent = 'hold';
      this.declinedAtLend = declined;
      this.asked = true;
      this.events.notice(t('automation.combat.lentForHold'));
      return;
    }
    if (!held && this.lent === 'hold') this.giveBack(t('automation.combat.returnedAfterHold'));
  }

  /**
   * A monster's blow on this character, hit or miss (`mob-hits`, `mob-misses`
   * the tracker vouched for). Blows closer together than `tuning.combat.roundMs`
   * are one round, as `AutoCombat`'s round beat reads them: the server prints
   * a round's blows together, and it is the printed blows that are counted.
   */
  noteMonsterBlow(at: number): void {
    if (at - this.lastBlowAt > tuning().combat.roundMs) this.rounds += 1;
    this.lastBlowAt = at;
  }

  /**
   * Every state change, after the walker has had it: hit for
   * `defendAfterRounds` rounds without arriving anywhere, with combat off,
   * lends it; the next arrival in another room gives it back.
   *
   * After the walker, so a route arriving on the same state has already
   * decided through `onWalkEnded` whether its destination keeps combat on.
   */
  defend(state: CharacterState, facts: DefendFacts, now = Date.now()): void {
    const arrival = state.room.arrival;
    if (arrival !== this.arrival) {
      this.arrival = arrival;
      this.rounds = 0;
      this.stoodBy = null;
      if (this.lent === 'defend' && this.owed === null) {
        this.giveBack(t('automation.combat.returnedAfterMove'));
      }
    }
    if (this.owed !== null) this.settleOwed(now);
    if (this.lent !== null || this.asked !== null || this.stoodBy === arrival) return;
    if (this.defendAfter <= 0 || this.rounds < this.defendAfter) return;
    // The file is on: nothing to lend. A declined journey beside a switch
    // that reads on is the half second a run's write takes to land.
    if (this.enabled) return;
    if (!this.master || !this.retaliate) return;
    if (state.phase !== 'in-game' || state.mortallyWounded) return;
    if (facts.fighting || facts.moveOnly || facts.escaping) return;
    if (facts.stoodDown || facts.movePending) return;
    const declined = this.events.declined?.() ?? false;
    const because = t('automation.combat.defendBecause', { rounds: this.rounds });
    if (!this.events.flip(true)) {
      this.events.decided?.({
        at: now,
        action: 'defend',
        because,
        acted: false,
        refused: t('automation.combat.defendUnwritable')
      });
      // Said once: nothing is asked again until the next arrival.
      this.stoodBy = arrival;
      return;
    }
    this.lent = 'defend';
    this.declinedAtLend = declined;
    this.asked = true;
    this.events.notice(
      this.rounds === 1
        ? t('automation.combat.lentForDefence.one', { rounds: this.rounds })
        : t('automation.combat.lentForDefence.many', { rounds: this.rounds })
    );
    this.events.decided?.({ at: now, action: 'defend', because, acted: true });
  }

  /**
   * The character died, left the realm or lost the connection with combat
   * lent: the flip is in the player's file, so it is handed back now rather
   * than left on for a session that is not running.
   */
  end(why: LeaseEnd): void {
    if (this.lent === null || this.owed !== null) return;
    this.giveBack(
      why === 'died'
        ? t('automation.combat.returnedAfterDeath')
        : why === 'left'
          ? t('automation.combat.returnedAfterLeaving')
          : why === 'closed'
            ? t('automation.combat.returnedAfterClose')
            : t('automation.combat.returnedAfterLoss')
    );
  }

  private giveBack(said: string): void {
    this.owed = said;
    this.settleOwed();
  }

  /**
   * Hands the switch back, or says once that the file will not take it and
   * keeps the lease to try again on the next state: a give-back dropped in
   * silence leaves auto-combat on in the player's file for every session
   * after this one (todo 00, on review).
   */
  private settleOwed(now = Date.now()): void {
    const said = this.owed;
    if (said === null) return;
    if (!this.events.flip(false)) {
      if (this.saidStuck) return;
      this.saidStuck = true;
      this.events.notice(t('automation.combat.returnStuck'));
      this.events.decided?.({
        at: now,
        action: 'defend',
        because: said,
        acted: false,
        refused: t('automation.combat.returnUnwritable')
      });
      return;
    }
    this.lent = null;
    this.owed = null;
    this.saidStuck = false;
    this.rounds = 0;
    this.asked = false;
    this.events.returned?.(this.declinedAtLend);
    this.events.notice(said);
  }

  /**
   * A walk ended. `asked` is whether the player asked for it — a route, not a
   * loop's leg or an errand — `arrived` whether it reached its end, and `run`
   * whether it was asked for with *Run it*, whose arrival hands nothing back.
   */
  onWalkEnded(arrived: boolean, asked: boolean, run = false): void {
    if (!arrived || !asked || run || !this.fightOnArrival) return;
    // Arrived while lent: the destination wants it on, so it stays.
    if (this.lent !== null) {
      this.lent = null;
      this.owed = null;
      this.saidStuck = false;
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
    this.lent = null;
    this.owed = null;
    this.saidStuck = false;
    if (!(this.asked ?? this.enabled)) return true;
    if (!this.events.flip(false)) return false;
    this.asked = false;
    return true;
  }

  reset(): void {
    if (this.lent !== null && this.owed === null) {
      this.giveBack(t('automation.combat.returnedAtReset'));
    }
    this.rounds = 0;
    this.lastBlowAt = 0;
    this.arrival = null;
    this.stoodBy = null;
    // A give-back the file still refuses outlives the session it was lent in.
    if (this.owed !== null) return;
    this.asked = null;
    this.lent = null;
  }
}
