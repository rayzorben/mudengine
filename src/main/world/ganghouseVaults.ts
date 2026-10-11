/**
 * Each gang house's vault, read off columns the world file already carries
 * (todo 51). The server keeps a `Gang House Number` per room
 * (`RoomManager.cs:126`) and spares those rooms the nightly cleanup
 * (`DoCleanup`, :535), but no `.mdb` export has the column (gmud.zip,
 * pmud.zip, stock 1.11p, 2026-10-10). The house's keys carry the number
 * instead (`GHouseItem`/`GShopItem`), and a vault is a room behind one: every
 * exit a door one house's key opens, or named `... Vault` with such a door.
 * 21 vaults over all 14 houses in gmud.zip and pmud.zip; 10 over 7 in stock,
 * whose export names no room. `todo/51-gang-house-census.mjs` measures it.
 */
import { housesOf } from '../../shared/outgrown';
import { roomId, type RoomId, type WorldItem, type WorldRoom } from '../../shared/world';

export interface VaultWorld {
  everyRoom(): Iterable<WorldRoom>;
  item(id: number): Pick<WorldItem, 'abilities'> | undefined;
}

export interface Vault {
  room: RoomId;
  name: string;
}

/** The realm's own word for the room: `Silver House Vault`. */
const VAULT_NAME = /\bvault$/i;

/** The house a vault belongs to, or null for any other room. */
export function vaultHouse(
  room: Pick<WorldRoom, 'name' | 'exits'>,
  houseOfKey: (key: number) => number | undefined
): number | null {
  const keyed = room.exits.map((exit) => {
    const key = exit.requirement?.keyId;
    return key === undefined ? undefined : houseOfKey(key);
  });
  const houses = new Set(keyed.filter((house): house is number => house !== undefined));
  // A door two houses' keys open belongs to neither house, so the room is left out.
  if (houses.size !== 1) return null;
  const [house] = houses;
  if (house === undefined) return null;
  const deadEnd = keyed.every((each) => each === house);
  return deadEnd || VAULT_NAME.test(room.name.trim()) ? house : null;
}

/** Worked out once per realm loaded, on the first ask: a scan of every room. */
const books = new WeakMap<VaultWorld, ReadonlyMap<number, readonly Vault[]>>();

function vaultBook(world: VaultWorld): ReadonlyMap<number, readonly Vault[]> {
  const kept = books.get(world);
  if (kept !== undefined) return kept;
  const houseOfKey = new Map<number, number | undefined>();
  const keyHouse = (key: number): number | undefined => {
    if (!houseOfKey.has(key)) {
      const row = world.item(key);
      // A deed names its house twice (`GHouseItem` and `GShopItem`); a key, once.
      const houses = new Set(row === undefined ? [] : housesOf(row));
      houseOfKey.set(key, houses.size === 1 ? [...houses][0] : undefined);
    }
    return houseOfKey.get(key);
  };
  const book = new Map<number, Vault[]>();
  for (const room of world.everyRoom()) {
    const house = vaultHouse(room, keyHouse);
    if (house === null) continue;
    const vault = { room: roomId(room.map, room.room), name: room.name.trim() };
    book.set(house, [...(book.get(house) ?? []), vault]);
  }
  books.set(world, book);
  return book;
}

/** The vaults of house `house`, in room order; none where the realm shows none. */
export function ganghouseVaults(world: VaultWorld, house: number): readonly Vault[] {
  return vaultBook(world).get(house) ?? [];
}
