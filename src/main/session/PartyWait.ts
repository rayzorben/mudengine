/**
 * A leader waiting for its party (todo 831): the members who said `@wait` and
 * the ones under `party.waitBelow`, one stop of the lap for all of them, and
 * one clock that gives the wait up after `party.waitMinutes` (MegaMUD's
 * *If Leading Wait No Longer Than*). `Travel` owns the stop and the walk on;
 * this owns why the lap waits and for how long. See `mudengine-automation` ›
 * parts/remotes.md.
 */
import { t } from '../app/i18n';
import { membersBelow, type CharacterState } from '../../shared/character';
import type { LoopProgress } from '../../shared/loops';

/**
 * Why the party waits for a member: it said `@wait`, or its health is under
 * `party.waitBelow`. Kept apart so a member's `@ok` does not end a wait its
 * health still asks for.
 */
export type PaceReason = 'asked' | 'hurt';

export interface PartyWaitMoves {
  /** Stop the running lap, saying `why`; false where no lap was running. */
  pauseLap(why: string): boolean;
  /** Whether the lap is stopped, so walking on has something to resume. */
  lapStopped(): boolean;
  /** Walk the lap on again, said out loud where it cannot. */
  resumeLap(who: string): void;
  notice(message: string): void;
  /** `party.waitMinutes`, read when a wait begins; 0 waits for ever. */
  waitMinutes(): number;
}

export class PartyWait {
  /** Who the party waits for, by reason and lower-cased name, as each spelled it. */
  private readonly waiting = new Map<string, string>();
  /** Whether the lap's current stop is this wait's own: only that is walked on from. */
  private paused = false;
  /** Hurt members a wait gave up on, until they are over the line or gone (`giveUp`). */
  private readonly givenUp = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly moves: PartyWaitMoves) {}

  /** Whether the lap is stopped for the party. */
  get holding(): boolean {
    return this.paused;
  }

  /**
   * Leading, the members here under `waitBelow`, re-read from every state
   * (MegaMUD's *Wait For Party Members*): a hurt member is a reason to wait,
   * as its `@wait` is, and a lap started while one is still hurt stops for it.
   */
  onCharacter(state: CharacterState, waitBelow: number): void {
    const hurt = state.party.following === null ? membersBelow(state, waitBelow) : [];
    const now = new Set(hurt.map((name) => `hurt:${name.toLowerCase()}`));
    for (const [key, name] of [...this.waiting]) {
      if (key.startsWith('hurt:') && !now.has(key)) this.pace(name, true, 'hurt');
    }
    for (const key of [...this.givenUp]) if (!now.has(key)) this.givenUp.delete(key);
    for (const name of hurt) {
      if (!this.givenUp.has(`hurt:${name.toLowerCase()}`)) this.pace(name, false, 'hurt');
    }
  }

  /** A member asked to wait or said it is ready, or its health did (`PaceReason`). */
  pace(who: string, ready: boolean, why: PaceReason): void {
    const key = `${why}:${who.toLowerCase()}`;
    if (!ready) {
      this.waiting.set(key, who);
      const said =
        why === 'hurt'
          ? t('session.loop.pausedForHealth', { who })
          : t('session.loop.pausedForRemote', { who });
      if (this.paused || !this.moves.pauseLap(said)) return;
      this.paused = true;
      this.arm();
      return;
    }
    this.waiting.delete(key);
    if (this.waiting.size > 0 || !this.paused || !this.moves.lapStopped()) return;
    this.end();
    this.moves.resumeLap(who);
  }

  /**
   * The lap published: a lap no longer stopped has ended the wait, however it
   * did. Walked on by hand while the wait held it, the player chose to go:
   * the members hurt then are not waited for again until they recover.
   */
  noteLap(progress: LoopProgress): void {
    if (progress.status === 'stopped') return;
    if (this.paused) this.giveUpOnHurt();
    this.end();
  }

  /** The stop is no longer this wait's to end (a death stopped the lap too). */
  end(): void {
    this.paused = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** On connect, and when the session ends: a wait from a session that ended holds nothing. */
  forget(): void {
    this.waiting.clear();
    this.givenUp.clear();
    this.end();
  }

  /** The hurt members waited for now are not waited for again until they recover. */
  private giveUpOnHurt(): void {
    for (const key of [...this.waiting.keys()]) {
      if (!key.startsWith('hurt:')) continue;
      this.givenUp.add(key);
      this.waiting.delete(key);
    }
  }

  private arm(): void {
    const minutes = this.moves.waitMinutes();
    if (minutes <= 0) return;
    this.timer = setTimeout(() => this.giveUp(minutes), minutes * 60_000);
    this.timer.unref?.();
  }

  /** The wait ran past its limit: walk on, and say for whom it gave up. */
  private giveUp(minutes: number): void {
    this.timer = null;
    if (!this.paused) return;
    const who = [...new Set(this.waiting.values())];
    this.giveUpOnHurt();
    this.waiting.clear();
    this.paused = false;
    this.moves.notice(t('session.loop.partyWaitGaveUp', { minutes, who: who.join(', ') }));
    if (this.moves.lapStopped()) this.moves.resumeLap(who[0] ?? '');
  }
}
