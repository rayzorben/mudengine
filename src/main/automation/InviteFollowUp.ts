/**
 * Asking somebody this character invited to join, until they do (todo 01).
 * The party listing prints an invitation nobody has answered as `[Invited]`;
 * each such player is telepathed `@join`, as MegaMUD's leader does behind
 * `invite` (captures/112), and `par` is asked again
 * `tuning.remotes.inviteAgainMs` later; a repeat `@join` waits for that
 * listing's answer. It ends when the listing shows them joined or no longer
 * invited. The one sender of `@join` to an invitee, the regroup's included.
 * Nothing is sent while another player's invitation to this character stands:
 * the listing reads the same, and that party's members refuse `@join`.
 * See `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { inAParty, type CharacterState, type PartyMember } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import type { CommandQueue } from './CommandQueue';
import { partyListingIntent } from './PartyListing';

export const FOLLOW_UP: DecisionKind = 'party-invite-followup';

export interface InviteFollowUpEvents {
  notice?: NoticeSink;
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
  /**
   * Who last invited this character, until it follows somebody or somebody
   * follows it; the hold on `@join` is said once per inviter and invitees.
   */
  private invitedBy: string | null = null;
  private heldFor: string | null = null;

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
    // `leader` is somebody inviting this character; `player` is this character inviting somebody.
    const leader = block.type === 'party-invited' ? block.groups['leader'] : undefined;
    if (leader !== undefined) this.invitedBy = leader;
  }

  onCharacter(state: CharacterState): void {
    const invited =
      this.config.enabled && state.party.following === null
        ? state.party.members.filter((member) => member.invited).map((member) => member.name)
        : [];
    if (state.party.following !== null || inAParty(state)) {
      this.invitedBy = null;
      this.heldFor = null;
    }
    if (invited.length === 0 || this.invitedBy !== null) {
      this.end();
      if (invited.length > 0) this.sayHeld(invited);
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
      if (last === undefined) {
        this.events.notice?.(t('automation.party.askingInvited', { member }), FOLLOW_UP);
      }
      this.askedAt.set(key, now);
      this.events.askJoin(member, state);
    }
    if (this.listed) this.owed = false;
    this.listed = false;
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.owed = true;
        this.queue.enqueue(partyListingIntent(this.config, FOLLOW_UP));
      }, again);
    }
  }

  reset(): void {
    this.end();
    this.invitedBy = null;
    this.heldFor = null;
  }

  dispose(): void {
    this.end();
  }

  private sayHeld(invited: readonly string[]): void {
    const leader = this.invitedBy;
    const members = invited.join(', ');
    const held = `${leader}:${members}`.toLowerCase();
    if (leader === null || this.heldFor === held) return;
    this.heldFor = held;
    this.events.notice?.(t('automation.party.invitedElsewhere', { leader, members }), FOLLOW_UP);
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
