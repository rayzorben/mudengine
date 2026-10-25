/**
 * What the pack keeps and sheds: junk to drop (`automation.drop`), outgrown
 * gear to stash, sell or drop (`automation.outgrown`) and the supplies list
 * (`automation.supplies`). Carved out of `config.ts` whole (todo 118); the
 * reasoning is in `mudengine-automation` › `parts/gear.md` and `parts/errands.md`.
 */
import { bool, int, isRecord, str } from './values';

export interface DropConfig {
  enabled: boolean;
  /** Item names to drop whenever the pack lists them. Prefixes, as `drop` reads them. */
  items: string[];
  /**
   * Only shed junk while the server itself grades the load as anything but
   * `None` (`Encumbrance: 840/2400 - Medium [35%]`). The server's own word,
   * because the thresholds behind the grades are unsampled — MegaMUD's "67%
   * is Heavy" is folklore this client has never seen on the wire. An unread
   * grade drops nothing: unknown is not encumbered, and a drop is not a thing
   * to do on a guess.
   */
  whenEncumbered: boolean;
  /**
   * Also drop anything the realm prices at **zero**, without naming it.
   *
   * The one entity predicate safe to act on unasked here, and only because it
   * is the realm's own explicit zero rather than an absence: a price the realm
   * does not state leaves the item alone, because "worth nothing" and "nobody
   * has said" are different claims and only one of them is a reason to throw
   * something away.
   *
   * Nothing the realm marks `Not Droppable` is ever dropped by it, nothing
   * equipped is, and the named list above stays the authority on everything
   * else — the realm does not mark quest items, which is why this is bounded
   * to a column it does mark.
   */
  worthless: boolean;
  /**
   * Keep an item an unfinished quest still needs, whatever the rows above say
   * (todo 52). On; off drops it like any other.
   */
  keepQuestItems: boolean;
}

/**
 * Getting rid of gear the character has outgrown (todo 12): an unworn item no
 * better than what is worn in a full slot, and not kept by the supply list, a
 * gear set, a key, `LoyalItem` or the ganghouse deed, emblem and keys, is
 * stashed in the ganghouse, sold, or dropped, one at a time. Off by default.
 */
export interface OutgrownConfig {
  enabled: boolean;
  /**
   * The ganghouse room to `hide` things in, as a loop stop names a room
   * (`Silver House Vault 15/921`). Empty uses the house's nearest vault the
   * world data shows (`ganghouseVaults`, todo 51).
   */
  ganghouseRoom: string;
  /**
   * Keep gear the realm data rates rare or limited, or does not rate at all
   * (`sheddable`). On; off sheds it like common gear.
   */
  keepRare: boolean;
  /** Worth this many copper or more, outgrown gear goes to the ganghouse. */
  stashFromCopper: number;
  /** Worth this many copper or more, outgrown gear is sold rather than dropped. */
  sellFromCopper: number;
  /** How many steps off the way to the bank a cash run goes to sell (todo 64). */
  sellDetour: number;
}

/**
 * One thing the character keeps a stock of — MegaMUD's *Must Have Minimum* /
 * *Minimum To Keep* / *Maximum To Get* on an item, with the shop it is bought
 * from.
 *
 * `name` is the realm's own spelling of the item, matched against the pack the
 * way the server matches a typed name (`nameAnswersTo`). `min` is the count
 * below which the character goes shopping and `max` what it buys back up to.
 * `buy` false is a row only collected where it is found, never bought, with no
 * minimum (todo 20261024-1810-01); `doneOnFound` removes the row once the pack
 * holds its maximum.
 * `shop` names the shop and `at` says which room, because a shop's name is not
 * a place (`WorldGraph.shopPlace`): null leaves the name to be settled when
 * the errand is planned, and refused out loud if it cannot be.
 */
export interface SupplyItem {
  name: string;
  min: number;
  max: number;
  shop: string;
  at: { map: number; room: number } | null;
  buy: boolean;
  doneOnFound: boolean;
}

/** A row made to buy something now: bought, and kept when found. */
export const BOUGHT_ROW: Pick<SupplyItem, 'buy' | 'doneOnFound'> = {
  buy: true,
  doneOnFound: false
};

/**
 * A row as every reader keeps it: a bought row's maximum is never under its
 * minimum, and a row collected and not bought has no minimum and collects at
 * least one.
 */
export function settledSupply(row: SupplyItem): SupplyItem {
  return row.buy
    ? { ...row, max: Math.max(row.min, row.max) }
    : { ...row, min: 0, max: Math.max(1, row.max) };
}

/**
 * Keeping the pack stocked — `automation.supplies`.
 *
 * Per character, because what one keeps is a fact about how it plays: a
 * caster's torches are a fighter's healing potions. When a listed item falls
 * below its minimum the client holds whatever it was doing, walks to the
 * shop, buys back up to the maximum one at a time, and lets the loop go on
 * from wherever the shop is. Everything about the trip is said out loud and
 * recorded as a safety decision, refusals included.
 */
export interface SuppliesConfig {
  enabled: boolean;
  items: SupplyItem[];
  /**
   * Copper withdrawn over a purchase's price when the purse is short and a
   * bank holds it; 0 withdraws exactly the shortfall.
   */
  cashBuffer: number;
  /**
   * What one doubling of a counter's price is worth in steps, when a row
   * names no shop: the detour decides and the price breaks the tie.
   */
  dearerSteps: number;
}

