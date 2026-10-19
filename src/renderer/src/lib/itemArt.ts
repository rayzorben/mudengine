/**
 * Item pictures (todo 20261018-2032-01): which picture shows a thing the
 * character carries, wears or counts. The pictures are the art run's cutouts
 * at 512 px, shipped beside the window in `public/item-art/`; the index
 * (`assets/item-art-index.json`) says which picture belongs to which realm row
 * and name. Both are written by `npm run build:item-art`. Pure; the hook that
 * loads the index is `useItemArt`.
 */
import { DENOMINATIONS, type Denomination, type RealmFamily } from '@shared/character';

/** The realms the art run drew rows for; any other matches by name only. */
const INDEXED_REALMS = ['paradigm', 'greatermud'] as const;
type IndexedRealm = (typeof INDEXED_REALMS)[number];

export interface ItemArtIndex {
  /** Lower-cased item name to picture key: the first row drawn under that name. */
  byName: Readonly<Record<string, string>>;
  /** Per realm, the `Items` row number (as a string) to picture key. */
  byId: Readonly<Partial<Record<IndexedRealm, Readonly<Record<string, string>>>>>;
  coins: Readonly<Partial<Record<Denomination, string>>>;
  /** The portraits drawn, as `race-class` slugs. */
  portraits: readonly string[];
}

const isKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

function keyTable(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [name, key] of Object.entries(value)) if (isKey(key)) out[name] = key;
  return out;
}

/** The index as the build wrote it, or null for anything that is not format 1. */
export function asItemArtIndex(raw: unknown): ItemArtIndex | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.format !== 1) return null;
  const byName = keyTable(value.byName);
  if (byName === null) return null;
  const ids = typeof value.byId === 'object' && value.byId !== null ? value.byId : {};
  const byId: Partial<Record<IndexedRealm, Record<string, string>>> = {};
  for (const realm of INDEXED_REALMS) {
    const table = keyTable((ids as Record<string, unknown>)[realm]);
    if (table !== null) byId[realm] = table;
  }
  const coinTable = keyTable(value.coins) ?? {};
  const coins: Partial<Record<Denomination, string>> = {};
  for (const name of DENOMINATIONS)
    if (coinTable[name] !== undefined) coins[name] = coinTable[name];
  const portraits = Array.isArray(value.portraits)
    ? value.portraits.filter((one): one is string => typeof one === 'string')
    : [];
  return { byName, byId, coins, portraits };
}

const pictureUrl = (key: string): string => `item-art/${key}.webp`;

function indexedRealm(realm: RealmFamily | null): IndexedRealm | null {
  return INDEXED_REALMS.find((one) => one === realm) ?? null;
}

/**
 * The picture for a thing by its realm row where the row is known, else by its
 * name; null where the run drew nothing for it.
 */
export function pictureOf(
  index: ItemArtIndex,
  realm: RealmFamily | null,
  thing: { name: string; id?: number }
): string | null {
  const indexed = indexedRealm(realm);
  const byRow =
    indexed !== null && thing.id !== undefined
      ? index.byId[indexed]?.[String(thing.id)]
      : undefined;
  const key = byRow ?? index.byName[thing.name.trim().toLowerCase()];
  return key === undefined ? null : pictureUrl(key);
}

export function coinPicture(index: ItemArtIndex, coin: Denomination): string | null {
  const key = index.coins[coin];
  return key === undefined ? null : pictureUrl(key);
}

const slug = (word: string): string =>
  word
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

/** The portrait drawn for this race and class, or null for one not drawn yet. */
export function portraitOf(
  index: ItemArtIndex,
  race: string | null,
  className: string | null
): string | null {
  if (race === null || className === null) return null;
  const name = `${slug(race)}-${slug(className)}`;
  return index.portraits.includes(name) ? `item-art/portraits/${name}.webp` : null;
}
