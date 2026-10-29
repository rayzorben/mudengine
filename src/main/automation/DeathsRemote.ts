/**
 * `@death`: where this character last died, read off the realm's own
 * `Recent Deaths:` listing and sent back as `formatDeaths` writes it (the
 * user, 2026-10-29). `death` asks for the listing alone; where the realm has
 * retired that word (`Vocabulary.wordUnavailable`), `pro`, which ends with the
 * same rows. Asked fresh each time, since a death since the last listing is
 * the one the asker wants. Askers who arrive while one listing is owed share
 * it. A listing that has not come within `tuning.remotes.replyMs` is said here
 * and nothing is sent back. See `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { isPrompt, type Block } from '../../shared/blocks';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import { playerKey } from '../../shared/players';
import { readRecentDeath, type RecentDeath } from '../../shared/recentDeaths';
import { formatDeaths } from '../../shared/remotes';
import type { CommandQueue, Offered } from './CommandQueue';

const ANSWER: DecisionKind = 'remote-answer';

/** The words that print the listing, in the order they are tried. */
const LISTING_WORDS = ['death', 'pro'] as const;

export interface DeathsRemoteEvents {
  notice?: NoticeSink;
  /** Sends `body` to `to` on the channel `prefix` names, as every answer goes. */
  reply(to: string, body: string, prefix: string): void;
}

export class DeathsRemote {
  /** Who is owed the listing, by key, with the channel each asked on. */
  private readonly askers = new Map<string, { from: string; prefix: string }>();
  /** When the listing was first asked for, or null while nothing is owed. */
  private askedAt: number | null = null;
  /** Whether the ask has gone out, so the rows read are its answer. */
  private sent = false;
  /** Counts asks, so a send that outlived its own ask touches nothing. */
  private generation = 0;
  /** The rows read since the first one arrived, or null before any has. */
  private rows: RecentDeath[] | null = null;

  constructor(
    private readonly queue: Pick<CommandQueue, 'offer'>,
    private readonly events: DeathsRemoteEvents,
    private readonly now: () => number = Date.now
  ) {}

  /** `from` asked `@death` on `prefix`'s channel. */
  ask(from: string, prefix: string): void {
    const owed = this.askers.size > 0;
    this.askers.set(playerKey(from), { from, prefix });
    if (owed) return;
    const askedAt = this.now();
    this.askedAt = askedAt;
    const generation = ++this.generation;
    let offered: Offered = 'unavailable';
    let command: string = LISTING_WORDS[0];
    for (command of LISTING_WORDS) {
      offered = this.queue.offer({
        command,
        priority: 'probe',
        coalesceKey: 'remote:deaths',
        // Dropped with the deadline, so a listing nobody waits for is never asked.
        expiresAt: askedAt + tuning().remotes.replyMs,
        reason: t('automation.remotes.reasonDeaths', { from }),
        decision: ANSWER,
        onSent: () => {
          if (generation !== this.generation) return;
          this.sent = true;
          this.rows = null;
        }
      });
      if (offered !== 'unavailable') break;
    }
    if (offered === 'queued' || offered === 'joined') return;
    this.reset();
    this.events.notice?.(
      offered === 'unavailable'
        ? t('automation.remotes.deathsNoWord', { from })
        : t('automation.remotes.deathsNotAsked', { from, command, why: offered }),
      ANSWER
    );
  }

  /** Reads the rows once the ask has gone, and answers at the prompt behind them. */
  onBlock(block: Block): void {
    if (this.askedAt === null) return;
    if (this.sent && block.type === 'user-recent-death') {
      const row = readRecentDeath(block.groups);
      this.rows = [...(this.rows ?? []), ...(row === null ? [] : [row])];
      return;
    }
    if (this.rows !== null && isPrompt(block.type)) {
      const body = formatDeaths(this.rows);
      for (const { from, prefix } of this.askers.values()) this.events.reply(from, body, prefix);
      this.reset();
      return;
    }
    const { replyMs } = tuning().remotes;
    if (block.at - this.askedAt < replyMs) return;
    const seconds = Math.round(replyMs / 1000);
    for (const { from } of this.askers.values()) {
      this.events.notice?.(
        this.sent
          ? t('automation.remotes.deathsUnanswered', { from, seconds })
          : t('automation.remotes.deathsNeverSent', { from, seconds }),
        ANSWER
      );
    }
    this.reset();
  }

  reset(): void {
    this.generation += 1;
    this.askers.clear();
    this.askedAt = null;
    this.sent = false;
    this.rows = null;
  }
}
