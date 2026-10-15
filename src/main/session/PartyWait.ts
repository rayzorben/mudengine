/**
 * A leader waiting for its party (todo 831): the members who said `@wait`, the
 * ones under `party.waitBelow`, and under `party.manageParty` the ones under
 * this character's own rest floors until they are back over its resume line,
 * one stop of the lap for all of them, and one clock that gives the wait up
 * after `party.waitMinutes` (MegaMUD's *If Leading Wait No Longer Than*).
 * `Travel` owns the stop and the walk on; this owns why the lap waits and for
 * how long. See `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { membersBelow, type CharacterState } from '../../shared/character';
import { membersStill, type HealthConfig } from '../../shared/config';
import type { LoopProgress } from '../../shared/loops';
import type { NoticeSink } from '../../shared/decisionSettings';

/**
 * Why the party waits for a member: it said `@wait`, its health is under
 * `party.waitBelow` (`hurt`), or it is under this character's own rest floors
 * (`low`, `manageParty`). Kept apart so a member's `@ok` does not end a wait
 * its health still asks for.
 */
export type PaceReason = 'asked' | 'hurt' | 'low';

/** A wait that comes and goes with a member's bar, not with what it said. */
const BAR_REASONS = ['hurt', 'low'] as const satisfies readonly PaceReason[];

/** The leader's own floors, when it holds the party to them (`party.manageParty`). */
export interface ManagedFloors {
  health: HealthConfig;
  marginWhenUncapped: number;
}

export interface PartyWaitMoves {
  /** Stop the running lap, saying `why`; false where no lap was running. */
  pauseLap(why: string): boolean;
  /** Whether the lap is stopped, so walking on has something to resume. */
  lapStopped(): boolean;
  /** Walk the lap on again, said out loud where it cannot. */
  resumeLap(who: string): void;
  notice: NoticeSink;
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
  /** The members' vitals held under `manageParty`, as `membersStill` keys them. */
  private still: ReadonlyMap<string, string> = new Map();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly moves: PartyWaitMoves) {}

  /** Whether the lap is stopped for the party. */
  get holding(): boolean {
    return this.paused;
  }

  /**
   * Leading, the members here under `waitBelow`, and under `managed` the ones
   * this character's own floors hold for, re-read from every state (MegaMUD's
   * *Wait For Party Members*): a member under the line is a reason to wait, as
   * its `@wait` is, and a lap started while one is still under it stops for it.
   */
  onCharacter(state: CharacterState, waitBelow: number, managed: ManagedFloors | null): void {
    const leading = state.party.following === null;
    this.still =
      leading && managed !== null
        ? membersStill(state, managed.health, this.still, managed.marginWhenUncapped)
        : new Map();
    const low = [...new Set(this.still.values())];
    this.track('hurt', leading ? membersBelow(state, waitBelow) : []);
    this.track('low', low);
  }

  /** The members under one bar reason now: a wait for each, an end for each no longer under it. */
  private track(why: (typeof BAR_REASONS)[number], names: string[]): void {
    const now = new Set(names.map((name) => `${why}:${name.toLowerCase()}`));
    for (const [key, name] of [...this.waiting]) {
      if (key.startsWith(`${why}:`) && !now.has(key)) this.pace(name, true, why);
    }
    for (const key of [...this.givenUp]) {
      if (key.startsWith(`${why}:`) && !now.has(key)) this.givenUp.delete(key);
    }
    for (const name of names) {
      if (!this.givenUp.has(`${why}:${name.toLowerCase()}`)) this.pace(name, false, why);
    }
  }

  /** A member asked to wait or said it is ready, or its health did (`PaceReason`). */
  pace(who: string, ready: boolean, why: PaceReason): void {
    const key = `${why}:${who.toLowerCase()}`;
    if (!ready) {
      this.waiting.set(key, who);
      const said = pausedSentence(why, who);
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
    this.still = new Map();
    this.end();
  }

  /** The hurt members waited for now are not waited for again until they recover. */
  private giveUpOnHurt(): void {
    for (const key of [...this.waiting.keys()]) {
      if (!BAR_REASONS.some((why) => key.startsWith(`${why}:`))) continue;
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
    this.moves.notice(
      t('session.loop.partyWaitGaveUp', { minutes, who: who.join(', ') }),
      'party-wait'
    );
    if (this.moves.lapStopped()) this.moves.resumeLap(who[0] ?? '');
  }
}

/** What the lap says on stopping for a member, by why. */
function pausedSentence(why: PaceReason, who: string): string {
  switch (why) {
    case 'asked':
      return t('session.loop.pausedForRemote', { who });
    case 'hurt':
      return t('session.loop.pausedForHealth', { who });
    case 'low':
      return t('session.loop.pausedForRest', { who });
    default: {
      const unreachable: never = why;
      return unreachable;
    }
  }
}
