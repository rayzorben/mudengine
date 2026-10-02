/**
 * Getting rid of gear the character has outgrown (todo 12, 2026-10-02): the
 * planner buys the better item and the old one stays in the pack. One item at
 * a time, it is hidden in the ganghouse (`hide <item>`), sold at a counter
 * that buys it, or dropped (`outgrownWay`), and the pack losing it is the
 * confirmation. A trip in the shape `TrainErrand` has: yields to a fight, a
 * move, a walk and anything busy; walks as a leg; holds the lap; says every
 * refusal. Off by default. See `mudengine-automation` › *Outgrown gear is
 * stashed, sold or dropped*.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { OutgrownConfig } from '../../shared/config';
import {
  outgrownVerb,
  outgrownWay,
  type OutgrownItem,
  type OutgrownWay
} from '../../shared/outgrown';
import { carriedCount } from '../../shared/supplies';
import {
  nameAnswersTo,
  roomId,
  type BuyingPlace,
  type RoomId,
  type Route
} from '../../shared/world';
import type { SessionModule } from './Module';

export interface OutgrownPlanner {
  /** Where the character stands, or null while unplaced. */
  here(): RoomId | null;
  /** The pack's outgrown gear that nothing keeps (`outgrownItems` less `keptRegardless`). */
  outgrown(state: CharacterState): OutgrownItem[];
  /** The ganghouse room to stash in, or why there is none, as a sentence. */
  ganghouse(state: CharacterState): { room: RoomId; name: string } | { refused: string };
  /** The counter least far off that buys the item, a route reaching it; null where none does. */
  counterFor(item: OutgrownItem): BuyingPlace | null;
  /** A route to a room, or the reason there is none. */
  routeTo(room: RoomId): Route | string;
  /** Hands the route to the walker as a leg. Returns its refusal, or null. */
  walk(route: Route): string | null;
  moveInFlight(): boolean;
  walking(): boolean;
  /** An escape, a supply trip, a trainer, an item fetch or a quest run has the character. */
  busy(): boolean;
  looping(): boolean;
  /** Holds the lap for the trip, and gives it back. */
  hold(): void;
  release(): void;
}

export interface OutgrownEvents {
  notice?(message: string): void;
  /** The trace: what was done, and what was refused and why. */
  decided?(decision: SafetyDecision): void;
}

/** Where an item is taken to be got rid of: the ganghouse room, a counter, or here. */
interface Plan {
  item: OutgrownItem;
  way: OutgrownWay;
  /** The room the verb is sent in; null is where the character stands. */
  at: RoomId | null;
  place: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'walking'; plan: Plan; held: boolean }
  /** `sentAt` null while the verb waits in the queue. */
  | {
      kind: 'acting';
      plan: Plan;
      before: number;
      held: boolean;
      queuedAt: number;
      sentAt: number | null;
    };

const ACTION = 'outgrown gear';

/** Why an item goes: what is worn in its slot instead. */
function outgrownBecause(found: OutgrownItem): string {
  return t('automation.outgrown.reason', {
    item: found.item.name,
    worn: found.worn,
    slot: found.slot
  });
}
const KEY = 'outgrown:act';

export class OutgrownGear implements SessionModule {
  private phase: Phase = { kind: 'idle' };
  /** The pack last looked at, so an unchanged one is not ranked again on every line. */
  private looked: CharacterState['inventory'] | null = null;
  /** Each item's ways the server or the walk refused, so the next is tried instead. */
  private refused = new Map<string, Set<OutgrownWay>>();
  /** Sentences said once each: why nothing stashes, an item kept for a reason. */
  private said = new Set<string>();

  constructor(
    private config: OutgrownConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly planner: OutgrownPlanner,
    private readonly events: OutgrownEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: OutgrownConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
    // Switched off mid-trip: nothing is sold or dropped on arrival, and the lap goes back.
    if (!this.switchedOn && this.phase.kind !== 'idle') this.end(this.phase.held);
    // The room or the switch moved: everything is worth asking again.
    this.looked = null;
    this.said.clear();
  }

