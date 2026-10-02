/**
 * Getting rid of gear the character has outgrown (todo 12): what is never
 * touched whatever the ranking says, which ganghouse the worn emblem and a
 * carried key name, and whether an item is stashed, sold or dropped. Pure.
 * The ranking is `world/outgrownItems.ts`, the trip `OutgrownGear`; see
 * `mudengine-automation` › *Outgrown gear is stashed, sold or dropped*.
 */
import {
  carriesAbility,
  GANG_HOUSE_DEED_ABILITY,
  GANG_HOUSE_ITEM_ABILITY,
  GANG_SHOP_ITEM_ABILITY,
  LOYAL_ITEM_ABILITY
} from './abilities';
import type { ItemEntity } from './entities';
import { bareName, type ItemKind } from './items';
import { nameAnswersTo } from './world';

/** What becomes of an outgrown item: `hide` in the ganghouse, `sell` at a counter, `drop`. */
export type OutgrownWay = 'stash' | 'sell' | 'drop';

/** An unworn item no better than what is worn in its full slot (`world/outgrownItems.ts`). */
export interface OutgrownItem {
  item: ItemEntity;
  /** The slot as `WORN_SLOT` spells it. */
  slot: string;
  /** What is worn there that it is no better than. */
  worn: string;
  /** Its base price in copper; null where the realm states none or its rows disagree. */
  copper: number | null;
}

/** The command each way sends, as the server reads it (`StashCommand`, `SellCommand`, `DropCommand`). */
export function outgrownVerb(way: OutgrownWay): string {
  switch (way) {
    case 'stash':
      return 'hide';
    case 'sell':
      return 'sell';
    case 'drop':
      return 'drop';
    default: {
      const never: never = way;
      return never;
    }
  }
}

/** The part of a carried item, or a key's realm row, these rules read. */
export interface KitPiece {
  name: string;
  equipped: boolean;
  abilities?: ReadonlyArray<readonly [number, number]>;
  kind?: ItemKind;
  /** The realm's `Worn` code. */
  wornSlotCode?: number;
}

/** The names the player's own settings keep: the supply list and every gear set. */
export interface KeptNames {
  supplies: readonly string[];
  sets: readonly string[];
  /** The key ring, which the pack listing prints apart from the items. */
  keys: readonly string[];
}

const GANG_KIT = [GANG_HOUSE_DEED_ABILITY, GANG_HOUSE_ITEM_ABILITY, GANG_SHOP_ITEM_ABILITY];

/**
 * Whether an item stays whatever the ranking says: worn, a key, on the supply
 * list, in a gear set, loyal, or ganghouse gear (deed, emblem, keys). A quest run's or an item
 * trip's wants are kept by the trip never starting while either runs.
 */
export function keptRegardless(item: KitPiece, kept: KeptNames): boolean {
  if (item.equipped || item.kind === 'key') return true;
  const name = bareName(item.name);
  const named = (list: readonly string[]): boolean =>
    list.some((entry) => nameAnswersTo(name, bareName(entry)));
  if (named(kept.keys) || named(kept.supplies) || named(kept.sets)) return true;
  if (carriesAbility(item.abilities, LOYAL_ITEM_ABILITY)) return true;
  return GANG_KIT.some((id) => carriesAbility(item.abilities, id));
}

/** The `Worn` code of the slot the ganghouse emblem goes in (`gmud.mdb`: every emblem is 16). */
const EMBLEM_WORN = 16;

/** The house numbers a row names (`GHouseItem` or `GShopItem`, valued with the house). */
function housesOf(piece: KitPiece): number[] {
  return (piece.abilities ?? [])
    .filter(([id]) => id === GANG_HOUSE_ITEM_ABILITY || id === GANG_SHOP_ITEM_ABILITY)
    .map(([, house]) => house);
}

/**
 * The ganghouse the character can stash in: the house its worn emblem names,
 * where it also carries a key to that house. A key is a `key` row for the
 * house, or its keyring, which the realm files as kind 9 (`scroll`).
 */
export type Ganghouse = { house: number } | { missing: 'emblem' | 'key' };

export function ganghouseHeld(carried: readonly KitPiece[]): Ganghouse {
  const emblem = carried.find(
    (piece) => piece.equipped && piece.wornSlotCode === EMBLEM_WORN && housesOf(piece).length > 0
  );
  if (emblem === undefined) return { missing: 'emblem' };
  const houses = housesOf(emblem);
  const key = carried.find(
    (piece) =>
      piece !== emblem &&
      (piece.kind === 'key' || piece.kind === 'scroll') &&
      housesOf(piece).some((house) => houses.includes(house))
  );
  const house = houses[0];
  return key === undefined || house === undefined ? { missing: 'key' } : { house };
}

/** What decides the way: the item's worth in copper and which ways are open. */
export interface WayChoice {
  value: number;
  /** `tuning.outgrown.stashFromCopper`: worth keeping in the ganghouse from here. */
  stashFrom: number;
  /** `tuning.outgrown.sellFromCopper`: worth walking to a counter from here. */
  sellFrom: number;
  stash: boolean;
  sell: boolean;
  drop: boolean;
}

/**
 * Stashed where it is worth keeping and the ganghouse is open, else sold where
 * it is worth the walk and a counter buys it, else dropped; an item that can
 * be neither dropped nor sold is kept (null).
 */
export function outgrownWay(choice: WayChoice): OutgrownWay | null {
  if (choice.value >= choice.stashFrom && choice.stash) return 'stash';
  if (choice.value >= choice.sellFrom && choice.sell) return 'sell';
  if (choice.drop) return 'drop';
  return choice.sell ? 'sell' : null;
}
