/**
 * What `recover` takes out of another player's corpse, remembered until it is
 * given back. `recover` with a password empties a friend's corpse into this
 * pack (`RecoverCommand.cs`): every coin and item between `You begin to pick
 * through the corpse of <player>...` and the end line goes on that player's
 * file (`LootBook`). A `You give ... to <player>` takes it off again, typed
 * by hand or sent by `return <player>`, whose gives go out here a prompt at
 * a time (`returnAnswers.ts`). Any give to that player of the same coin or
 * item counts, the character's own included: it reached them. The
 * character's own corpse is not filed: that is its own gear coming back.
 */
import { isPrompt, type Block } from '../../shared/blocks';
import { coinNamed, type CharacterState } from '../../shared/character';
import type { CoinReader } from '../../shared/coins';
import type { NoticeSink } from '../../shared/decisionSettings';
import { isOwnName, playerKey } from '../../shared/players';
import type { ReturnCommand } from '../../shared/returnCommand';
import { t } from '../app/i18n';
import type { CommandQueue } from '../automation/CommandQueue';
import type { SessionModule } from '../automation/Module';
import { LootBook, type LootCoins, type LootItem } from './LootBook';
import { cancelKeyed, sayRestRefused } from './macros';
import { answerReturn, lootListed, type CoinName, type ReturnGive } from './returnAnswers';

function numberOf(text: string | undefined): number {
  const count = Number(text ?? '1');
  return Number.isInteger(count) && count > 0 ? count : 1;
}

export class RecoveredLoot implements SessionModule {
  private readonly book = new LootBook();
  /** The corpse being picked through now, and whether it has given anything up yet. */
  private open: { player: string; filed: boolean } | null = null;
  /**
   * The gives of a `return` on the wire, oldest first, each until the next
   * prompt: the server answers a command and then prompts, so a give still
   * here is one a `You don't have ... to give!` can be about. A prompt for
   * something else takes one off early, and then its refusal forgets nothing.
   */
  private unanswered: ReturnGive[] = [];
  private runs = 0;

  constructor(
    private readonly queue: Pick<CommandQueue, 'enqueue' | 'cancel' | 'holding'>,
    private readonly state: () => CharacterState,
    /** The realm's coin words, read at each use: a reload may rename them. */
    private readonly words: { readonly coins: Pick<CoinReader, 'plural'> },
    private readonly notice: NoticeSink
  ) {}

  private readonly coinName: CoinName = (coin) => this.words.coins.plural(coin);

  /**
   * A recover or a `return` cut off by the connection is closed. The files
   * are kept: a reconnect leaves what they list in the pack, still to be
   * given back.
   */
  reset(): void {
    this.open = null;
    this.unanswered = [];
  }

  /** One `return`: its notices said, and its gives queued as the player's own typed commands. */
  answer(command: ReturnCommand): void {
    const { book, state, coinName, notice, queue } = this;
    const gives = answerReturn(command, { book, state, coinName, notice });
    const player = gives[0]?.loot.player;
    if (player === undefined) return;
    /*
     * `return` typed again for the same player starts over, and never gives
     * twice: the file only shrinks at each `You give`, so a second give of
     * the same thing would come out of the character's own purse. What the
     * last one still has waiting goes, and a give on the wire is left out.
     */
    const key = `return:${playerKey(player)}:`;
    cancelKeyed(key, queue);
    const onTheWire = this.unanswered.map((give) => give.command);
    this.runs += 1;
    for (const [index, give] of gives.entries()) {
      const sent = onTheWire.indexOf(give.command);
      if (sent >= 0) {
        onTheWire.splice(sent, 1);
        continue;
      }
      const taken = queue.enqueue({
        command: give.command,
        priority: 'user',
        typed: true,
        // Unique per give: two of them never stand for one.
        coalesceKey: `${key}${this.runs}:${index}`,
        reason: t('session.return.reason', { player }),
        onSent: () => this.unanswered.push(give)
      });
      if (taken) continue;
      // A refusal takes the rest with it, said once, as a macro's does.
      cancelKeyed(key, queue);
      return sayRestRefused(give.command, queue, notice);
    }
  }

  onBlock(block: Block): void {
    const g = block.groups;
    const { notice } = this;
    if (isPrompt(block.type)) {
      this.unanswered.shift();
      return;
    }
    switch (block.type) {
      case 'user-picks-through-corpse': {
        const player = g['player'] ?? '';
        const self = this.state().name;
        // A name not read yet may be this corpse's: nothing is filed for it.
        const others = player.length > 0 && self !== null && !isOwnName(self, player);
        this.open = others ? { player, filed: false } : null;
        return;
      }
      case 'user-gets-coins': {
        const coin = coinNamed(g['coin'] ?? '');
        if (coin !== undefined) this.file([{ coin, count: numberOf(g['count']) }], []);
        return;
      }
      case 'player-gets': {
        const name = g['item'];
        // Another player's `picks up` carries their name; this character's `You took` none.
        if (g['player'] !== undefined || name === undefined) return;
        this.file([], [{ name, count: numberOf(g['count']) }]);
        return;
      }
      case 'user-recovers-corpse': {
        const done = this.open;
        this.open = null;
        if (done?.filed !== true) return;
        const { player } = done;
        return notice(t('session.return.filed', { player, word: player.toLowerCase() }));
      }
      case 'user-gives': {
        // The server prints the name it matched, which may be more than the corpse's one word.
        const player = (g['target'] ?? '').trim().split(/\s+/)[0] ?? '';
        if (!this.book.has(player)) return;
        const count = numberOf(g['count']);
        const coin = g['coin'] === undefined ? undefined : coinNamed(g['coin']);
        this.book.forget({
          player,
          coins: coin === undefined ? [] : [{ coin, count }],
          items: g['item'] === undefined ? [] : [{ name: g['item'], count }]
        });
        if (!this.book.has(player)) notice(t('session.return.returned', { player }));
        return;
      }
      case 'user-gives-nothing': {
        const what = (g['what'] ?? '').trim().toLowerCase();
        // Left for its prompt to take off, and read once.
        const at = this.unanswered.findIndex((give) => give.words.includes(what));
        const refused = this.unanswered[at];
        if (refused === undefined) return;
        this.unanswered[at] = { ...refused, words: [] };
        this.book.forget(refused.loot);
        const things = lootListed(refused.loot, this.coinName);
        return notice(t('session.return.refused', { player: refused.loot.player, things }));
      }
      default:
        return;
    }
  }

  /** Onto the file of the corpse being picked through, if one is. */
  private file(coins: readonly LootCoins[], items: readonly LootItem[]): void {
    if (this.open === null) return;
    this.open.filed = true;
    this.book.add({ player: this.open.player, coins, items });
  }
}