  reset(): void {
    this.phase = { kind: 'idle' };
    this.looked = null;
    this.refused.clear();
    this.said.clear();
  }

  /** Whether the trip has the character: walking to a room, or waiting on the pack. */
  get busy(): boolean {
    return this.phase.kind !== 'idle';
  }

  /** A death: the room it was walking to is several maps away now. */
  abandon(): void {
    if (this.phase.kind === 'idle') return;
    this.end(this.phase.held);
    this.events.notice?.(t('automation.outgrown.abandonedDied'));
  }

  private get switchedOn(): boolean {
    return this.enabled && this.config.enabled;
  }

  onCharacter(state: CharacterState): void {
    if (!this.switchedOn || state.phase !== 'in-game') return;
    if (this.phase.kind === 'acting') {
      this.settle(this.phase, state);
      return;
    }
    if (this.phase.kind !== 'idle') return;
    if (state.inventory.listedAt === null || state.inventory === this.looked) return;
    // Never over a fight, a rest, a move, a walk or anybody else's trip.
    if (state.inCombat || state.combat.attackers.length > 0) return;
    if (state.vitals.resting || state.vitals.meditating) return;
    if (this.planner.moveInFlight() || this.planner.walking() || this.planner.busy()) return;
    this.looked = state.inventory;
    for (const item of this.planner.outgrown(state)) {
      const plan = this.planFor(item, state);
      if (plan === null) continue;
      this.go(plan, state);
      return;
    }
  }

  /** Where this item goes, or null where it is kept, said once with the reason. */
  private planFor(item: OutgrownItem, state: CharacterState): Plan | null {
    const name = item.item.name;
    // `hide`, `sell` and `drop` take every item the name answers to, worn ones too.
    if (state.inventory.items.some((each) => each.equipped && nameAnswersTo(each.name, name))) {
      this.sayOnce(t('automation.outgrown.keptTwin', { item: name }));
      return null;
    }
    if (item.copper === null) {
      this.sayOnce(t('automation.outgrown.keptUnpriced', { item: name, worn: item.worn }));
      return null;
    }
    const refused = this.refused.get(name) ?? new Set<OutgrownWay>();
    const { stashFromCopper, sellFromCopper } = tuning().outgrown;
    const house = item.copper >= stashFromCopper ? this.planner.ganghouse(state) : null;
    if (house !== null && 'refused' in house && !refused.has('stash')) {
      this.sayOnce(house.refused);
    }
    const droppable = item.item.notDroppable !== true;
    // Two sweeps of the map, so asked only where a sale could be the answer.
    const sellable =
      !refused.has('sell') && (item.copper >= sellFromCopper || !droppable || refused.has('drop'));
    const counter = sellable ? this.planner.counterFor(item) : null;
    const way = outgrownWay({
      value: item.copper,
      stashFrom: stashFromCopper,
      sellFrom: sellFromCopper,
      stash: house !== null && 'room' in house && !refused.has('stash') && droppable,
      sell: counter !== null,
      drop: droppable && !refused.has('drop')
    });
    switch (way) {
      case null:
        this.sayOnce(t('automation.outgrown.keptNoWay', { item: name }));
        return null;
      case 'stash':
        return house !== null && 'room' in house
          ? { item, way, at: house.room, place: house.name }
          : null;
      case 'sell':
        return counter === null
          ? null
          : { item, way, at: roomId(counter.map, counter.room), place: counter.shop };
      case 'drop':
        return { item, way, at: null, place: '' };
      default: {
        const never: never = way;
        return never;
      }
    }
  }

