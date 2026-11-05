/**
 * Whether a purse covers an item at a counter, as a plan asks it
 * (`NavigationOracle.affords`): the realm's price at that counter, charged at
 * the character's charm, out of the purse or a bank on record (todo 02). One
 * reading for the session's oracle and the route worker, which plans a lap
 * with the purse it was sent.
 */
import { chargedInCopper, coveredBy } from '../../../shared/coins';
import { bareName } from '../../../shared/items';
import type { CharacterState } from '../../../shared/character';
import { nameAnswersTo, type RoomId } from '../../../shared/world';
import type { WorldGraph } from '../WorldGraph';

/** What of the character a purse check reads; plain data, so it crosses to a worker. */
export interface Purse {
  charm: number | null;
  /** The copper carried; null while unread. */
  wealth: number | null;
  banks: ReadonlyArray<{ copper: number }>;
}

/** The character's purse as it stands. */
export function purseOf(state: Pick<CharacterState, 'progress' | 'inventory' | 'banks'>): Purse {
  return { charm: state.progress.charm, wealth: state.inventory.wealth, banks: state.banks };
}

type CounterWorld = Pick<WorldGraph, 'byId' | 'shop' | 'priceAt'>;

/** The counter in `shop` and its row answering to `name`, or null. */
export function counterLine(world: CounterWorld, name: string, shop: RoomId) {
  const row = world.byId(shop)?.shop;
  const counter = row === undefined ? undefined : world.shop(row);
  const line = counter?.items.find((each) => nameAnswersTo(bareName(each.name), bareName(name)));
  if (counter === undefined || line === undefined) return null;
  return { counter: counter.id, line };
}

/** What `name` costs at the counter in `shop`, from its realm row; null where it is not sold there. */
export function priceAt(world: CounterWorld, name: string, shop: RoomId): number | null {
  const found = counterLine(world, name, shop);
  return found === null ? null : world.priceAt(found.line.id, found.counter);
}

/** Whether `purse` covers item `item` at the counter in `room`; null where the price or the purse is unknown. */
export function affordsWith(
  world: CounterWorld & { item(id: number): { name: string } | undefined },
  purse: Purse,
  item: number,
  room: RoomId
): boolean | null {
  const name = world.item(item)?.name;
  const price = name === undefined ? null : priceAt(world, name, room);
  if (price === null) return null;
  return coveredBy(chargedInCopper(price, purse.charm), purse.wealth, purse.banks);
}
