/**
 * Holds a dial to a character that is down to its last few lives until the
 * player answers (todo 07).
 *
 * A reconnect, Connect on Start and pressing Connect all come through here
 * before a socket opens, so nothing reaches the login while automation is on
 * and the character's record says it is at or below `lowLives`. The answer
 * dials (`SessionHost.answerLowLives`). See `mudengine-session` › *A character
 * low on lives is asked about before it is logged in*.
 */
import { t } from '../app/i18n';
import type { KeptLives } from '../../shared/belongings';
import type { LowLivesAsk } from '../../shared/ipc';
import { atLivesFloor, type LowLivesAnswer } from '../../shared/lives';
import type { ConnectionTarget } from '../../shared/types';

/** What an answer dials, and whether automation's master switch goes off first. */
export interface LowLivesDial {
  target: ConnectionTarget;
  switchOff: boolean;
}

export interface LowLivesEvents {
  /** The lives the character's record last read on that realm, or null when never read. */
  livesAt(target: ConnectionTarget): KeptLives | null;
  /** The character's `lowLives`. Read at each dial, so an edit reaches a ladder already running. */
  floor(): number;
  /** Automation's master switch. Off, nothing is held: the player is the one playing. */
  automationOn(): boolean;
  /** Puts the question to the windows. */
  ask(ask: LowLivesAsk): void;
  notice(message: string): void;
}

export class LowLivesHold {
  /** Where the held dial was going, while the question is open. */
  private held: ConnectionTarget | null = null;

  constructor(private readonly events: LowLivesEvents) {}

  /**
   * Whether a dial to `target` waits for the player. When it does, the console
   * says why and the question goes out; asked again, it is asked again. A dial
   * that goes ahead closes any question still open, so a window that was not
   * told cannot answer it later and log in over a live connection.
   */
  holds(target: ConnectionTarget): boolean {
    this.held = null;
    if (!this.events.automationOn()) return false;
    const kept = this.events.livesAt(target);
    const floor = this.events.floor();
    if (kept === null || !atLivesFloor(kept.count, floor)) return false;
    this.held = target;
    this.events.notice(t('session.lowLives.held', { lives: kept.count, floor }));
    this.events.ask({ lives: kept.count, floor, at: kept.at });
    return true;
  }

  /**
   * The player's answer, which closes the question: what to dial, or null for
   * staying offline and for an answer to a question no longer open.
   */
  answered(answer: LowLivesAnswer): LowLivesDial | null {
    const target = this.held;
    this.held = null;
    if (target === null) return null;
    switch (answer) {
      case 'switch-off':
        return { target, switchOff: true };
      case 'log-in':
        return { target, switchOff: false };
      case 'stay':
        this.events.notice(t('session.lowLives.stayed'));
        return null;
      default: {
        const never: never = answer;
        return never;
      }
    }
  }
}
