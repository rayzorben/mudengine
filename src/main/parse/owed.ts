/**
 * The attacks sent and not yet answered by `*Combat Engaged*`, oldest first,
 * and the three things that settle one without an engagement: its echo passed
 * by a prompt and then by a later echo, a guard stepping in, and age.
 *
 * Out of `FightTracker` (todo 763), which asks it what an engagement binds.
 * The rules and the measurements behind them: `mudengine-wire` ›
 * `parts/combat.md` › *An engagement answers the oldest attack still owed one*.
 */
import type { Block } from '../../shared/blocks';
import { mobKey, nameAnswersTo } from '../../shared/world';
import { tuning } from '../app/tuning';

/** How far the server has visibly got with an attack it has not engaged. */
type Heard = 'sent' | 'echoed' | 'passed';

interface Owed {
  /** What followed the verb, as typed; null for a bare verb. */
  aimed: string | null;
  /** The command as sent, which its echo repeats; null for a guard's step (`stepIn`). */
  command: string | null;
  at: number;
  heard: Heard;
  /** The ward a guard took this attack from, in `mobKey` spelling. */
  ward?: string;
}

export class OwedAttacks {
  private owed: readonly Owed[] = [];

  /** An attack went out at `at`: `command` as sent, naming `aimed` or (a bare verb) nothing. */
  sent(command: string, aimed: string | null, at: number): void {
    this.letStaleGo(at);
    this.owed = [...this.owed, { aimed, command, at, heard: 'sent' }];
  }

  /**
   * The echo and the prompt, which answer nothing but say how far the server
   * has got. An attack echoed, then passed by a prompt, then by a later echo is
   * retired: that later echo comes after the attack's answer, and an
   * engagement would have come first. Measured, not derived: GreaterMUD
   * answers a command in the pass it echoes it, Paradigm echoes as it runs,
   * a login burst comes back as bare echoes first, and a broadcast repaints
   * the prompt. Its hole is a command queued behind a move still waiting out
   * its delay (`MoveCommand.cs:40`), whose prompts and later echo can retire
   * an attack before its answer. The oldest owed attack sent as the echoed
   * text is the one marked; the classifier's own pairing drops what it
   * skipped, this does not, and both fall back to the age.
   */
  heard(block: Pick<Block, 'type' | 'text'>): void {
    if (this.owed.length === 0) return;
    if (block.type === 'status-line') {
      this.owed = this.owed.map((o) => (o.heard === 'echoed' ? { ...o, heard: 'passed' } : o));
    } else if (block.type === 'command-echo') {
      const kept = this.owed.filter((o) => o.heard !== 'passed');
      const mine = kept.findIndex((o) => o.heard === 'sent' && o.command === block.text);
      this.owed = kept.map((o, i) => (i === mine ? { ...o, heard: 'echoed' } : o));
    }
  }

  /**
   * `guard moves to protect ward`: the oldest attack owed on the ward (a bare
   * verb's is, since it swings at the last target) now names the guard, as the
   * server's `CurrentTarget` does. A second guard of the same ward replaces
   * the first, as the spell path's loop leaves the last. Whether one was owed.
   */
  redirect(guard: string, ward: string): boolean {
    const key = mobKey(ward);
    const on = (o: Owed): boolean =>
      o.ward !== undefined
        ? o.ward === key
        : o.aimed === null || nameAnswersTo(key, mobKey(o.aimed));
    const index = this.owed.findIndex(on);
    if (index < 0) return false;
    this.owed = this.owed.map((o, i) => (i === index ? { ...o, aimed: guard, ward: key } : o));
    return true;
  }

  /**
   * A guard stepped in front of an attack nothing here owes — a spell's at a
   * monster the room has not listed (`attackAim`) — and the engagement printed
   * behind the sentence (`Player.cs:6138-6188`) is the guard's.
   */
  stepIn(guard: string, ward: string, at: number): void {
    this.owed = [
      // Already read: the sentence proves it, and a prompt follows it
      // (`Player.cs:6139`), so the next echo retires it as it does a refused
      // attack when no engagement comes (763, review).
      { aimed: guard, command: null, at, heard: 'echoed', ward: mobKey(ward) },
      ...this.owed
    ];
  }

  /**
   * `*Combat Engaged*` at `at`: what the oldest owed attack named, which it
   * answers. While a bare verb is owed every binding is a guess — a refused
   * named attack ahead of it would take its engagement — so nothing binds
   * (802, review): refused, not guessed.
   */
  answer(at: number): string | null {
    this.letStaleGo(at);
    const unsure = this.owed.some((o) => o.aimed === null);
    const [owed, ...later] = this.owed;
    this.owed = later;
    return unsure ? null : (owed?.aimed ?? null);
  }

  /** A new session or a closed socket: nothing sent before it is answered after. */
  forget(): void {
    this.owed = [];
  }

  /**
   * Drops the attacks nothing answered inside `tuning.parse.engageBindMs`: a
   * refused attack with no later echo to retire it must not bind the
   * engagement a later command causes.
   */
  private letStaleGo(at: number): void {
    const since = at - tuning().parse.engageBindMs;
    // By age, not by position: a guard's step goes in at the head (763, review).
    this.owed = this.owed.filter((attack) => attack.at >= since);
  }
}
