/**
 * A follower telling its leader to wait, and when it can go on: `@wait` with
 * MegaMUD's reason in brackets (`WaitReason`) on the crossing into a wait, a
 * fresh one when the reason changes, and `@ok` the moment none is left, or on
 * following again when it ended out of the party. A wait is the follower's
 * own walk test (`stillFor`) or a condition its walk stands still for
 * (`afflictionHolding`); the server's rest flag is not one (the user,
 * 2026-10-10, Brakkle). Held, it says `@held` after the wait, and dropped
 * from the party while held asks that leader `@comeback` once, as MegaMUD
 * does (todo 20261024-1900-02). `mudengine-automation` › parts/remotes.md.
 */
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { follows, leaderOf, type CharacterState } from '../../shared/character';
import { stillFor, type AutomationConfig } from '../../shared/config';
import { waitArgument, type WaitReason } from '../../shared/remotes';
import { afflictionHolding } from '../../shared/walk';

export interface FollowerPacingEvents {
  /** Telepath the leader `@wait` (with its bracket), `@held`, `@ok` or `@comeback`. */
  tell(
    leader: string,
    name: 'wait' | 'held' | 'ok' | 'comeback',
    state: CharacterState,
    argument?: string
  ): void;
}

export class FollowerPacing {
  /** Why the leader was last asked to wait, or null when it was told `@ok` (or nothing). */
  private reason: WaitReason | null = null;
  /** Whether this character's own walk stood still for each vital at the last state. */
  private readonly still = { health: false, mana: false };
  /** Whether this hold has asked its leader back already: once a hold. */
  private askedBack = false;
  /** The leader told the last `@wait`, until it hears `@ok`: a wait that ends out of the party is owed to them. */
  private toldWait: string | null = null;
  /** Whether that leader is owed an `@ok` the moment this character follows them again. */
  private owedOk = false;

  constructor(
    private config: AutomationConfig,
    private readonly events: FollowerPacingEvents
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  reset(): void {
    this.reason = null;
    this.askedBack = false;
    this.toldWait = null;
    this.owedOk = false;
    this.still.health = false;
    this.still.mana = false;
  }

  onCharacter(state: CharacterState): void {
    const margin = tuning().loop.resumeMarginWhenUncapped;
    for (const vital of ['health', 'mana'] as const) {
      this.still[vital] = stillFor(
        vital,
        state.vitals,
        this.config.health,
        this.still[vital],
        margin
      );
    }
    // Nothing said while the leader rests: that rest is its own, and a wait already
    // asked stands until the leader is up (an `@ok` here went out at 2 mana, Rayzor, 2026-11-02).
    if (leaderResting(state)) return;
    const reason = this.reasonFor(state);
    const was = this.reason;
    this.reason = reason;
    if (reason !== 'held') this.askedBack = false;
    if (reason !== null) this.owedOk = false;
    const leader = state.party.following;
    // Dropped while held, the hold can end before that leader invites this character back.
    if (was !== null && reason === null && leader === null && this.toldWait !== null)
      this.owedOk = true;
    const told = this.toldWait;
    if (this.owedOk && reason === null && told !== null && follows(state, told) && this.sending()) {
      this.tellOk(told, state);
      return;
    }
    if (was === reason || !this.sending()) return;
    if (leader === null) return;
    if (reason === null) {
      this.tellOk(leader, state);
      return;
    }
    this.toldWait = leader;
    this.events.tell(leader, 'wait', state, waitArgument(reason));
    if (reason === 'held') this.events.tell(leader, 'held', state);
  }

  /** The realm dropping this character from the party while it is held: the leader asked back. */
  onBlock(block: Block, state: CharacterState): void {
    const leader = block.type === 'party-left' ? block.groups['leader'] : undefined;
    if (leader === undefined || this.reason !== 'held' || this.askedBack) return;
    // The reason stands still through the leader's rest, so the hold is asked of the state too.
    if (afflictionHolding(state.afflictions, this.config.movement) !== 'held') return;
    if (!this.sending()) return;
    this.askedBack = true;
    this.events.tell(leader, 'comeback', state);
  }

  private tellOk(leader: string, state: CharacterState): void {
    this.toldWait = null;
    this.owedOk = false;
    this.events.tell(leader, 'ok', state);
  }

  private sending(): boolean {
    return this.config.enabled && this.config.remotes.enabled;
  }

  private reasonFor(state: CharacterState): WaitReason | null {
    const condition = afflictionHolding(state.afflictions, this.config.movement);
    if (condition !== null) return condition;
    if (this.still.health) return 'health';
    return this.still.mana ? 'mana' : null;
  }
}

/** Whether the leader this character follows is resting or meditating, by the party listing. */
function leaderResting(state: CharacterState): boolean {
  const doing = leaderOf(state)?.activity?.state;
  return doing === 'resting' || doing === 'meditating';
}
