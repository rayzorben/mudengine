/**
 * The kinds of place the palette finds the nearest of (todo 70): what a player
 * types to get there, and the answer main gives.
 *
 * A weapon or armour counter is found by what it restocks, not by
 * `Shops.ShopType`: GreaterMUD's 53 weapon counters include 10 of type 1, and
 * its 84 armour counters 8 of type 2; the rest are types 0 and 10
 * (`todo/70-shop-kind-census.txt`). The others are `ShopKind`'s words. There
 * is no inn: no shipped realm places a type 9 row, and `Albion Inn` is a
 * tavern.
 */
import type { WorldRoom } from './world';

export type PlaceKind = 'weapons' | 'armour' | 'trainer' | 'bank' | 'temple' | 'tavern';

export const PLACE_KINDS: readonly PlaceKind[] = [
  'weapons',
  'armour',
  'trainer',
  'bank',
  'temple',
  'tavern'
];

/** A kind from the wire, or null: the one parse an addressed query's argument gets. */
export function asPlaceKind(value: unknown): PlaceKind | null {
  return PLACE_KINDS.find((kind) => kind === value) ?? null;
}

/** One place of a kind, and how many moves away it is for this character now. */
export interface NearPlace {
  kind: PlaceKind;
  /** The shop's own row: two rows can share a name (`trainersTaking`). */
  shop: number;
  name: string;
  moves: number;
  room: WorldRoom;
}
