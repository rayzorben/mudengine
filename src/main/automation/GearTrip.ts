/**
 * Walking a gear trip (`shared/gearTrip.ts`): each stop in the plan's order,
 * a vault drawn on (`Withdrawal`) or a counter bought from one item at a time
 * (`Handover`, the pack gaining it the confirmation), then the bought items
 * worn. Started only by the player from the Gear card (or an extension), and
 * walked or run as they chose: a run turns auto-combat off for the way and on
 * again at the last stop, as *Run it* does, and a run stopped short leaves it
 * off. Each leg is planned again from where the character stands, never
 * replayed; a fight on the way is waited out and the leg planned again, up to
 * `tuning.gear.maxLegs`. Yields to an escape; holds the lap; dropped on a
 * death; every ending said. See `mudengine-automation` › *Errands*.
 */
import type { CommandQueue } from './CommandQueue';
import { Handover, type HandoverEnd } from './Handover';
import type { SessionModule } from './Module';
import { tripRefusal, type TripPlanner } from './askedTrip';
import { stoppedByPerson } from './personStop';
import { Withdrawal, type WithdrawalEnd } from './Withdrawal';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import { fightIsRunning, type CharacterState } from '../../shared/character';
import {
  planBuys,
  type GearBuy,
  type GearStop,
  type GearTripPlan,
  type GearTripProgress,
  type GearTripStage
} from '../../shared/gearTrip';
import type { RoomId, Route } from '../../shared/world';

export interface GearTripPlanner extends TripPlanner {
  here(): RoomId | null;
  /** The character as it stands. */
  current(): CharacterState;
  routeTo(room: RoomId): Route | string;
  /** Hands the leg to the walker, timed to the rounds where `run`; its refusal, or null. */
  walk(route: Route, run: boolean): string | null;
  /** An escape in flight, which outranks the trip once it is under way. */
  escaping(): boolean;
  /** *Run it*'s switch: true where auto-combat went off for the way, the refusal where it would not. */
  combatOffForRun(): boolean | string;
  /** The run's way is over: auto-combat back on, said. */
  combatOnAfterRun(): void;
  /** The commands that put the bought items on, the slot's weakest taken off first where it must be. */
  wearCommands(bought: readonly GearBuy[], state: CharacterState): string[];
}

export interface GearTripEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
  gearTrip?(progress: GearTripProgress | null): void;
}

interface Trip {
  plan: GearTripPlan;
  run: boolean;
  /** Whether the lap was running and is held for the trip. */
  held: boolean;
  /** Whether this trip turned auto-combat off, and so turns it on at the end. */
  combatOff: boolean;
  stop: number;
  stage: GearTripStage;
  /** Walking, or waiting out a fight before the leg is planned again. */
  waiting: boolean;
  legs: number;
  bought: string[];
  missed: string[];
}

const ACTION = 'gear trip';

export class GearTrip implements SessionModule {
  private trip: Trip | null = null;
  private readonly handover: Handover;
  private readonly withdrawal: Withdrawal;
  private last: GearTripProgress | null = null;

  constructor(
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly planner: GearTripPlanner,
    private readonly events: GearTripEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.handover = new Handover(
      queue,
      { here: planner.here, routeTo: planner.routeTo, walk: (route) => planner.walk(route, false) },
      { ended: (end) => this.bought(end) },
      now
    );
    this.withdrawal = new Withdrawal(queue, { ended: (end) => this.drew(end) }, now);
  }

