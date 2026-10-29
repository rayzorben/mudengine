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
import type { Block } from '../../shared/blocks';

/**
 * Why the party waits for a member: it said `@wait`, its health is under
 * `party.waitBelow` (`hurt`), it is under this character's own rest floors
 * (`low`, `manageParty`), it was invited back and has not joined
 * (`invited`), or it hung up and no party list has printed it back (`away`).
 * Kept apart so a member's `@ok` does not end a wait its health or its
 * joining still asks for.
 */
export type PaceReason = 'asked' | 'hurt' | 'low' | 'invited' | 'away';

/** A wait that comes and goes with a member's bar, not with what it said. */
const BAR_REASONS = ['hurt', 'low'] as const satisfies readonly PaceReason[];

/**
 * A wait re-read from every state. `away` is bounded by
 * `party.reinviteMinutes` (`PartyRejoin`), not by `waitMinutes`.
 */
const TRACKED_REASONS = [...BAR_REASONS, 'away'] as const satisfies readonly PaceReason[];

/** The leader's own floors, when it holds the party to them (`party.manageParty`). */
export interface ManagedFloors {
  health: HealthConfig;
  marginWhenUncapped: number;
}

export interface PartyWaitMoves {
  /** Stop the running lap or the asked route, saying `why`; false where neither was moving. */
  pauseMoving(why: string): boolean;
  /** Whether what was stopped is still stopped, so walking on has something to resume. */
  stopped(): boolean;
  /** Walk on again, said out loud where it cannot. */
  resume(who: string): void;
  notice: NoticeSink;
  /** Whether a route somebody asked for is walking: a person chose to go. */
  walkingAsked(): boolean;
  /** `party.waitMinutes`, read when a wait begins; 0 waits for ever. */
  waitMinutes(): number;
  /** A member the stopped party waits on dropped out of it behind a step already sent. */
  leftBehind(who: string): void;
}

