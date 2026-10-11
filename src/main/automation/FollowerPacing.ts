/**
 * A follower telling its leader to wait, and when it can go on: `@wait` with
 * MegaMUD's reason in brackets (`WaitReason`) on the crossing into a wait, a
 * fresh one when the reason changes, and `@ok` the moment none is left. A
 * wait is the follower's own walk test (`stillFor`: under `restBelow`, until
 * `restTo`) or a condition its walk stands still for (`afflictionHolding`).
 * The server's rest flag is not one: nothing stands a rested character up, so
 * an `@ok` that waited for it went out after the bar was full (the user,
 * 2026-10-10, Brakkle). `mudengine-automation` › parts/remotes.md.
 */
import { tuning } from '../app/tuning';
import { leaderOf, type CharacterState } from '../../shared/character';
import { stillFor, type AutomationConfig } from '../../shared/config';
import { waitArgument, type WaitReason } from '../../shared/remotes';
import { afflictionHolding } from '../../shared/walk';

export interface FollowerPacingEvents {
  /** Telepath the leader `@wait` (with its bracket) or `@ok`. */
  tell(leader: string, name: 'wait' | 'ok', state: CharacterState, argument?: string): void;
}

export class FollowerPacing {
  /** Why the leader was last asked to wait, or null when it was told `@ok` (or nothing). */
  private reason: WaitReason | null = null;
  /** Whether this character's own walk stood still for each vital at the last state. */
  private readonly still = { health: false, mana: false };

  constructor(
    private config: AutomationConfig,
    private readonly events: FollowerPacingEvents
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  reset(): void {
    this.reason = null;
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
    // Not while the leader rests: that rest is its own, and `restWithLeader` keeps the party with it.
    const reason = leaderResting(state) ? null : this.reasonFor(state);
    const was = this.reason;
    this.reason = reason;
    if (was === reason || !this.config.enabled || !this.config.remotes.enabled) return;
    const leader = state.party.following;
    if (leader === null) return;
    if (reason === null) this.events.tell(leader, 'ok', state);
    else this.events.tell(leader, 'wait', state, waitArgument(reason));
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
