/**
 * Going to a counter and selling named items there, each by `sell <item>`
 * (`SellCommand` takes the whole stack the name answers to). Started only by
 * an extension through the host (`selling.sell`), never by the client itself:
 * the client supplies the walk and the confirmation (`Handover`) and decides
 * nothing about what to sell or where. Yields to a fight, a rest, a move, a
 * walk and every other trip; walks as a leg; holds the lap; dropped on a
 * death; says every refusal and how each trip ended. See
 * `mudengine-automation` › *Outgrown gear is stashed, sold or dropped*.
 */
import type { CommandQueue } from './CommandQueue';
import { Handover, type HandoverEnd, type HandoverPlanner } from './Handover';
import { t } from '../app/i18n';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { SaleTrip } from '../../shared/selling';
import type { RoomId } from '../../shared/world';
import { asRoomAndItems, tripRefusal, type RoomAndItems, type TripPlanner } from './askedTrip';
import type { SessionModule } from './Module';

export interface SellTripPlanner extends HandoverPlanner, TripPlanner {
  /** The counter's name in the room, or null where the room holds none. */
  counterIn(room: RoomId): string | null;
}

export interface SellTripEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

/** What an extension asks for: the counter's room, and the items as the pack names them. */
export type SellAsk = RoomAndItems;

/** An extension's ask, parsed at the boundary (`asRoomAndItems`). */
export const asSellAsk = asRoomAndItems;

const ACTION = 'sell';

export class SellTrip implements SessionModule {
  private readonly handover: Handover;
  private trip: { ask: SellAsk; shop: string; held: boolean } | null = null;

  constructor(
    private enabled: boolean,
    queue: CommandQueue,
    private readonly planner: SellTripPlanner,
    private readonly events: SellTripEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {
    this.handover = new Handover(queue, planner, { ended: (end) => this.ended(end) }, now);
  }

  configure(enabled: boolean): void {
    this.enabled = enabled;
    // Switched off mid-trip: nothing is sold on arrival, and the lap goes back.
    if (!enabled && this.trip !== null) this.finish(t('automation.hostTrip.endedSwitchedOff'));
  }

  reset(): void {
    this.handover.cancel();
    this.trip = null;
  }

  get busy(): boolean {
    return this.trip !== null;
  }

  get current(): SaleTrip | null {
    const stage = this.handover.stage;
    if (this.trip === null || stage === null) return null;
    const { ask, shop } = this.trip;
    return {
      room: ask.room,
      shop,
      items: ask.items,
      stage: stage === 'acting' ? 'selling' : 'walking'
    };
  }

  /** A death: the counter it was walking to is somewhere else now. */
  abandon(): void {
    if (this.trip !== null) this.finish(t('automation.hostTrip.endedDied'));
  }

  /** One trip; its refusal, said and traced, or null once under way. */
  sell(ask: SellAsk, state: CharacterState): string | null {
    const shop = this.planner.counterIn(ask.room);
    const trip = { enabled: this.enabled, running: this.trip !== null };
    const why = tripRefusal(ask.items, trip, state, this.planner);
    if (why !== null) return this.refuse(ask.items, shop ?? ask.room, why);
    if (shop === null) {
      return this.refuse(
        ask.items,
        ask.room,
        t('automation.sellTrip.refusalNoCounter', { room: ask.room })
      );
    }
    const held = this.planner.looping();
    this.trip = { ask, shop, held };
    if (held) this.planner.hold();
    const started = this.handover.start(
      {
        at: ask.room,
        verb: 'sell',
        items: ask.items,
        key: 'sell',
        reason: (item) => t('automation.sellTrip.reasonSelling', { item, shop })
      },
      state
    );
    if (started.kind === 'refused') {
      this.release();
      return this.refuse(ask.items, shop, started.why);
    }
    if (started.kind === 'walking') {
      this.events.notice?.(
        t('automation.sellTrip.going', { items: ask.items.join(', '), shop, steps: started.steps })
      );
    }
    return null;
  }

  onCharacter(state: CharacterState): void {
    if (this.trip !== null) this.handover.onCharacter(state);
  }

  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    this.handover.onWalkEnded(arrived, reason, state);
  }

  private ended(end: HandoverEnd): void {
    switch (end.kind) {
      case 'not-reached':
        this.finish(
          t('automation.hostTrip.endedNotReached', {
            why: end.why ?? t('automation.hostTrip.whyStopped')
          })
        );
        return;
      case 'handed': {
        const unsold = [...end.unanswered, ...end.unsent];
        this.finish(
          unsold.length === 0
            ? null
            : t('automation.sellTrip.endedUnsold', { items: unsold.join(', ') }),
          end.gone
        );
        return;
      }
      default: {
        const never: never = end;
        return never;
      }
    }
  }

  /** The trip over: what came of it said and traced, and the lap given back. */
  private finish(refused: string | null, sold: readonly string[] = []): void {
    const trip = this.trip;
    this.handover.cancel();
    if (trip === null) return;
    this.release();
    if (sold.length > 0) {
      this.events.notice?.(
        t('automation.sellTrip.done', { items: sold.join(', '), shop: trip.shop })
      );
      this.events.decided?.({
        at: this.now(),
        action: ACTION,
        because: this.because(trip.ask.items, trip.shop),
        acted: true
      });
    }
    if (refused !== null) this.refuse(trip.ask.items, trip.shop, refused);
  }

  private release(): void {
    const held = this.trip?.held ?? false;
    this.trip = null;
    if (held) this.planner.release();
  }

  private because(items: readonly string[], shop: string): string {
    return t('automation.sellTrip.because', { items: items.join(', '), shop });
  }

  /** Said and traced; the reason, for the caller to hand back. */
  private refuse(items: readonly string[], shop: string, why: string): string {
    const sentence = t('automation.sellTrip.refused', { why });
    this.events.notice?.(sentence);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: this.because(items, shop),
      acted: false,
      refused: sentence
    });
    return why;
  }
}