export class PartyWait {
  /** Who the party waits for, by reason and lower-cased name, as each spelled it. */
  private readonly waiting = new Map<string, string>();
  /** Whether the lap's current stop is this wait's own: only that is walked on from. */
  private paused = false;
  /** Tracked members a wait gave up on, until they are over the line or gone (`giveUp`). */
  private readonly givenUp = new Set<string>();
  /** The members' vitals held under `manageParty`, as `membersStill` keys them. */
  private still: ReadonlyMap<string, string> = new Map();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly moves: PartyWaitMoves) {}

  /** Whether the lap or route is stopped for the party. */
  get holding(): boolean {
    return this.paused;
  }

  /**
   * Leading, the members here under `waitBelow`, and under `managed` the ones
   * this character's own floors hold for, re-read from every state (MegaMUD's
   * *Wait For Party Members*): a member under the line is a reason to wait, as
   * its `@wait` is, and a lap started while one is still under it stops for it.
   * So is each member `away` after a hangup, until a party list prints them.
   */
  onCharacter(
    state: CharacterState,
    waitBelow: number,
    managed: ManagedFloors | null,
    away: readonly string[]
  ): void {
    // A route has no publish of its own here, so walking one on by hand is read off the state.
    if (this.paused && !this.moves.stopped()) {
      if (this.moves.walkingAsked()) this.played();
      else this.walkedOn();
    }
    const leading = state.party.following === null;
    this.still =
      leading && managed !== null
        ? membersStill(state, managed.health, this.still, managed.marginWhenUncapped)
        : new Map();
    const low = [...new Set(this.still.values())];
    this.track('hurt', leading ? membersBelow(state, waitBelow) : []);
    this.track('low', low);
    this.track('away', leading ? away : []);
  }

  /**
   * The party's own lines: a member invited back is waited for until they
   * join, and one who stops following is `leftParty`. An uninvite
   * (`has been removed from your followers`) is the player's own choice.
   */
  onBlock(block: Block): void {
    const who = block.groups['player'];
    if (who === undefined) return;
    if (block.type === 'party-joined' && this.waiting.has(`invited:${who.toLowerCase()}`))
      this.pace(who, true, 'invited');
    else if (block.type === 'party-left' && block.groups['removed'] === undefined)
      this.leftParty(who);
  }

  /**
   * `who` is out of the party. Asked to wait while the party is stopped for
   * them, they were left behind: GreaterMUD drops a held member as the leader
   * steps off, and the `@wait` lands before or after the drop.
   */
  leftParty(who: string): void {
    if (this.paused && this.waiting.has(`asked:${who.toLowerCase()}`)) this.moves.leftBehind(who);
  }

  /** The members under one tracked reason now: a wait for each, an end for each no longer under it. */
  private track(why: (typeof TRACKED_REASONS)[number], names: readonly string[]): void {
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
      const fresh = !this.waiting.has(key);
      this.waiting.set(key, who);
      const said = pausedSentence(why, who);
      // A word or a join added to a stop already held is said; a bar crossing back and forth is not.
      if (this.paused) {
        if (fresh && !isBarReason(why)) this.moves.notice(said, 'party-wait');
        // A stop held only for `away` has no clock yet, or one spent: this reason starts it.
        if (why !== 'away' && this.timer === null) this.arm();
        return;
      }
      if (!this.moves.pauseMoving(said)) return;
      this.paused = true;
      if (why !== 'away') this.arm();
      return;
    }
    this.waiting.delete(key);
    if (this.waiting.size > 0 || !this.paused || !this.moves.stopped()) return;
    this.end();
    this.moves.resume(who);
  }

  /**
   * The lap published: a lap no longer stopped has ended the wait, however it
   * did. Walked on by hand while the wait held it, the player chose to go:
   * the members hurt then are not waited for again until they recover.
   */
  noteLap(progress: LoopProgress): void {
    if (progress.status !== 'stopped') this.walkedOn();
  }

  /**
   * What was stopped moves again, however: the hurt are given up on. A member
   * away after a hangup is not: anything but the player's own Play (`played`)
   * starting the lap again is stopped again at the next state (Rayzor,
   * 2026-10-29: the lap walked on at 3am with Brakkle owed).
   */
  private walkedOn(): void {
    if (this.paused) this.giveUpOnTracked(isAway);
    this.end();
  }

  /**
   * Before the player's Play: what to call once it went. Only a wait that held
   * the stop is walked on from, read now because the lap's publish ends the
   * stop (`walkedOn`) before Play returns; a member hurt under a stop the
   * player made is still waited for.
   */
  beforePlay(): () => void {
    const held = this.paused;
    return () => {
      if (held) this.played();
    };
  }

  /** The player walked on, by Play or a route of their own: every member waited for now is given up on. */
  private played(): void {
    this.giveUpOnTracked();
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

  /** The tracked members waited for now, but those `kept`, are not waited for again until they recover or are back. */
  private giveUpOnTracked(kept: (key: string) => boolean = () => false): void {
    for (const key of [...this.waiting.keys()]) {
      if (kept(key) || !TRACKED_REASONS.some((why) => key.startsWith(`${why}:`))) continue;
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

  /**
   * The wait ran past its limit: walk on, and say for whom it gave up. A
   * member `away` after a hangup is still waited for, on its own clock.
   */
  private giveUp(minutes: number): void {
    this.timer = null;
    if (!this.paused) return;
    const who = [...new Set([...this.waiting].filter(([key]) => !isAway(key)).map(([, n]) => n))];
    this.giveUpOnTracked(isAway);
    for (const key of [...this.waiting.keys()]) if (!isAway(key)) this.waiting.delete(key);
    if (who.length > 0)
      this.moves.notice(
        t('session.loop.partyWaitGaveUp', { minutes, who: who.join(', ') }),
        'party-wait'
      );
    if (this.waiting.size > 0) return;
    this.paused = false;
    if (this.moves.stopped()) this.moves.resume(who[0] ?? '');
  }
}

/** A wait for a member a hangup took out, which only the player's Play or `PartyRejoin` ends. */
function isAway(key: string): boolean {
  return key.startsWith('away:');
}

function isBarReason(why: PaceReason): why is (typeof BAR_REASONS)[number] {
  return (BAR_REASONS as readonly PaceReason[]).includes(why);
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
    case 'invited':
      return t('session.loop.pausedForJoin', { who });
    case 'away':
      return t('session.loop.pausedForRejoin', { who });
    default: {
      const unreachable: never = why;
      return unreachable;
    }
  }
}
