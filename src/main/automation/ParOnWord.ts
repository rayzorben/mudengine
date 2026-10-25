/**
 * `par` sent when a member's own word says their bar is out of date (todo
 * 142): a `@wait` this leader walks on through under `party.manageParty`,
 * which it decides from the bar the party list showed, and a `@heal` from a
 * member whose figures show nothing missing. Without it a nine-minute walk
 * down the Silver River went by on one party list while Brackle said
 * `@wait (HP's too low)` at every step. Asked whatever `party.parSeconds` says,
 * under the same key as every other `par`, at most once per
 * `tuning.remotes.parOnWordMs`, and said. See `mudengine-automation` ›
 * parts/remotes.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { joinedMember, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import type { CommandQueue } from './CommandQueue';
import { partyListingIntent } from './PartyListing';

/** What the member said. */
export type MemberWord = 'wait' | 'heal';

const DECISION: Record<MemberWord, DecisionKind> = {
  wait: 'remote-wait',
  heal: 'heal-request'
};

export class ParOnWord {
  private askedAt: number | null = null;

  constructor(
    private config: AutomationConfig,
    private readonly queue: Pick<CommandQueue, 'offer'>,
    private readonly notice: NoticeSink,
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  /** `from` said `word`; `par` goes unless it went lately. */
  said(from: string, word: MemberWord, state: CharacterState): void {
    if (word === 'heal' && !showsNothingMissing(from, state)) return;
    const now = this.now();
    if (this.askedAt !== null && now - this.askedAt < tuning().remotes.parOnWordMs) return;
    const decision = DECISION[word];
    const words = { from, word: `@${word}` };
    // A refusal keeps the window too, so a @wait at every step says it once.
    this.askedAt = now;
    const offered = this.queue.offer(partyListingIntent(this.config, decision));
    const taken = offered === 'queued' || offered === 'joined';
    const said = taken
      ? t('automation.remotes.parOnWord', words)
      : t('automation.remotes.parOnWordNotSent', words);
    this.notice(said, decision);
  }

  reset(): void {
    this.askedAt = null;
  }
}

/** Whether `from`'s bar reads full or unstated, which their `@heal` says it is not. */
function showsNothingMissing(from: string, state: CharacterState): boolean {
  const member = joinedMember(state, from);
  return member !== undefined && (member.health === null || member.health >= 1);
}
