/**
 * Going and getting the thing a route needs (todo 07, 2026-09-13).
 *
 * A route that crosses a keyed door already says what it needs — `Route.walls`
 * where this plan itself crosses it, `hazards[].needs` where a room's spell
 * wants something carried (`itemWanted` reads both). This closes the loop: the
 * realm knows where an item comes from (a shop that stocks it, a monster that
 * drops it), so the client goes and gets it and then walks the route that
 * wanted it.
 *
 * Two shapes and one ending. **Bought**: a session supply row with a floor of
 * one, through the errand that already knows how to walk to a counter, read a
 * `list` and confirm a `You just bought …`. **Found**: a loop over the rooms
 * the realm says its droppers live in, with the item's name added to what the
 * character picks up for as long as the errand runs, until the pack holds it.
 * Either way the owed route is walked afterwards and it is said which of the
 * two happened — because a key is worth keeping and a thing bought for one
 * door is not.
 *
 * Every refusal is said and traced (`SafetyDecision`, action `collect`). See
 * `mudengine-automation` § *A route that needs an item goes and gets it*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { SupplyItem } from '../../shared/config';
import type { Loop } from '../../shared/loops';
import { carriedCount } from '../../shared/supplies';
import type { BuyingPlace, RoomId, Route } from '../../shared/world';

/** One place the realm says an item comes from. */
export interface ItemSources {
  /**
   * The counters that stock it, least out of the way first.
   *
   * **Rooms, not names.** A shop name is what the item index holds and what a
   * card prints; it is not somewhere to walk to, because one shop row stands in
   * several rooms — and handing a name to the shopping errand meant it asked
   * `shopPlace` to resolve it and was refused for the ambiguity (reported
   * 2026-09-16: *2 rooms hold a shop called Boat Launch*, said to a character
   * whose route walked through one of them).
   */
  shops: readonly BuyingPlace[];
  /** Rooms the monsters that drop it live in, nearest first. */
  lairs: ReadonlyArray<{ id: RoomId; name: string; mob: string; steps: number }>;
}

export interface ItemPlanner {
  here(): RoomId | null;
  /**
   * Where the realm says this item comes from, from where the character stands
   * on the way to `to` — the counters by what stopping at each would add to
   * that journey, the lairs nearest first.
   */
  sourcesOf(item: { id: number; name: string }, to: RoomId | null): ItemSources;
  /**
   * Hand a one-off supply row to the shopping errand. Returns its refusal, or
   * null once it is walking. The row is never written to the player's file.
   */
  buy(row: SupplyItem): string | null;
  /** Whether the shopping errand is still on this row. */
  buying(): boolean;
  /** Run a loop filed nowhere, as the hunt does. */
  runLoop(loop: Loop): string | null;
  looping(): boolean;
  stopLoop(reason: string): void;
  /** Take this by name while the errand runs — session-scoped, never the file. */
  alsoTake(name: string): void;
  stopTaking(name: string): void;
  /** The route the player asked for, walked once the pack holds the item. */
  walk(route: Route): string | null;
  /** Whether the player's own supply list names this item, so it is kept. */
  kept(name: string): boolean;
}

export interface ItemEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

interface Wanted {
  id: number;
  name: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'buying'; item: Wanted; owes: Route }
  | { kind: 'hunting'; item: Wanted; owes: Route; mob: string }
  /**
   * The pack holds it and the way is still being offered to the walker.
   *
   * Its own phase because the handover is not instant: collecting is a loop,
   * and a loop steps on without waiting for the server to confirm what it
   * picked up, so at the moment the pack holds the thing there is a move of
   * this client's own still on the wire and `Walker.start` refuses to plan
   * across it. `why` is the last refusal, said only if the window runs out.
   */
  | { kind: 'delivering'; item: Wanted; owes: Route; until: number; why: string };

const ACTION = 'collect';

export class ItemErrand {
  private phase: Phase = { kind: 'idle' };

