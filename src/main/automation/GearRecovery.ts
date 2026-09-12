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
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { MovementConfig } from '../../shared/config';
import { restorePlan } from '../../shared/gear';
import { sameItem } from '../../shared/items';
import { roomId, type RoomId, type Route } from '../../shared/world';

export interface RecoveryPlanner {
  /** Where the character stands, or null while unplaced. */
  here(): RoomId | null;
  /** A route to the room it died in, or the reason there is none. */
  routeTo(room: RoomId): Route | string;
  /** Hands the route to the walker as a leg. Returns its refusal, or null. */
  walk(route: Route): string | null;
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

type Phase =
  | { kind: 'idle' }
  | { kind: 'walking'; to: RoomId }
  | { kind: 'collecting'; to: RoomId; asked: Set<string>; askedAt: number };

const ACTION = 'recover gear';

export class GearRecovery {
  /** The death last acted on, so one death is one attempt. */
  private handled: number | null = null;
  private phase: Phase = { kind: 'idle' };

  constructor(
    private config: MovementConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly planner: RecoveryPlanner,
    private readonly events: RecoveryEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: MovementConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.handled = null;
    this.phase = { kind: 'idle' };
  }

  /** Every state change. */
  onCharacter(state: CharacterState): void {
    if (!this.enabled || !this.config.recoverGear) return;
    if (state.phase !== 'in-game') return;
    if (this.phase.kind === 'collecting') {
      this.collect(state);
      return;
    }
    if (this.phase.kind !== 'idle') return;

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

    this.handled = death.at;
    const to = roomId(death.map, death.number);
    if (this.planner.here() === to) {
      this.phase = { kind: 'collecting', to, asked: new Set(), askedAt: 0 };
      this.collect(state);
      return;
    }
    const route = this.planner.routeTo(to);
    if (typeof route === 'string') {
      this.refuse(
        t('automation.gearRecovery.refusalNoRoute', { room: death.name ?? to, why: route })
      );
      return;
    }
    this.events.notice?.(
      t('automation.gearRecovery.going', {
        count: missing.length,
        room: death.name ?? to,
        steps: route.steps.length
      })
    );
    const refused = this.planner.walk(route);
    if (refused !== null) {
      this.refuse(
        t('automation.gearRecovery.refusalNoRoute', { room: death.name ?? to, why: refused })
      );
      return;
    }
    this.phase = { kind: 'walking', to };
  }

  /** The walker's report: the recovery's own leg ended, or somebody else's walk did. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    if (this.phase.kind !== 'walking') return;
    const { to } = this.phase;
    if (!arrived || this.planner.here() !== to) {
      this.phase = { kind: 'idle' };
      this.refuse(
        t('automation.gearRecovery.refusalNotReached', {
          room: state.lastDeath?.name ?? to,
          why: reason ?? t('automation.gearRecovery.whyStopped')
        })
      );
      return;
    }
    this.phase = { kind: 'collecting', to, asked: new Set(), askedAt: 0 };
    this.collect(state);
  }

  /**
   * Standing where the character died: take what is still there, then put it
   * on. The floor is read from the room block, the pack from `You took`, and
   * the dressing waits for the pack to hold what was asked for — or for
   * `tuning.gearRecovery.collectMs` to pass, after which it dresses with what
   * arrived and says what did not.
   */
  private collect(state: CharacterState): void {
    if (this.phase.kind !== 'collecting') return;
    const { to, asked } = this.phase;
    if (this.planner.here() !== to) {
      // Wandered, or walked: the pile is somewhere the character is not.
      this.phase = { kind: 'idle' };
      this.refuse(t('automation.gearRecovery.refusalLeft'));
      return;
    }
    const missing = this.missing(state);
    if (asked.size === 0) {
      const onFloor = missing.filter((item) =>
        state.room.items.some((floor) => sameItem(floor.name, item))
      );
      const gone = missing.filter((item) => !onFloor.includes(item));
      if (onFloor.length === 0) {
        this.phase = { kind: 'idle' };
        this.refuse(t('automation.gearRecovery.refusalNothingHere', { items: missing.join(', ') }));
        return;
      }
      const max = tuning().spending.maxGear;
      const taking = onFloor.slice(0, max);
      const { expiresMs } = tuning().gearRecovery;
      for (const item of taking) {
        asked.add(item);
        this.queue.enqueue({
          command: `get ${item}`,
          priority: 'probe',
          coalesceKey: `recover:${item.toLowerCase()}`,
          expiresAt: this.now() + expiresMs,
          reason: t('automation.gearRecovery.reasonTaking', { item })
        });
      }
      // And the purse, which the death dropped beside the kit.
      const cash = state.room.cash;
      if (cash !== null) {
        for (const coin of ['runic', 'platinum', 'gold', 'silver', 'copper'] as const) {
          if (cash[coin] <= 0) continue;
          this.queue.enqueue({
            command: `get ${coin}`,
            priority: 'probe',
            coalesceKey: `recover:${coin}`,
            expiresAt: this.now() + expiresMs,
            reason: t('automation.gearRecovery.reasonCoins', { coin })
          });
        }
      }
      this.phase = { kind: 'collecting', to, asked, askedAt: this.now() };
      const capped = onFloor.length - taking.length;
      this.events.notice?.(
        [
          t('automation.gearRecovery.taking', { count: taking.length, items: taking.join(', ') }),
          gone.length > 0 ? t('automation.gearRecovery.takingGone', { gone: gone.length }) : '',
          capped > 0 ? t('automation.gearRecovery.takingCapped', { capped }) : ''
        ]
          .filter((part) => part.length > 0)
          .join(' ')
      );
      return;
    }
    const arrived = [...asked].filter((item) =>
      state.inventory.items.some((held) => sameItem(held.name, item))
    );
    const waited = this.now() - this.phase.askedAt;
    if (arrived.length < asked.size && waited < tuning().gearRecovery.collectMs) return;
    this.phase = { kind: 'idle' };
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
    const notTaken = [...asked].filter((item) => !arrived.includes(item));
    this.events.notice?.(
      t('automation.gearRecovery.dressed', {
        worn: plan.commands.length,
        notTaken: notTaken.length,
        missing: plan.missing.length
      })
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.gearRecovery.becauseStripped', { count: asked.size }),
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
