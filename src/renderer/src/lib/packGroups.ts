/**
 * The pack panel's sections (todo 20261018-2032-01): what the character
 * wears, then what it carries by the realm's `ItemType`, with tokens apart, and
 * the load split by what makes it up. Keys and coins are never items here: the
 * server prints them on lines of their own. Pure; `PackPanel` draws it.
 */
import type { CarriedItem, Inventory } from '@shared/character';
import type { ItemKind } from '@shared/items';

export type PackGroup = 'worn' | 'gear' | 'use' | 'scroll' | 'other';
export const PACK_GROUPS: readonly PackGroup[] = ['worn', 'gear', 'use', 'scroll', 'other'];

/** Every kind has a section, so a new kind fails to compile until it is placed. */
const GROUP_OF: Readonly<Record<ItemKind, Exclude<PackGroup, 'worn'>>> = {
  weapon: 'gear',
  armour: 'gear',
  food: 'use',
  drink: 'use',
  scroll: 'scroll',
  light: 'other',
  trap: 'other',
  key: 'other',
  container: 'other',
  sign: 'other',
  misc: 'other'
};

/**
 * A token is an item whose name ends in `token` (the user, 2026-10-18):
 * Paradigm's `quest token` and `no token`. The realm marks none, so the name
 * is the one sign there is.
 */
export function isToken(name: string): boolean {
  return /\btoken$/i.test(name.trim());
}

export interface PackContents {
  groups: Readonly<Record<PackGroup, readonly CarriedItem[]>>;
  tokens: readonly CarriedItem[];
}

/** Null where nobody has listed the pack: unknown, not empty. */
export function packOf(inventory: Inventory): PackContents | null {
  if (inventory.listedAt === null) return null;
  const groups: Record<PackGroup, CarriedItem[]> = {
    worn: [],
    gear: [],
    use: [],
    scroll: [],
    other: []
  };
  const tokens: CarriedItem[] = [];
  for (const item of inventory.items) {
    // Worn is a section of its own, in the order the server printed it.
    if (item.equipped) groups.worn.push(item);
    else if (isToken(item.name)) tokens.push(item);
    // A thing the realm does not know is among the other things, never dropped.
    else groups[item.kind === undefined ? 'other' : GROUP_OF[item.kind]].push(item);
  }
  return { groups, tokens };
}

export interface Weight {
  /** What the rows the realm can weigh come to. */
  known: number;
  /** Rows it cannot weigh: while any, `known` is at least, never the whole. */
  unknown: number;
}

/** What some items weigh by the realm's figure for each row, a count as that many. */
export function weightOf(items: readonly CarriedItem[]): Weight {
  let known = 0;
  let unknown = 0;
  for (const item of items)
    if (item.encumbrance === undefined) unknown++;
    else known += item.encumbrance * (item.count ?? 1);
  return { known, unknown };
}

export interface Load {
  now: number;
  max: number;
  word: string | null;
  worn: number;
  carried: number;
  /** What the server counted that the item table cannot weigh: coins, rows it does not know. */
  rest: number;
}

/** The load bar's parts, or null until the server has printed `Encumbrance:`. */
export function loadOf(inventory: Inventory): Load | null {
  const { encumbrance: now, encumbranceMax: max } = inventory;
  if (now === null || max === null) return null;
  const worn = weightOf(inventory.items.filter((item) => item.equipped)).known;
  const carried = weightOf(inventory.items.filter((item) => !item.equipped)).known;
  return {
    now,
    max,
    word: inventory.encumbranceWord,
    worn,
    carried,
    rest: Math.max(0, now - worn - carried)
  };
}
