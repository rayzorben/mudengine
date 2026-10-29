/**
 * The realm's rarity joined onto what searching turned up, so the Room card's
 * Finds tab reads the same figure as the item card and the outgrown list
 * (`RarityBook`). A find is named as the server printed it; a name that is no
 * one item row is `unknown`, and cash has none.
 */
import { isCash, type Find, type Logged } from '../../shared/finds';
import { rarityBook, type RarityWorld } from './itemRarity';

/** What the join reads of the realm; `WorldGraph` is one. */
export interface FindRarityWorld extends RarityWorld {
  itemIdNamed(name: string): number | null;
}

/** Each name is rated once per call: a log of two thousand rows repeats its names. */
export function ratedFinds(rows: readonly Logged[], world: FindRarityWorld | undefined): Find[] {
  const book = world === undefined ? null : rarityBook(world);
  const rated = new Map<string, Find['rarity']>();
  const rate = (name: string): Find['rarity'] => {
    const id = world?.itemIdNamed(name) ?? null;
    if (book === null || id === null) return { rarity: 'unknown', hours: null };
    const { rarity, hours } = book.of(id);
    return { rarity, hours };
  };
  return rows.map((row) => {
    if (isCash(row)) return { ...row, rarity: null };
    const known = rated.get(row.name) ?? rate(row.name);
    rated.set(row.name, known);
    return { ...row, rarity: known };
  });
}