  configure(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled && this.trip !== null) this.end(t('automation.hostTrip.endedSwitchedOff'));
  }

  reset(): void {
    this.handover.cancel();
    this.withdrawal.cancel();
    this.trip = null;
  }

  get busy(): boolean {
    return this.trip !== null;
  }

  /** The trip under way, or the last one as it ended. */
  get progress(): GearTripProgress | null {
    return this.trip === null ? this.last : this.progressOf(this.trip, null);
  }

  /** A death: wherever the trip was going is somewhere else now. */
  abandon(): void {
    if (this.trip !== null) this.end(t('automation.hostTrip.endedDied'));
  }

  /** The player's Stop. */
  stop(): void {
    if (this.trip !== null) this.end(t('automation.gearTrip.stoppedByPlayer'));
  }

  /** One trip; its refusal, said, or null once under way. */
  start(plan: GearTripPlan, run: boolean, state: CharacterState): string | null {
    const names = planBuys(plan).map((buy) => buy.name);
    const running = this.trip !== null;
    const refused =
      tripRefusal(names, { enabled: this.enabled, running }, state, this.planner) ??
      plan.refusal ??
      null;
    if (refused !== null) {
      this.say(t('automation.gearTrip.refused', { why: refused }), refused);
      return refused;
    }
    const combatOff = run ? this.planner.combatOffForRun() : false;
    if (typeof combatOff === 'string') {
      this.say(t('automation.gearTrip.refused', { why: combatOff }), combatOff);
      return combatOff;
    }
    const held = this.planner.looping();
    const trip: Trip = {
      plan,
      run,
      held,
      combatOff,
      stop: 0,
      stage: 'walking',
      waiting: false,
      legs: 0,
      bought: [],
      missed: []
    };
    this.trip = trip;
    if (held) this.planner.hold();
    this.events.notice?.(
      plan.stops.length === 1
        ? t('automation.gearTrip.going.one', { moves: plan.moves })
        : t('automation.gearTrip.going.many', { stops: plan.stops.length, moves: plan.moves })
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.gearTrip.because'),
      acted: true
    });
    this.toStop(trip, state);
    return null;
  }

  onBlock(block: Block): void {
    this.withdrawal.onBlock(block);
  }

  onCharacter(state: CharacterState): void {
    const trip = this.trip;
    if (trip === null) return;
    this.handover.onCharacter(state);
    this.withdrawal.onCharacter(state);
    if (this.trip === trip && trip.waiting) {
      if (fightIsRunning(state) || this.planner.moveInFlight()) return;
      trip.waiting = false;
      this.leg(trip);
    }
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    const trip = this.trip;
    if (trip === null || trip.stage !== 'walking' || trip.waiting) return;
    const stop = trip.plan.stops[trip.stop];
    if (stop === undefined) return;
    if (arrived && this.planner.here() === stop.room) {
      this.arrive(trip, stop, state);
      return;
    }
    // A fight stops the walker and is waited out; anything else ends the trip, said.
    if (!stoppedByPerson(reason) && fightIsRunning(state)) {
      trip.waiting = true;
      return;
    }
    this.end(t('automation.gearTrip.notReached', { place: stop.place, why: reason ?? '' }));
  }

  private toStop(trip: Trip, state: CharacterState): void {
    const stop = trip.plan.stops[trip.stop];
    if (stop === undefined) {
      this.wear(trip, state);
      return;
    }
    trip.stage = 'walking';
    trip.legs = 0;
    trip.waiting = false;
    if (this.planner.here() === stop.room) {
      this.arrive(trip, stop, state);
      return;
    }
    this.leg(trip);
  }

  /** Plan and walk the leg to the current stop from where the character stands. */
  private leg(trip: Trip): void {
    const stop = trip.plan.stops[trip.stop]!;
    if (this.planner.escaping()) {
      this.end(t('automation.gearTrip.refusalEscaping'));
      return;
    }
    trip.legs += 1;
    if (trip.legs > tuning().gear.maxLegs) {
      this.end(t('automation.gearTrip.tooManyLegs', { place: stop.place }));
      return;
    }
    const route = this.planner.routeTo(stop.room as RoomId);
    const refused =
      typeof route === 'string'
        ? route
        : route.blocked
          ? (route.reason ?? t('automation.walk.refusalNoRoute'))
          : this.planner.walk(route, trip.run);
    if (refused !== null) {
      this.end(t('automation.gearTrip.notReached', { place: stop.place, why: refused }));
      return;
    }
    this.publish(trip);
  }

  private arrive(trip: Trip, stop: GearStop, state: CharacterState): void {
    switch (stop.kind) {
      case 'bank': {
        trip.stage = 'bank';
        const { expiresMs } = tuning().supplies;
        const { vaultMs } = tuning().gear;
        this.withdrawal.start({
          vault: { shop: stop.shop, name: stop.bank },
          need: 1,
          wanted: stop.withdraw,
          key: 'gear',
          reasons: {
            balance: t('automation.supplies.reasonBalance', { bank: stop.bank }),
            withdraw: (amount) =>
              t('automation.gearTrip.reasonWithdraw', { amount: amount.toLocaleString() })
          },
          answerMs: vaultMs,
          expiresMs
        });
        break;
      }
      case 'shop':
        trip.stage = 'buying';
        this.handover.start(
          {
            at: null,
            verb: 'buy',
            items: stop.items.map((item) => item.name),
            key: 'gear',
            reason: (item) => t('automation.gearTrip.reasonBuy', { item, shop: stop.shop }),
            receives: true,
            confirmMs: tuning().gear.confirmMs
          },
          state
        );
        break;
      default: {
        const never: never = stop;
        return never;
      }
    }
    this.publish(trip);
  }

  /** What the vault did; the counters ahead are walked to either way, and refuse what the purse lacks. */
  private drew(end: WithdrawalEnd): void {
    const trip = this.trip;
    const stop = trip?.plan.stops[trip.stop];
    if (trip === null || stop?.kind !== 'bank') return;
    switch (end.kind) {
      case 'paid':
        this.events.notice?.(
          t('automation.gearTrip.withdrew', {
            amount: end.amount.toLocaleString(),
            bank: stop.bank
          })
        );
        break;
      case 'short':
        this.say(
          t('automation.gearTrip.bankShort', { bank: stop.bank, held: end.held.toLocaleString() }),
          stop.bank
        );
        break;
      case 'silent':
        this.say(t('automation.gearTrip.bankSilent', { bank: stop.bank }), stop.bank);
        break;
      default: {
        const never: never = end;
        return never;
      }
    }
    this.next(trip);
  }

  /** What the counter sold. */
  private bought(end: HandoverEnd): void {
    const trip = this.trip;
    if (trip === null || end.kind !== 'handed') return;
    trip.bought.push(...end.gone);
    const missed = [...end.unanswered, ...end.unsent];
    trip.missed.push(...missed);
    if (end.gone.length > 0) {
      this.events.notice?.(t('automation.gearTrip.bought', { items: end.gone.join(', ') }));
    }
    if (missed.length > 0) {
      this.say(t('automation.gearTrip.notSold', { items: missed.join(', ') }), missed.join(', '));
    }
    this.next(trip);
  }

  private next(trip: Trip): void {
    if (this.trip !== trip) return;
    trip.stop += 1;
    this.toStop(trip, this.planner.current());
  }

  /** The bought items put on, then the trip is over. */
  private wear(trip: Trip, state: CharacterState): void {
    trip.stage = 'wearing';
    const expiresAt = this.now() + tuning().supplies.expiresMs;
    const bought = planBuys(trip.plan).filter((buy) => trip.bought.includes(buy.name));
    const unsent: string[] = [];
    for (const command of this.planner.wearCommands(bought, state)) {
      const offered = this.queue.offer({
        command,
        priority: 'probe',
        coalesceKey: `gear:wear:${command}`,
        expiresAt,
        reason: t('automation.gearTrip.reasonWear')
      });
      if (offered !== 'queued' && offered !== 'joined') unsent.push(command);
    }
    if (unsent.length > 0) {
      const commands = unsent.join(', ');
      this.say(t('automation.gearTrip.notWorn', { commands }), commands);
    }
    this.end(null);
  }

  /** Over: `why` null is the trip done. */
  private end(why: string | null): void {
    const trip = this.trip;
    if (trip === null) return;
    this.handover.cancel();
    this.withdrawal.cancel();
    this.trip = null;
    if (trip.held) this.planner.release();
    const ended =
      why ??
      t('automation.gearTrip.done', {
        bought: trip.bought.length,
        wanted: trip.plan.stops.reduce(
          (sum, stop) => sum + (stop.kind === 'shop' ? stop.items.length : 0),
          0
        )
      });
    if (why === null) {
      this.events.notice?.(ended);
      // The run's way is over: auto-combat back on, as *Run it*'s arrival does.
      if (trip.combatOff) this.planner.combatOnAfterRun();
    } else {
      this.say(t('automation.gearTrip.ended', { why }), why);
    }
    trip.stage = 'ended';
    this.last = this.progressOf(trip, ended, why === null);
    this.events.gearTrip?.(this.last);
  }

  private publish(trip: Trip): void {
    this.events.gearTrip?.(this.progressOf(trip, null));
  }

  private progressOf(trip: Trip, ended: string | null, done = false): GearTripProgress {
    return {
      plan: trip.plan,
      stop: trip.stop,
      stage: trip.stage,
      run: trip.run,
      bought: [...trip.bought],
      missed: [...trip.missed],
      ended,
      done
    };
  }

  /** A refusal or a setback, said and traced. */
  private say(message: string, refused: string): void {
    this.events.notice?.(message);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.gearTrip.because'),
      acted: false,
      refused
    });
  }
}