  private go(plan: Plan, state: CharacterState): void {
    if (plan.at === null || plan.at === this.planner.here()) {
      this.act(plan, state, false);
      return;
    }
    const route = this.planner.routeTo(plan.at);
    if (typeof route === 'string') {
      this.refuse(plan, route);
      return;
    }
    // A blocked route is a reason, not a walk of no steps.
    if (route.blocked) {
      this.refuse(plan, route.reason ?? t('automation.walk.refusalNoRoute'));
      return;
    }
    const refused = this.planner.walk(route);
    if (refused !== null) {
      this.refuse(plan, refused);
      return;
    }
    this.events.notice?.(
      t('automation.outgrown.going', {
        item: plan.item.item.name,
        verb: outgrownVerb(plan.way),
        place: plan.place,
        steps: route.steps.length,
        worn: plan.item.worn
      })
    );
    const held = this.planner.looping();
    if (held) this.planner.hold();
    this.phase = { kind: 'walking', plan, held };
  }

  /** The walker's report: the trip's own leg ended, or somebody else's walk did. */
  onWalkEnded(arrived: boolean, reason: string | null, state: CharacterState): void {
    if (this.phase.kind !== 'walking') return;
    const { plan, held } = this.phase;
    if (!this.switchedOn) {
      this.end(held);
      return;
    }
    if (!arrived || this.planner.here() !== plan.at) {
      this.end(held);
      this.refuse(plan, reason ?? t('automation.outgrown.whyStopped'));
      return;
    }
    this.act(plan, state, held);
  }

  private act(plan: Plan, state: CharacterState, held: boolean): void {
    const name = plan.item.item.name;
    const phase: Phase = {
      kind: 'acting',
      plan,
      before: carriedCount(state, name),
      held,
      queuedAt: this.now(),
      sentAt: null
    };
    this.phase = phase;
    const offered = this.queue.offer({
      command: `${outgrownVerb(plan.way)} ${name}`,
      priority: 'probe',
      coalesceKey: KEY,
      reason: outgrownBecause(plan.item),
      onSent: () => {
        if (this.phase === phase) phase.sentAt = this.now();
      }
    });
    // Not now is not never: the next pack that moves asks again.
    if (offered !== 'queued' && offered !== 'joined') this.end(held);
  }

  /** The pack holding fewer is the confirmation; silence past `confirmMs` is a refusal. */
  private settle(phase: Extract<Phase, { kind: 'acting' }>, state: CharacterState): void {
    const { plan, before, held, queuedAt, sentAt } = phase;
    const name = plan.item.item.name;
    if (carriedCount(state, name) < before) {
      this.end(held);
      this.events.notice?.(
        t('automation.outgrown.done', {
          item: name,
          verb: outgrownVerb(plan.way),
          worn: plan.item.worn
        })
      );
      this.events.decided?.({
        at: this.now(),
        action: ACTION,
        because: outgrownBecause(plan.item),
        acted: true
      });
      return;
    }
    const confirmMs = tuning().outgrown.confirmMs;
    if (sentAt === null) {
      // Dropped from the queue unsent: asked again from the next pack, nothing refused.
      if (this.now() - queuedAt >= confirmMs) this.end(held);
      return;
    }
    if (this.now() - sentAt < confirmMs) return;
    this.end(held);
    this.refuse(plan, t('automation.outgrown.whyUnanswered', { verb: outgrownVerb(plan.way) }));
  }

  /** Back to idle, the lap given back where it was held, and the pack worth looking at again. */
  private end(held: boolean): void {
    this.phase = { kind: 'idle' };
    this.looked = null;
    if (held) this.planner.release();
  }

  /** That way is not tried again for this item this session; the next is. */
  private refuse(plan: Plan, why: string): void {
    const name = plan.item.item.name;
    const ways = this.refused.get(name) ?? new Set<OutgrownWay>();
    ways.add(plan.way);
    this.refused.set(name, ways);
    this.looked = null;
    const sentence = t('automation.outgrown.refused', {
      item: name,
      verb: outgrownVerb(plan.way),
      why
    });
    this.events.notice?.(sentence);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: outgrownBecause(plan.item),
      acted: false,
      refused: sentence
    });
  }

  private sayOnce(sentence: string): void {
    if (this.said.has(sentence)) return;
    this.said.add(sentence);
    this.events.notice?.(sentence);
  }
}
