/**
 * A remote answered off a listing the realm prints when asked, asked fresh
 * each time: `@death` off `death`, `@abil` off `abil`. One listing is owed at
 * a time and everybody who asks while it is owed shares it. The ask expires at
 * `tuning.remotes.replyMs`, a send of a lapsed ask arms nothing (a generation
 * count), and a listing that has not come by then is said here and nothing
 * goes back. The remote supplies its words and its reading of the listing.
 * See `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import { playerKey } from '../../shared/players';
import type { RemoteName } from '../../shared/remotes';
import type { CommandQueue, Offered } from './CommandQueue';

const ANSWER: DecisionKind = 'remote-answer';

/** Somebody waiting on the listing, and the channel to answer them on. */
export interface ListingAsker {
  from: string;
  prefix: string;
}

export interface ListingAskSpec {
  /** The remote, which the notices name as `@death`. */
  remote: RemoteName;
  /** The words that print the listing, tried in order past one the realm lacks. */
  words: readonly [string, ...string[]];
  /** The listing as the notices name it: `Recent Deaths`. */
  listing(): string;
  /** Runs when the ask goes out, so the remote reads only what follows it. */
  onSent?(): void;
}

export class ListingAsk<A extends ListingAsker> {
  /** Who is owed the listing, by key. */
  private readonly askers = new Map<string, A>();
  /** When the listing was first asked for, or null while nothing is owed. */
  private askedAt: number | null = null;
  /** When the ask went out, or null before it has. */
  private sentAt: number | null = null;
  /** Counts asks, so a send that outlived its own ask touches nothing. */
  private generation = 0;

  constructor(
    private readonly queue: Pick<CommandQueue, 'offer'>,
    private readonly spec: ListingAskSpec,
    private readonly notice: NoticeSink | undefined,
    private readonly now: () => number = Date.now
  ) {}

  /** When the ask went out, or null while it has not (or nothing is owed). */
  get sent(): number | null {
    return this.sentAt;
  }

  /** Whether anybody is waiting. */
  get owed(): boolean {
    return this.askedAt !== null;
  }

  /** `asker` asked; the listing is asked for unless one is already owed. */
  ask(asker: A): void {
    const owed = this.askers.size > 0;
    this.askers.set(playerKey(asker.from), asker);
    if (owed) return;
    const askedAt = this.now();
    this.askedAt = askedAt;
    const generation = ++this.generation;
    const remote = `@${this.spec.remote}`;
    let offered: Offered = 'unavailable';
    let command: string = this.spec.words[0];
    for (command of this.spec.words) {
      offered = this.queue.offer({
        command,
        priority: 'probe',
        coalesceKey: `remote:listing:${remote}`,
        // Dropped with the deadline, so a listing nobody waits for is never asked.
        expiresAt: askedAt + tuning().remotes.replyMs,
        reason: t('automation.remotes.reasonListing', { from: asker.from, remote }),
        decision: ANSWER,
        onSent: () => {
          if (generation !== this.generation) return;
          this.sentAt = this.now();
          this.spec.onSent?.();
        }
      });
      if (offered !== 'unavailable') break;
    }
    if (offered === 'queued' || offered === 'joined') return;
    this.reset();
    const from = asker.from;
    this.notice?.(
      offered === 'unavailable'
        ? t('automation.remotes.listingNoWord', {
            from,
            remote,
            words: this.spec.words.join(t('automation.remotes.listingWordsOr'))
          })
        : t('automation.remotes.listingNotAsked', { from, remote, command, why: offered }),
      ANSWER
    );
  }

  /** Sends each asker their answer, and owes nothing more. */
  answer(reply: (asker: A) => void): void {
    for (const asker of this.askers.values()) reply(asker);
    this.reset();
  }

  /** At the deadline, says so to each asker and owes nothing more. */
  expire(at: number): void {
    if (this.askedAt === null) return;
    const { replyMs } = tuning().remotes;
    if (at - this.askedAt < replyMs) return;
    const seconds = Math.round(replyMs / 1000);
    const remote = `@${this.spec.remote}`;
    const listing = this.spec.listing();
    for (const { from } of this.askers.values()) {
      this.notice?.(
        this.sentAt !== null
          ? t('automation.remotes.listingUnanswered', { from, remote, listing, seconds })
          : t('automation.remotes.listingNeverSent', { from, remote, seconds }),
        ANSWER
      );
    }
    this.reset();
  }

  reset(): void {
    this.generation += 1;
    this.askers.clear();
    this.askedAt = null;
    this.sentAt = null;
  }
}
