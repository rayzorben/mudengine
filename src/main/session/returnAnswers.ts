/**
 * What `return` typed in the game does (`shared/returnCommand.ts`): alone it
 * lists what is carried for other players (`LootBook`), and with a name it
 * answers the `give`s that hand that player's back. What a listed pack no
 * longer holds (dropped, sold, already given) is not sent: it is said and
 * taken off the file. Nothing is forgotten at the send: each `You give` takes its
 * own off, so what the server did not hand over is still on the file and
 * `return` tries again.
 */
import type { CharacterState, Denomination } from '../../shared/character';
import { stockPlural } from '../../shared/coins';
import type { NoticeSink } from '../../shared/decisionSettings';
import type { ReturnCommand } from '../../shared/returnCommand';
import { carriedCount } from '../../shared/supplies';
import { t } from '../app/i18n';
import type { Loot, LootBook, LootCoins, LootItem } from './LootBook';

/** The realm's name for a count of a coin, `gold crowns` (`CoinReader.plural`). */
export type CoinName = (coin: Denomination) => string;

export interface ReturnParts {
  book: LootBook;
  state(): CharacterState;
  coinName: CoinName;
  notice: NoticeSink;
}

/** One `give` of a `return`. */
export interface ReturnGive {
  command: string;
  /** What it hands over, off the player's file if the server says it cannot be given. */
  loot: Loot;
  /**
   * The words after `give` as a refusal may repeat them, lower case: as sent,
   * and for a coin the stock spelling a renamed one is read back to (`toStock`).
   */
  words: readonly string[];
}

/** The most coins one `give` hands over: the count is refused past four digits (`GiveCommand.cs`). */
const MOST_COINS_A_GIVE = 9999;

/**
 * The words after `give` for a coin. It goes by its whole name: `give 1
 * silver` with a silver ring in the pack is answered `Please be more
 * specific` (`GiveCommand.cs`).
 */
function coinWords({ coin, count }: LootCoins, name: CoinName): string {
  return `${count} ${name(coin)}`;
}

function itemWords({ name, count }: LootItem): string {
  return count > 1 ? `${count} ${name}` : name;
}

/** Coins and items as one notice lists them. */
export function lootListed({ coins, items }: Omit<Loot, 'player'>, name: CoinName): string {
  return [...coins.map((each) => coinWords(each, name)), ...items.map(itemWords)].join(', ');
}

/** What the pack still has of `carried` and what it has not; an unread count is still had. */
function split<T extends { count: number }>(
  carried: readonly T[],
  have: (each: T) => number | null
): { kept: T[]; gone: T[] } {
  const kept: T[] = [];
  const gone: T[] = [];
  for (const each of carried) {
    const had = Math.min(each.count, have(each) ?? each.count);
    if (had > 0) kept.push({ ...each, count: had });
    if (had < each.count) gone.push({ ...each, count: each.count - had });
  }
  return { kept, gone };
}

function gives({ player, coins, items }: Loot, coinName: CoinName): ReturnGive[] {
  const all: ReturnGive[] = [];
  const give = (words: readonly string[], loot: Omit<Loot, 'player'>): void => {
    all.push({
      command: `give ${words[0]} to ${player}`,
      loot: { player, ...loot },
      words: words.map((each) => each.toLowerCase())
    });
  };
  for (const { coin, count } of coins) {
    for (let left = count; left > 0; left -= MOST_COINS_A_GIVE) {
      const some = { coin, count: Math.min(left, MOST_COINS_A_GIVE) };
      give([coinWords(some, coinName), coinWords(some, stockPlural)], { coins: [some], items: [] });
    }
  }
  for (const item of items) give([itemWords(item)], { coins: [], items: [item] });
  return all;
}

/** The gives one `return` sends, in order; every notice it has is said. */
export function answerReturn(command: ReturnCommand, parts: ReturnParts): ReturnGive[] {
  const { book, notice, coinName } = parts;
  switch (command.kind) {
    case 'usage':
      notice(t('session.return.usage'));
      return [];
    case 'list': {
      const all = book.all();
      if (all.length === 0) notice(t('session.return.none'));
      for (const loot of all) {
        const things = lootListed(loot, coinName);
        notice(t('session.return.carrying', { player: loot.player, things }));
      }
      return [];
    }
    case 'give': {
      const carried = book.carriedFor(command.player);
      if (carried === null) {
        notice(t('session.return.nobody', { player: command.player }));
        return [];
      }
      if ('several' in carried) {
        const players = carried.several.join(', ');
        notice(t('session.return.several', { name: command.player, players }));
        return [];
      }
      const state = parts.state();
      const { inventory } = state;
      const { player } = carried;
      const coins = split(carried.coins, ({ coin }) => inventory.coins[coin]);
      // A pack nobody has listed says nothing about what it lacks.
      const items = split(carried.items, ({ name }) =>
        inventory.listedAt === null ? null : carriedCount(state, name)
      );
      if (coins.gone.length > 0 || items.gone.length > 0) {
        const gone = { player, coins: coins.gone, items: items.gone };
        book.forget(gone);
        notice(t('session.return.gone', { player, things: lootListed(gone, coinName) }));
      }
      return gives({ player, coins: coins.kept, items: items.kept }, coinName);
    }
    default: {
      const never: never = command;
      return never;
    }
  }
}
