/**
 * Buying a key on the way (todo 02): before a walk the player sent the
 * character on, the shorter way through a door whose key a shop sells, when
 * `movement.buyKeys` allows it and the keys cost at most `buyKeysMaxGold`
 * together. An unlisted pack is listed first, since the key may be in it, and
 * the walk is held until the listing is read. The navigation engine plans the
 * way (`boughtOffer`); `ItemErrand` buys, and `Supplies` draws from the bank
 * at a counter it is short at.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { wantedFrom, type Wanted } from '../automation/ItemErrand';
import { packRows, type CharacterState } from '../../shared/character';
import { chargedInCopper, COPPER_PER } from '../../shared/coins';
import { plannedFetches, type Plan } from '../../shared/navigation';
import type { MovementChoices } from '../../shared/walkChoices';
import { coinWords, itemsDemanded, type RoomId, type Route } from '../../shared/world';

export interface KeyBuyingParts {
  choices(): Pick<MovementChoices, 'buyKeys' | 'buyKeysMaxGold'>;
  /** The way through doors the walk goes round, every key on it bought (`Navigation.boughtTo`). */
  boughtTo(to: RoomId): { way: Route; plan: Extract<Plan, { kind: 'plan' }> } | null;
  /** What the counter in `room` asks for the item, in copper, before the charm. */
  priceAt(name: string, room: RoomId): number | null;
  /** Asks for the inventory through the command queue; whether the queue took it. */
  listPack(): boolean;
  notice(message: string): void;
}

/** What a player's walk does about the keys on the way. */
export type KeyChoice =
  { kind: 'walk' } | { kind: 'listing' } | { kind: 'buy'; items: Wanted[]; way: Route };

/** A walk held for the listing, and whether the listing came. */
export interface HeldWalk {
  route: Route;
  run: boolean;
  listed: boolean;
}

const WALK: KeyChoice = { kind: 'walk' };

export class KeyBuying {
  private held: { route: Route; run: boolean; since: number } | null = null;

  constructor(
    private readonly parts: KeyBuyingParts,
    private readonly now: () => number = () => Date.now()
  ) {}

  reset(): void {
    this.held = null;
  }

  /** Lets go of a held walk: where it was going, by name or room, or null where none was held. */
  drop(): string | null {
    const held = this.held;
    this.held = null;
    const last = held?.route.steps.at(-1);
    return held === null ? null : (last?.name ?? last?.to ?? t('session.walk.keys.nowhere'));
  }

  /** Before `route` is walked: walk it, wait for the listing, or buy the keys for a shorter way. */
  choose(route: Route, run: boolean, state: CharacterState): KeyChoice {
    this.held = null;
    const to = route.steps.at(-1)?.to;
    if (!this.parts.choices().buyKeys || to === undefined) return WALK;
    if (packRows(state.inventory) === null) return this.listFirst(route, run);
    if (route.keysAhead !== true) return WALK;
    const bought = this.parts.boughtTo(to);
    return bought === null ? WALK : this.buyFor(route, bought, state);
  }

  /** The held walk once the pack is listed, or once the wait is over; null meanwhile. */
  released(state: CharacterState): HeldWalk | null {
    const held = this.held;
    if (held === null) return null;
    const listed = packRows(state.inventory) !== null;
    if (!listed && this.now() - held.since < tuning().queue.unreadRetryMs) return null;
    this.held = null;
    if (!listed) this.parts.notice(t('session.walk.keys.unlisted'));
    return { route: held.route, run: held.run, listed };
  }

  /**
   * An unlisted pack is not an empty one: the router walks an unlisted pack
   * through a keyed door, and the key may be in it or may not.
   */
  private listFirst(route: Route, run: boolean): KeyChoice {
    const keyed = route.steps.some((step) => itemsDemanded(step.requirement ?? null).length > 0);
    if (!keyed && route.keysAhead !== true) return WALK;
    if (!this.parts.listPack()) {
      this.parts.notice(t('session.walk.keys.notAsked'));
      return WALK;
    }
    this.held = { route, run, since: this.now() };
    this.parts.notice(t('session.walk.keys.listing'));
    return { kind: 'listing' };
  }

  private buyFor(
    route: Route,
    bought: { way: Route; plan: Extract<Plan, { kind: 'plan' }> },
    state: CharacterState
  ): KeyChoice {
    const buys = bought.plan.steps.flatMap((step) => (step.kind === 'buy' ? [step] : []));
    const items = buys.map((buy) => buy.item.name).join(', ');
    let copper = 0;
    for (const buy of buys) {
      const price = this.parts.priceAt(buy.item.name, buy.room);
      if (price === null) {
        this.parts.notice(t('session.walk.keys.unpriced', { item: buy.item.name }));
        return WALK;
      }
      copper += chargedInCopper(price, state.progress.charm);
    }
    const ceiling = this.parts.choices().buyKeysMaxGold;
    if (copper > ceiling * COPPER_PER.gold) {
      this.parts.notice(
        t('session.walk.keys.overCeiling', { items, price: coinWords(copper), ceiling })
      );
      return WALK;
    }
    this.parts.notice(
      t('session.walk.keys.buying', {
        items,
        price: coinWords(copper),
        moves: bought.way.steps.length,
        instead: route.steps.length
      })
    );
    return { kind: 'buy', items: wantedFrom(plannedFetches(bought.plan)), way: bought.way };
  }
}