/** The outgrown block's figures and the rare-gear switch, as the file and both pages read them. */
export type OutgrownChoices = Pick<
  OutgrownConfig,
  'keepRare' | 'stashFromCopper' | 'sellFromCopper' | 'sellDetour'
>;

/** The supplies block's figures, as the file and both pages read them. */
export type SupplyChoices = Pick<SuppliesConfig, 'cashBuffer' | 'dearerSteps'>;

export const DEFAULT_DROP: DropConfig = {
  enabled: false,
  items: [],
  whenEncumbered: false,
  worthless: false,
  keepQuestItems: true
};

/** Each figure at what the client did before it was a setting. */
export const DEFAULT_OUTGROWN: OutgrownConfig = {
  enabled: false,
  ganghouseRoom: '',
  keepRare: true,
  stashFromCopper: 10_000,
  sellFromCopper: 1000,
  sellDetour: 10
};

export const DEFAULT_SUPPLIES: SuppliesConfig = {
  enabled: true,
  items: [],
  cashBuffer: 1000,
  dearerSteps: 20
};

/** The whole-number figures' bounds, one statement for the file and the settings screen. */
export const PACK_RANGES = {
  stashFromCopper: [0, 1_000_000_000],
  sellFromCopper: [0, 1_000_000_000],
  sellDetour: [0, 1000],
  cashBuffer: [0, 1_000_000_000],
  dearerSteps: [0, 1000]
} as const satisfies Partial<
  Record<keyof OutgrownChoices | keyof SupplyChoices, readonly [number, number]>
>;

/** The outgrown choices out of a raw block, each defaulted and bounded. */
export function outgrownChoices(raw: Record<string, unknown>): OutgrownChoices {
  const d = DEFAULT_OUTGROWN;
  return {
    keepRare: bool(raw['keepRare'], d.keepRare),
    stashFromCopper: int(raw['stashFromCopper'], d.stashFromCopper, ...PACK_RANGES.stashFromCopper),
    sellFromCopper: int(raw['sellFromCopper'], d.sellFromCopper, ...PACK_RANGES.sellFromCopper),
    sellDetour: int(raw['sellDetour'], d.sellDetour, ...PACK_RANGES.sellDetour)
  };
}

/** The supplies choices out of a raw block, each defaulted and bounded. */
export function supplyChoices(raw: Record<string, unknown>): SupplyChoices {
  const d = DEFAULT_SUPPLIES;
  return {
    cashBuffer: int(raw['cashBuffer'], d.cashBuffer, ...PACK_RANGES.cashBuffer),
    dearerSteps: int(raw['dearerSteps'], d.dearerSteps, ...PACK_RANGES.dearerSteps)
  };
}

export function normalizeDrop(value: unknown): DropConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_DROP;
  const items = Array.isArray(raw['items'])
    ? raw['items']
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : d.items;
  return {
    enabled: bool(raw['enabled'], d.enabled),
    items,
    whenEncumbered: bool(raw['whenEncumbered'], d.whenEncumbered),
    worthless: bool(raw['worthless'], d.worthless),
    keepQuestItems: bool(raw['keepQuestItems'], d.keepQuestItems)
  };
}

export function normalizeOutgrown(value: unknown): OutgrownConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_OUTGROWN;
  return {
    enabled: bool(raw['enabled'], d.enabled),
    ganghouseRoom: str(raw['ganghouseRoom'], d.ganghouseRoom).trim(),
    ...outgrownChoices(raw)
  };
}

/** The most of one item a supplies row keeps or buys. */
export const SUPPLY_COUNT_MAX = 1000;

/**
 * The supplies list, bounded because it crossed a file somebody edits by hand.
 *
 * A row with no name is dropped rather than defaulted, as a buff with no name
 * is. `min` and `max` are whole counts; a `max` below `min` reads as `min`, so
 * "keep at least three" with no ceiling stated buys back to three. `shop` is
 * the shop's name as the realm's item index spells it and `at` the room the
 * name was settled to, kept beside it for the reason a loop stop carries
 * coordinates: six rooms are called General Store.
 */
export function normalizeSupplies(value: unknown): SuppliesConfig {
  const raw = isRecord(value) ? value : {};
  const d = DEFAULT_SUPPLIES;
  const items: SupplyItem[] = [];
  if (Array.isArray(raw['items'])) {
    for (const entry of raw['items']) {
      if (!isRecord(entry)) continue;
      const name = str(entry['name'], '').trim();
      if (name.length === 0) continue;
      const min = int(entry['min'], 0, 0, SUPPLY_COUNT_MAX);
      const buy = bool(entry['buy'], true);
      const max = int(entry['max'], 0, 0, SUPPLY_COUNT_MAX);
      const shop = str(entry['shop'], '').trim();
      const at = isRecord(entry['at']) ? entry['at'] : null;
      const map = at === null ? null : int(at['map'], -1, 0, 999);
      const room = at === null ? null : int(at['room'], -1, 0, 999_999);
      items.push(
        settledSupply({
          name,
          min,
          max,
          shop,
          at: map !== null && room !== null && map >= 0 && room >= 0 ? { map, room } : null,
          buy,
          doneOnFound: bool(entry['doneOnFound'], false)
        })
      );
    }
  }
  return { enabled: bool(raw['enabled'], d.enabled), items, ...supplyChoices(raw) };
}