  constructor(
    private readonly planner: ItemPlanner,
    private readonly events: ItemEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  reset(): void {
    this.give();
    this.phase = { kind: 'idle' };
  }

  /** Whether an errand of this kind is running. */
  get running(): boolean {
    return this.phase.kind !== 'idle';
  }

  /**
   * Go and get `item`, then walk `owes`.
   *
   * Returns a refusal for the window that asked — this is a press, so the
   * person is looking at the answer — and null once something is under way.
   * **The pack is asked first**: an item the character is already carrying
   * means the route is walked now, which is the commonest case for a key that
   * was collected on an earlier trip.
   */
  collect(item: Wanted, owes: Route, state: CharacterState): string | null {
    if (this.phase.kind !== 'idle') return t('automation.collect.refusalBusy');
    if (state.phase !== 'in-game') return t('automation.collect.refusalNotInRealm');
    if (carriedCount(state, item.name) > 0) {
      const refused = this.planner.walk(owes);
      return refused ?? null;
    }
    // Where the errand is taking this character afterwards, so the counter is
    // chosen by how far off *that* road it is rather than by how near it is to
    // where the character happens to be standing.
    const sources = this.planner.sourcesOf(item, owes.steps.at(-1)?.to ?? null);
    /*
     * **Bought before found**, where both are known: a counter is a fixed
     * price and a walk, and a drop is a fight and a chance. The player's own
     * supply list is what makes a found item worth keeping afterwards, which
     * is the other half of this decision.
     */
    const counter = sources.shops[0];
    if (counter !== undefined) {
      /*
       * **Addressed by room, never by name.** `at` is the field the item
       * panel's own shop picker writes and the one `shopRoom` resolves without
       * asking anything further; a `shop` with no `at` sends the errand back
       * through `shopPlace`, which refuses a name standing in several rooms —
       * correctly, for a name a *person* typed, and uselessly here, where the
       * room is the thing that was just chosen. The name rides along for the
       * sentence the errand says.
       */
      const row: SupplyItem = {
        name: item.name,
        min: 1,
        max: 1,
        shop: counter.shop,
        at: { map: counter.map, room: counter.room }
      };
      const refused = this.planner.buy(row);
      if (refused !== null) return this.refuse(item, refused);
      this.phase = { kind: 'buying', item, owes };
      /*
       * Two literal calls rather than one sentence with a figure that is
       * sometimes zero: *0 steps off the way* is a number where the reader
       * wants a fact, and a counter the route already walks through is the
       * whole point of choosing by the detour.
       */
      this.events.notice?.(
        counter.detour === 0
          ? t('automation.collect.buyingOnTheWay', {
              item: item.name,
              shop: counter.shop,
              room: counter.roomName
            })
          : t('automation.collect.buying', {
              item: item.name,
              shop: counter.shop,
              room: counter.roomName,
              detour: counter.detour
            })
      );
      return null;
    }
    const lair = sources.lairs[0];
    if (lair === undefined) return this.refuse(item, t('automation.collect.refusalNoSource'));
    /*
     * The loop is built from the realm's own rooms for those monsters, as the
     * Hunting card builds one, and filed nowhere. Its stops are every room
     * within reach that holds a dropper, nearest first.
     */
    const stops = sources.lairs.map((room) => ({ room: `${room.name} ${room.id}` }));
    const loop: Loop = { name: t('automation.collect.loopName', { item: item.name }), stops };
    // Picked up while the errand runs, and only while it runs.
    this.planner.alsoTake(item.name);
    const refused = this.planner.runLoop(loop);
    if (refused !== null) {
      this.planner.stopTaking(item.name);
      return this.refuse(item, refused);
    }
    this.phase = { kind: 'hunting', item, owes, mob: lair.mob };
    this.events.notice?.(
      t('automation.collect.hunting', { item: item.name, mob: lair.mob, room: lair.name })
    );
    return null;
  }

  /**
   * The player took the character somewhere else, or died: the errand is off.
   *
   * Said out loud, because an errand that stopped silently is a route the
   * player thinks is still owed.
   */
  abandon(reason: string): void {
    if (this.phase.kind === 'idle') return;
    const { item } = this.phase;
    this.give();
    this.phase = { kind: 'idle' };
    this.refuse(item, t('automation.collect.abandoned', { item: item.name, why: reason }));
  }

  /** Every state change: has the pack got it yet? */
  onCharacter(state: CharacterState): void {
    if (this.phase.kind === 'idle') return;
    if (state.phase !== 'in-game') {
      this.abandon(t('automation.collect.whyLeftRealm'));
      return;
    }
    const { item, owes } = this.phase;
    /*
     * Still trying to hand the way over: try again from where the character
     * now stands. Every attempt re-plans, so this costs nothing until one
     * takes — and the refusal it is waiting out (a move of this client's own
     * still unanswered) clears the moment the room for it arrives.
     */
    if (this.phase.kind === 'delivering') {
      const refused = this.planner.walk(owes);
      if (refused === null) {
        this.phase = { kind: 'idle' };
        return;
      }
      if (this.now() >= this.phase.until) {
        this.phase = { kind: 'idle' };
        this.events.notice?.(t('automation.collect.refusalRouteRefused', { why: refused }));
        return;
      }
      this.phase = { ...this.phase, why: refused };
      return;
    }
    if (carriedCount(state, item.name) > 0) {
      this.deliver(item, owes);
      return;
    }
    /*
     * The shopping errand gave up — unsold, too dear, no route. It has already
     * said why in its own words, so this says only that the route is not being
     * walked, which is the fact the player is waiting on.
     */
    if (this.phase.kind === 'buying' && !this.planner.buying()) {
      this.phase = { kind: 'idle' };
      this.refuse(item, t('automation.collect.refusalNotBought', { item: item.name }));
      return;
    }
    // And the lap stopping means the fights are over one way or another.
    if (this.phase.kind === 'hunting' && !this.planner.looping()) {
      this.give();
      this.phase = { kind: 'idle' };
      this.refuse(item, t('automation.collect.refusalLapStopped', { item: item.name }));
    }
  }

  /** The pack holds it: stop collecting, say which happened, and walk on. */
  private deliver(item: Wanted, owes: Route): void {
    const hunting = this.phase.kind === 'hunting';
    this.give();
    this.phase = { kind: 'idle' };
    if (hunting) this.planner.stopLoop(t('automation.collect.stoppedGotIt', { item: item.name }));
    /*
     * **Which happened is worth saying.** A key the player's own supply list
     * names is kept — `supplies.items` lists `black star key` as *found* — and
     * a thing bought for one door is not, so the two sentences differ and each
     * says what the pack is now carrying around.
     */
    this.events.notice?.(
      this.planner.kept(item.name)
        ? t('automation.collect.gotAndKept', { item: item.name })
        : t('automation.collect.gotForTheDoor', { item: item.name })
    );
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.collect.becauseDoor', { item: item.name }),
      acted: true
    });
    /*
     * **Offered, not fired once.** The loop that just found this has a step on
     * the wire — it stepped on before the server confirmed the pick-up — so
     * the walker refuses to plan across the unanswered move, and a single
     * attempt meant the thing was collected and the way it was collected for
     * was never walked (the reported failure, 2026-09-14). Held instead and
     * tried again on every state until it takes, or until the window is up and
     * the refusal is a real one worth saying.
     */
    const refused = this.planner.walk(owes);
    if (refused === null) return;
    this.phase = {
      kind: 'delivering',
      item,
      owes,
      until: this.now() + tuning().walk.errandHandoverMs,
      why: refused
    };
  }

  /** Stop taking what was only ever wanted for this errand. */
  private give(): void {
    if (this.phase.kind === 'idle') return;
    this.planner.stopTaking(this.phase.item.name);
  }

  private refuse(item: Wanted, why: string): string {
    this.events.notice?.(why);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.collect.becauseDoor', { item: item.name }),
      acted: false,
      refused: why
    });
    return why;
  }
}
