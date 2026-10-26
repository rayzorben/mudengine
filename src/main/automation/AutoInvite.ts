/**
 * Inviting a named player when they are in the room with this character: they
 * walked in, or this character walked in on them (todo 851, fatavatar
 * `7896db7`). The per-player `autoInvite` in `automation.remotes.players`,
 * and a member a hangup took out of the party (`PartyRejoin.owesInvite`).
 * Never somebody already in the party or invited, never while this character
 * is following, and the same name not again within
 * `tuning.remotes.inviteSeenAgainMs`, so a player stepping in and out is not
 * invited each time. The `@join` behind the invite is `InviteFollowUp`'s.
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import { grantFor } from '../../shared/remotes';
import type { CommandQueue } from './CommandQueue';
import { inviteIntent } from './PartyRegroup';
import { REJOIN, type PartyRejoin } from './PartyRejoin';

const INVITE: DecisionKind = 'party-autoinvite';

export interface AutoInviteEvents {
  notice?: NoticeSink;
}

export class AutoInvite {
  /** The players in the room at the last state, lower-cased: a name not in it is an arrival. */
  private here = new Set<string>();
  /** When each name, lower-cased, was last sent `invite`. */
  private readonly invitedAt = new Map<string, number>();

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly rejoin: Pick<PartyRejoin, 'owesInvite'>,
    private readonly events: AutoInviteEvents = {}
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  reset(): void {
    this.here = new Set();
    this.invitedAt.clear();
  }

  onCharacter(state: CharacterState): void {
    const players = state.room.occupants.filter((who) => who.kind === 'player');
    const before = this.here;
    this.here = new Set(players.map((who) => who.name.toLowerCase()));
    if (!this.config.enabled) return;
    for (const { name } of players) {
      const key = name.toLowerCase();
      if (before.has(key)) continue;
      const owed = this.rejoin.owesInvite(name);
      if (!owed && !grantFor(this.config.remotes, key).autoInvite) continue;
      // Joined, or the listing already prints them `[Invited]`.
      if (state.party.members.some((member) => member.name.toLowerCase() === key)) continue;
      this.invite(name, key, state, owed ? REJOIN : INVITE);
    }
  }

  private invite(name: string, key: string, state: CharacterState, decision: DecisionKind): void {
    const leader = state.party.following;
    if (leader !== null) {
      this.events.notice?.(
        t('automation.remotes.autoInviteFollowing', { who: name, leader }),
        decision
      );
      return;
    }
    const now = Date.now();
    const last = this.invitedAt.get(key);
    const again = tuning().remotes.inviteSeenAgainMs;
    if (last !== undefined && now - last < again) {
      this.events.notice?.(
        t('automation.remotes.autoInviteWaiting', {
          who: name,
          seconds: Math.ceil((again - (now - last)) / 1000)
        }),
        decision
      );
      return;
    }
    const reason =
      decision === REJOIN
        ? t('automation.party.reasonReinvite', { member: name })
        : t('automation.remotes.reasonAutoInvite', { who: name });
    this.queue.enqueue({
      ...inviteIntent(name, reason, decision),
      // Counted when it goes: one the queue dropped spends no wait.
      onSent: () => {
        this.invitedAt.set(key, now);
      }
    });
  }
}
