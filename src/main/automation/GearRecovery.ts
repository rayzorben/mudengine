/**
 * Going back for the kit after a death — the second half of `user-dies`.
 *
 * A death drops everything where the character stood and wakes it in the
 * temple, and until 2026-09-12 everything the client did on that block was
 * about *stopping*: the walk, the lap, the haven, the trail. Measured on
 * `orohost`: a level-30 character put back on top of its own falchion punched
 * a wererat for 16 while the blade lay on the floor, and sent no `get`, `wear`
 * or `arm` all session. This notices the strip, walks back, takes what is
 * still there, and puts it on. Off by default; every refusal says so. See
 * `mudengine-automation` § *Going back for the kit is a leg, and it refuses
 * loudly*.
 */
import { Collect, type CollectEnd, type CollectPlanner } from './Collect';
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { MovementConfig } from '../../shared/config';
import { restorePlan } from '../../shared/gear';
import { sameItem } from '../../shared/items';
import { roomId } from '../../shared/world';
import type { SessionModule } from './Module';

export interface RecoveryPlanner extends CollectPlanner {
  /** A move outstanding, a walk running, an escape in flight: not now. */
  moveInFlight(): boolean;
  walking(): boolean;
  busy(): boolean;
}

export interface RecoveryEvents {
  notice?(message: string): void;
  /** The trace: what was recovered, and what was refused and why. */
  decided?(decision: SafetyDecision): void;
}

const ACTION = 'recover gear';

export class GearRecovery implements SessionModule {
  /** The death last acted on, so one death is one attempt. */
  private handled: number | null = null;
  /**
   * Recoveries that have failed in a row (todo 21).
   *
   * **In a row**, and reset by one that reaches the kit: a run of failures is
   * what says the trip is not working, where one failure among successes says
   * only that something went wrong once. Bounded by
   * `movement.recoverGearTries`, because a recovery walks a freshly dead and
   * stripped character back to the room that killed it — where that room is
   * still dangerous the attempt is itself a way to die, and each trip costs a
   * life.
   */
  private failures = 0;
  /** Whether the bound has been said, so it is said once rather than per death. */
  private saidSpent = false;
  /** The walk back and the pick-up, shared with the stash fetch. */
  private readonly collect: Collect;
  /** Where the trip under way is going, as its sentences name it. */
  private room = '';

  constructor(
    private config: MovementConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly planner: RecoveryPlanner,
    private readonly events: RecoveryEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.collect = new Collect(
      queue,
      planner,
      {
        // Reaching the pile is what the run of failures counted the absence of (todo 21).
        arrived: () => {
          this.failures = 0;
          this.saidSpent = false;
        },
        taking: (taking, gone, capped) => this.taking(taking, gone, capped),
        ended: (end, state) => this.ended(end, state)
      },
      now
    );
  }

  configure(config: MovementConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.handled = null;
    this.collect.cancel();
    this.failures = 0;
    this.saidSpent = false;
  }

  /** Every state change. */
  onCharacter(state: CharacterState): void {
    if (!this.enabled || !this.config.recoverGear) return;
    if (state.phase !== 'in-game') return;
    if (this.collect.busy) {
      this.collect.onCharacter(state);
      return;
    }

    const death = state.lastDeath;
    if (death === null || death.at === this.handled) return;
    /*
     * The strip, from two signals, because either alone has an innocent
     * reading: the loadout remembers items the pack — read *after* the death
     * — no longer holds, and the sheet's armour class has fallen to zero. A
     * loadout is never emptied by an item coming off, so it alone says a
     * character with its helm in the pack is stripped; a zero armour class
     * alone is a level-one character in a shirt.
     */
    if (state.inventory.listedAt === null || state.inventory.listedAt < death.at) return;
    if (state.progress.armourClass === null) return;
    const missing = this.missing(state);
    if (missing.length === 0 || state.progress.armourClass !== 0) {
      this.handled = death.at;
      return;
    }
    if (death.map === null || death.number === null) {
      this.handled = death.at;
      this.refuse(t('automation.gearRecovery.refusalUnplaced', { count: missing.length }));
      return;
    }
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) return;

    /*
     * The bounds, before anything is walked (todo 21).
     *
     * Both are about the same thing: a recovery is a trip back to the room
     * that killed this character, and a client that keeps making it spends
     * lives — which are finite and unrecoverable — on a cloak. The lives floor
     * is the one a player reasons in and it holds whatever the counter says;
     * the try count catches the case where lives are plentiful and the room is
     * simply lethal.
     *
     * An unread life count does not stop it: unknown is not *low*, the rule
     * every threshold here follows.
     */
    const bound = this.bound(state);
    if (bound !== null) {
      this.handled = death.at;
      if (!this.saidSpent) {
        this.saidSpent = true;
        this.refuse(bound);
      }
      return;
    }

