/**
 * Asking somebody this character invited to join, until they do (todo 01).
 * The party listing prints an invitation nobody has answered as `[Invited]`;
 * each such player is telepathed `@join`, as MegaMUD's leader does behind
 * `invite` (captures/112), and `par` is asked again
 * `tuning.remotes.inviteAgainMs` later; a repeat `@join` waits for that
 * listing's answer. It ends when the listing shows them joined or no longer
 * invited. The one sender of `@join` to an invitee, the regroup's included.
 * See `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import type { CharacterState, PartyMember } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { CommandQueue } from './CommandQueue';
import { partyListingIntent } from './PartyListing';

export interface InviteFollowUpEvents {
  notice?(message: string): void;
  /** `@join` to somebody whose invitation still stands. */
  askJoin(member: string, state: CharacterState): void;
}

export class InviteFollowUp {
  /** When each invitee, lower-cased, was last sent `@join`. */
  private readonly askedAt = new Map<string, number>();
  /** The next `par`, armed while an invitation stands. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The rows held when a listing's header arrived, before the tracker folds
   * it: a repeat `@join` waits until the rows are no longer these. Null when
   * no listing has begun since the last `@join`.
   */
  private before: readonly PartyMember[] | null = null;
  private listed = false;
  /** Whether this unit's own `par` went: its answer is the wait, so no clock is checked on it. */
  private owed = false;

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly events: InviteFollowUpEvents,
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
    if (!config.enabled) this.end();
  }

  onBlock(block: Block, state: CharacterState): void {
    if (block.type === 'party-roster' || block.type === 'party-alone') {
      this.before = state.party.members;
    }
  }

  onCharacter(state: CharacterState): void {
    const invited =
      this.config.enabled && state.party.following === null
        ? state.party.members.filter((member) => member.invited).map((member) => member.name)
        : [];
    if (invited.length === 0) {
      this.end();
      return;
    }
    if (this.before !== null && state.party.members !== this.before) {
      this.before = null;
      this.listed = true;
    }
    const again = tuning().remotes.inviteAgainMs;
    const now = this.now();
    const standing = new Set(invited.map((name) => name.toLowerCase()));
    for (const key of this.askedAt.keys()) if (!standing.has(key)) this.askedAt.delete(key);
    for (const member of invited) {
      const key = member.toLowerCase();
      const last = this.askedAt.get(key);
      if (last !== undefined && (!this.listed || (!this.owed && now - last < again))) continue;
      if (last === undefined) this.events.notice?.(t('automation.party.askingInvited', { member }));
      this.askedAt.set(key, now);
      this.events.askJoin(member, state);
    }
    if (this.listed) this.owed = false;
    this.listed = false;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.owed = true;
        this.queue.enqueue(partyListingIntent(this.config));
      }, again);
    }
  }

  reset(): void {
    this.end();
  }

  dispose(): void {
    this.end();
  }

  private end(): void {
    this.askedAt.clear();
    this.before = null;
    this.listed = false;
    this.owed = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
