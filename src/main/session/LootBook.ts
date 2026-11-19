/**
 * The coins and items this character is carrying for other players, a file
 * per player: what `recover` took out of their corpse and no `give` has
 * handed back yet. `RecoveredLoot` writes it from the server's lines and
 * `returnAnswers.ts` reads it for `return`. Kept in memory only, so closing
 * the client forgets it.
 */
import { DENOMINATIONS, type Denomination } from '../../shared/character';
import { playerKey } from '../../shared/players';

export interface LootCoins {
  coin: Denomination;
  count: number;
}

export interface LootItem {
  /** The item as `You took` spelled it. */
  name: string;
  count: number;
}

/** Some of what is carried for one player. */
export interface Loot {
  /** The player as the corpse named them. */
  player: string;
  coins: readonly LootCoins[];
  items: readonly LootItem[];
}

interface File {
  player: string;
  coins: Map<Denomination, number>;
  /** By the item's name in lower case. */
  items: Map<string, LootItem>;
}

function shown(file: File): Loot {
  return {
    player: file.player,
    coins: DENOMINATIONS.flatMap((coin) => {
      const count = file.coins.get(coin);
      return count === undefined ? [] : [{ coin, count }];
    }),
    items: [...file.items.values()].map((item) => ({ ...item }))
  };
}

export class LootBook {
  private readonly files = new Map<string, File>();

  /** Everything carried, a player at a time. */
  all(): Loot[] {
    return [...this.files.values()].map(shown);
  }

  /** Whether anything is filed under exactly this name. */
  has(player: string): boolean {
    return this.files.has(playerKey(player));
  }

  /**
   * What is carried for the player a typed name means: the name whole, or the
   * start of one name only, as the server reads a name. Several where it
   * starts more than one.
   */
  carriedFor(typed: string): Loot | { several: string[] } | null {
    const key = playerKey(typed);
    const exact = this.files.get(key);
    if (exact !== undefined) return shown(exact);
    const starting = [...this.files.values()].filter((file) =>
      playerKey(file.player).startsWith(key)
    );
    if (starting.length > 1) return { several: starting.map((file) => file.player) };
    return starting[0] === undefined ? null : shown(starting[0]);
  }

  /** Adds to a player's file. */
  add({ player, coins, items }: Loot): void {
    const key = playerKey(player);
    const file = this.files.get(key) ?? { player, coins: new Map(), items: new Map() };
    this.files.set(key, file);
    for (const { coin, count } of coins) file.coins.set(coin, (file.coins.get(coin) ?? 0) + count);
    for (const { name, count } of items) {
      const at = name.toLowerCase();
      file.items.set(at, { name, count: (file.items.get(at)?.count ?? 0) + count });
    }
  }

  /** Takes coins and items off a player's file: given, or no longer carried. */
  forget({ player, coins, items }: Loot): void {
    const file = this.files.get(playerKey(player));
    if (file === undefined) return;
    for (const { coin, count } of coins) {
      const left = (file.coins.get(coin) ?? 0) - count;
      if (left > 0) file.coins.set(coin, left);
      else file.coins.delete(coin);
    }
    for (const { name, count } of items) {
      const at = name.toLowerCase();
      const had = file.items.get(at);
      if (had !== undefined && had.count > count)
        file.items.set(at, { ...had, count: had.count - count });
      else file.items.delete(at);
    }
    if (file.coins.size === 0 && file.items.size === 0) this.files.delete(playerKey(player));
  }
}
