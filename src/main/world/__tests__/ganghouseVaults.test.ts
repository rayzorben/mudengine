import { describe, expect, it } from 'vitest';

import { GANG_HOUSE_ITEM_ABILITY, GANG_SHOP_ITEM_ABILITY } from '../../../shared/abilities';
import type { Direction, WorldExit, WorldItem, WorldRoom } from '../../../shared/world';
import { ganghouseVaults, vaultHouse, type VaultWorld } from '../ganghouseVaults';
import { WorldGraph } from '../WorldGraph';

/* The orange house and the silver house as gmud.zip has them (todo 51 census, 2026-10-10). */
const KEYS: Record<number, Pick<WorldItem, 'abilities'>> = {
  1020: { abilities: [[GANG_HOUSE_ITEM_ABILITY, 2]] }, // orange key
  1021: { abilities: [[GANG_HOUSE_ITEM_ABILITY, 2]] }, // ornate orange key
  1045: { abilities: [[GANG_HOUSE_ITEM_ABILITY, 8]] }, // ornate silver key
  844: { abilities: [[GANG_SHOP_ITEM_ABILITY, 1]] }, // red key, which runs the red shop
  1124: { abilities: [] } // a key to no house
};

const exit = (direction: Direction, to: number, keyId?: number): WorldExit => ({
  direction,
  map: 15,
  room: to,
  requirement: keyId === undefined ? null : { kind: 'key', raw: `Key: ${keyId}`, keyId }
});

const room = (number: number, name: string, exits: WorldExit[]): WorldRoom =>
  ({ map: 15, room: number, name, exits }) as WorldRoom;

const ROOMS = [
  room(880, 'Orange House Room', [exit('s', 881, 1021), exit('e', 879)]),
  room(881, 'Orange House Vault', [exit('n', 880, 1021)]),
  room(877, 'Orange House Room', [exit('n', 879), exit('s', 874, 1020), exit('e', 876)]),
  // A way out that is no door: found by its name alone.
  room(921, 'Silver House Vault', [exit('n', 2320), exit('e', 922), exit('w', 920, 1045)]),
  room(9458, 'Red House Vault', [exit('w', 907, 844)]),
  room(500, 'Closet', [exit('n', 501, 1124)])
];

const world: VaultWorld = {
  everyRoom: () => ROOMS,
  item: (id) => KEYS[id]
};

describe('ganghouseVaults', () => {
  it('finds a dead end behind a house key, and a room the realm names a vault', () => {
    expect(ganghouseVaults(world, 2)).toEqual([{ room: '15/881', name: 'Orange House Vault' }]);
    expect(ganghouseVaults(world, 8)).toEqual([{ room: '15/921', name: 'Silver House Vault' }]);
    expect(ganghouseVaults(world, 1)).toEqual([{ room: '15/9458', name: 'Red House Vault' }]);
  });

  it('shows no vault for a house the realm keys no door for', () => {
    expect(ganghouseVaults(world, 3)).toEqual([]);
  });

  it('takes no room behind a door two houses open, or a key to no house', () => {
    const house = (key: number): number | undefined => (key === 1 ? 4 : key === 2 ? 5 : undefined);
    const between = room(1, 'Vault', [exit('n', 2, 1), exit('s', 3, 2)]);
    expect(vaultHouse(between, house)).toBeNull();
    expect(vaultHouse(ROOMS[5]!, (key) => (key === 1124 ? undefined : 9))).toBeNull();
  });
});

describe('the vaults of the shipped Paradigm world', () => {
  /* Measured by todo/51-gang-house-census.mjs on pmud.zip: 21 vaults over all 14 houses. */
  it('shows every house a vault', () => {
    const shipped = WorldGraph.load('resources/world/paradigm.jsonl.gz');
    const counts = Array.from({ length: 14 }, (_, n) => ganghouseVaults(shipped, n + 1).length);
    expect(counts).toEqual([1, 1, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(ganghouseVaults(shipped, 8).map((vault) => vault.room)).toEqual(['15/921']);
  });
});
