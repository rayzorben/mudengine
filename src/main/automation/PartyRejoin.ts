/**
 * The party a hangup took apart, kept so it is formed again. GreaterMUD
 * drops a member who hangs up without a word to the leader, who sees only
 * `<Name> just disconnected!!!`, and when the leader hangs up each member is
 * told `You are no longer following <leader>.` and the party is gone
 * (`Player.PlayerLeavingPartyCheck`). Leading, a member lost that way is owed
 * an invite (`AutoInvite` sends it once they are in the room); following, the
 * leader is owed a `join` when they invite (`AutoJoin`). Either is owed for
 * `party.reinviteMinutes`. What it keeps rides in the character's record
 * (`CarriedParty`), so this character's own hangup, or a relaunch, owes the
 * whole party. `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { joinedMembers, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import type { CarriedMember, CarriedParty, PartyCarrier } from '../../shared/underway';

export const REJOIN: DecisionKind = 'party-rejoin';

export interface PartyRejoinEvents {
  notice?: NoticeSink;
}

export class PartyRejoin implements PartyCarrier {
  /** Leading: each member, by lower-cased name, in the order they joined. */
  private readonly members = new Map<string, CarriedMember>();
  /** Following: the leader. Never set while `members` holds anybody. */
  private leader: CarriedMember | null = null;
  /** The leader this character was just told it no longer follows, until their hangup is read. */
  private left: { key: string; at: number } | null = null;
  /** A party list arrived: the next state's joined members are the whole party. */
  private listed = false;
  private write: () => void = () => {};

  constructor(
    private config: AutomationConfig,
    private readonly events: PartyRejoinEvents = {},
    private readonly now: () => number = Date.now
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  writeWith(write: () => void): void {
    this.write = write;
  }

  get carried(): CarriedParty | null {
    if (this.members.size > 0) return { kind: 'leading', members: [...this.members.values()] };
    return this.leader === null ? null : { kind: 'following', leader: this.leader };
  }

  /**
   * At a dial, what the record carried: everyone in it was lost with the link,
   * from now unless the party had already lost them earlier.
   */
  carry(party: CarriedParty | null): void {
    this.members.clear();
    this.leader = null;
    this.left = null;
    const at = this.now();
    const lost = (member: CarriedMember): CarriedMember => ({
      name: member.name,
      droppedAt: member.droppedAt ?? at
    });
    if (party?.kind === 'leading')
      for (const member of party.members) this.members.set(key(member.name), lost(member));
    else if (party?.kind === 'following') this.leader = lost(party.leader);
    this.expire();
    const minutes = this.config.party.reinviteMinutes;
    if (minutes > 0 && this.members.size > 0) {
      const members = [...this.members.values()].map((member) => member.name).join(', ');
      this.events.notice?.(t('automation.party.reformLeading', { members, minutes }), REJOIN);
    } else if (minutes > 0 && this.leader !== null) {
      const leader = this.leader.name;
      this.events.notice?.(t('automation.party.reformFollowing', { leader, minutes }), REJOIN);
    }
  }

  /** Whether `name` is a member a hangup took out of the party this character leads. */
  owesInvite(name: string): boolean {
    const member = this.members.get(key(name));
    return member !== undefined && this.owed(member);
  }

  /** Whether `leader` is the leader a hangup took this character away from. */
  owesJoin(leader: string): boolean {
    return this.leader !== null && key(this.leader.name) === key(leader) && this.owed(this.leader);
  }

  onBlock(block: Block): void {
    if (block.type === 'party-left') this.partyLeft(block.groups);
    else if (block.type === 'player-disconnects') this.hungUp(block.groups['player']);
    // A clean quit takes the member out of the party too, and they chose it.
    else if (block.type === 'player-exits') this.forget(block.groups['player']);
    else if (block.type === 'party-roster' || block.type === 'party-alone') this.listed = true;
  }

  onCharacter(state: CharacterState): void {
    let moved = this.expire();
    const following = state.party.following;
    if (following !== null) {
      moved ||= this.members.size > 0 || this.leader?.name !== following || !this.inIt(this.leader);
      this.members.clear();
      this.leader = { name: following, droppedAt: null };
      this.left = null;
    } else {
      const joined = joinedMembers(state);
      // The party list is the authority: somebody in the party it no longer
      // prints left by a line this client did not read. One the link dropped
      // is stamped by then (`hungUp`) and stays owed.
      if (this.listed) moved = this.prune(new Set(joined.map(({ name }) => key(name)))) || moved;
      for (const { name } of joined) {
        const known = this.members.get(key(name));
        if (known !== undefined && known.name === name && this.inIt(known)) continue;
        this.members.set(key(name), { name, droppedAt: null });
        moved = true;
      }
      if (this.members.size > 0 && this.leader !== null) {
        this.leader = null;
        moved = true;
      }
    }
    this.listed = false;
    if (moved) this.write();
  }

  private prune(joined: ReadonlySet<string>): boolean {
    let moved = false;
    for (const [name, member] of this.members) {
      if (!this.inIt(member) || joined.has(name)) continue;
      this.members.delete(name);
      moved = true;
    }
    return moved;
  }

  private partyLeft(groups: Readonly<Record<string, string | undefined>>): void {
    const { player, leader } = groups;
    // `<Name> is no longer following you.`: they left, or were taken out, while connected.
    if (player !== undefined) this.forget(player);
    if (leader === undefined || this.leader === null || key(this.leader.name) !== key(leader))
      return;
    this.left = { key: key(leader), at: this.now() };
    this.leader = null;
    this.write();
  }

  private hungUp(who: string | undefined): void {
    if (who === undefined) return;
    const now = this.now();
    const minutes = this.config.party.reinviteMinutes;
    const member = this.members.get(key(who));
    if (member !== undefined && this.inIt(member)) {
      this.members.set(key(who), { name: member.name, droppedAt: now });
      if (minutes > 0)
        this.events.notice?.(
          t('automation.party.memberDropped', { member: member.name, minutes }),
          REJOIN
        );
      this.write();
      return;
    }
    const left = this.left;
    if (left === null || left.key !== key(who)) return;
    this.left = null;
    if (now - left.at > tuning().remotes.leaderDroppedMs) return;
    this.leader = { name: who, droppedAt: now };
    if (minutes > 0)
      this.events.notice?.(t('automation.party.leaderDropped', { leader: who, minutes }), REJOIN);
    this.write();
  }

  private forget(who: string | undefined): void {
    if (who !== undefined && this.members.delete(key(who))) this.write();
  }

  /** Drops whoever has been owed longer than `reinviteMinutes`, said; whether anything went. */
  private expire(): boolean {
    let moved = false;
    const minutes = this.config.party.reinviteMinutes;
    for (const [name, member] of this.members) {
      if (this.inIt(member) || this.owed(member)) continue;
      this.members.delete(name);
      moved = true;
      if (minutes > 0)
        this.events.notice?.(
          t('automation.party.memberGaveUp', { member: member.name, minutes }),
          REJOIN
        );
    }
    if (this.leader !== null && !this.inIt(this.leader) && !this.owed(this.leader)) {
      if (minutes > 0)
        this.events.notice?.(
          t('automation.party.leaderGaveUp', { leader: this.leader.name, minutes }),
          REJOIN
        );
      this.leader = null;
      moved = true;
    }
    return moved;
  }

  private inIt(member: CarriedMember | null): boolean {
    return member !== null && member.droppedAt === null;
  }

  private owed(member: CarriedMember): boolean {
    const minutes = this.config.party.reinviteMinutes;
    return (
      member.droppedAt !== null && minutes > 0 && this.now() - member.droppedAt <= minutes * 60_000
    );
  }
}

function key(name: string): string {
  return name.toLowerCase();
}