    this.handled = death.at;
    const room = death.name ?? roomId(death.map, death.number);
    this.room = room;
    const started = this.collect.start(
      {
        to: roomId(death.map, death.number),
        items: missing,
        search: null,
        key: 'recover',
        reason: (item) => t('automation.gearRecovery.reasonTaking', { item }),
        coinReason: (coin) => t('automation.gearRecovery.reasonCoins', { coin }),
        collectMs: tuning().gearRecovery.collectMs,
        expiresMs: tuning().gearRecovery.expiresMs
      },
      state
    );
    if (started.kind === 'refused') {
      this.refuse(t('automation.gearRecovery.refusalNoRoute', { room, why: started.why }));
    } else if (started.kind === 'walking') {
      this.events.notice?.(
        t('automation.gearRecovery.going', { count: missing.length, room, steps: started.steps })
      );
    }
  }

  /** The walker's report: the recovery's own leg ended, or somebody else's walk did. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    this.collect.onWalkEnded(arrived, reason, state);
  }

  private taking(taking: readonly string[], gone: number, capped: number): void {
    this.events.notice?.(
      [
        t('automation.gearRecovery.taking', { count: taking.length, items: taking.join(', ') }),
        gone > 0 ? t('automation.gearRecovery.takingGone', { gone }) : '',
        capped > 0 ? t('automation.gearRecovery.takingCapped', { capped }) : ''
      ]
        .filter((part) => part.length > 0)
        .join(' ')
    );
  }

  /**
   * How the trip ended. Taken: dressed with what arrived (`restorePlan`),
   * saying what did not. The rest are refusals, and a walk that never got
   * there, or a pile left, counts towards `recoverGearTries`.
   */
  private ended(end: CollectEnd, state: CharacterState): void {
    const { room } = this;
    switch (end.kind) {
      case 'not-reached':
        this.failed(
          t('automation.gearRecovery.refusalNotReached', {
            room,
            why: end.why ?? t('automation.gearRecovery.whyStopped')
          })
        );
        return;
      case 'left':
        this.failed(t('automation.gearRecovery.refusalLeft'));
        return;
      case 'nothing-here':
        this.refuse(
          t('automation.gearRecovery.refusalNothingHere', { items: this.missing(state).join(', ') })
        );
        return;
      case 'taken':
        this.dress(end.asked, end.arrived, state);
        return;
      default: {
        const never: never = end;
        return never;
      }
    }
  }

  private dress(asked: readonly string[], arrived: readonly string[], state: CharacterState): void {
    const plan = restorePlan(state.loadout, state.inventory.items, tuning().spending.maxGear);
    for (const command of plan.commands) {
      this.queue.enqueue({
        command,
        priority: 'probe',
        coalesceKey: `recover:${command}`,
        expiresAt: this.now() + tuning().gearRecovery.expiresMs,
        reason: t('automation.gearRecovery.reasonDressing')
      });
    }
    this.events.notice?.(
      t('automation.gearRecovery.dressed', {
        worn: plan.commands.length,
        notTaken: asked.length - arrived.length,
        missing: plan.missing.length
      })
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.gearRecovery.becauseStripped', { count: asked.length }),
      acted: true
    });
  }

  /** The remembered kit the pack no longer holds, as the loadout spells it. */
  private missing(state: CharacterState): string[] {
    const names: string[] = [];
    for (const worn of state.loadout) {
      if (state.inventory.items.some((item) => sameItem(item.name, worn.item))) continue;
      if (!names.includes(worn.item)) names.push(worn.item);
    }
    return names;
  }

  /**
   * Why this recovery must not be attempted, or null to go.
   *
   * The lives floor first, because it is the one a player reasons in and the
   * one whose cost cannot be undone. `0` disables either bound, and an unread
   * life count stops nothing: unknown is not low.
   */
  private bound(state: CharacterState): string | null {
    const lives = state.progress.lives;
    const floor = this.config.recoverGearFloor;
    if (floor > 0 && lives !== null && lives <= floor) {
      return t('automation.gearRecovery.refusalLives', { lives, floor });
    }
    const tries = this.config.recoverGearTries;
    if (tries > 0 && this.failures >= tries) {
      return t('automation.gearRecovery.refusalTries', { tries });
    }
    return null;
  }

  /**
   * A recovery that did not get there. Counted, so a run of them stops the
   * next one being attempted — see `failures`.
   */
  private failed(refused: string): void {
    this.failures += 1;
    this.refuse(refused);
  }

  private refuse(refused: string): void {
    this.events.notice?.(t('automation.gearRecovery.refused', { refused }));
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.gearRecovery.becauseDied'),
      acted: false,
      refused
    });
  }
}
