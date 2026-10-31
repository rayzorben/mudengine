/**
 * `@death`: where this character last died, read off the realm's own
 * `Recent Deaths:` listing and sent back as `formatDeaths` writes it (the
 * user, 2026-10-29). `death` asks for the listing alone; where the realm has
 * retired that word (`Vocabulary.wordUnavailable`), `pro`, which ends with the
 * same rows. Asked fresh each time, since a death since the last listing is
 * the one the asker wants; the asking, sharing and giving up are
 * `ListingAsk`'s. See `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { isPrompt, type Block } from '../../shared/blocks';
import type { NoticeSink } from '../../shared/decisionSettings';
import { readRecentDeath, type RecentDeath } from '../../shared/recentDeaths';
import { formatDeaths } from '../../shared/remotes';
import type { CommandQueue } from './CommandQueue';
import { ListingAsk, type ListingAsker } from './ListingAsk';

export interface DeathsRemoteEvents {
  notice?: NoticeSink;
  /** Sends `body` to `to` on the channel `prefix` names, as every answer goes. */
  reply(to: string, body: string, prefix: string): void;
}

export class DeathsRemote {
  private readonly listing: ListingAsk<ListingAsker>;
  /** The rows read since the first one arrived, or null before any has. */
  private rows: RecentDeath[] | null = null;

  constructor(
    queue: Pick<CommandQueue, 'offer'>,
    private readonly events: DeathsRemoteEvents,
    now: () => number = Date.now
  ) {
    this.listing = new ListingAsk(
      queue,
      {
        remote: 'death',
        // `pro` where the vocabulary has retired `death`; it ends with the same rows.
        words: ['death', 'pro'],
        listing: () => t('automation.remotes.listingDeaths'),
        onSent: () => {
          this.rows = null;
        }
      },
      events.notice,
      now
    );
  }

  /** `from` asked `@death` on `prefix`'s channel. */
  ask(from: string, prefix: string): void {
    this.listing.ask({ from, prefix });
  }

  /** Reads the rows once the ask has gone, and answers at the prompt behind them. */
  onBlock(block: Block): void {
    if (!this.listing.owed) return;
    if (this.listing.sent !== null && block.type === 'user-recent-death') {
      const row = readRecentDeath(block.groups);
      this.rows = [...(this.rows ?? []), ...(row === null ? [] : [row])];
      return;
    }
    if (this.rows !== null && isPrompt(block.type)) {
      const body = formatDeaths(this.rows);
      this.listing.answer(({ from, prefix }) => this.events.reply(from, body, prefix));
      this.rows = null;
      return;
    }
    this.listing.expire(block.at);
  }

  reset(): void {
    this.listing.reset();
    this.rows = null;
  }
}
