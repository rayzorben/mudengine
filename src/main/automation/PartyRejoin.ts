/**
 * The party a hangup or a quit took apart, kept so it is formed again. Either
 * is `<Name> is no longer following you.` (or `You are no longer following
 * <leader>.`) and then `<Name> just disconnected!!!` (2026-10-28, Brakkle) or
 * `<Name> just left the Realm.` (2026-11-02, Brakkle quit to train and came
 * back). Leading, a member lost that way is owed an invite (`AutoInvite` sends it
 * once they are in the room); one who hung up is also `away`, which the lap
 * waits on, until a party list prints them joined, and one who quit is not
 * (the user, 2026-11-02). A member left behind is owed as a hangup is
 * (`behind`); following, the leader is owed a `join` when
 * they invite (`AutoJoin`). Either is owed for `party.reinviteMinutes`. What
 * it keeps rides in the character's record (`CarriedParty`), so this
 * character's own hangup, or a relaunch, owes the whole party.
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { joinedMembers, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import type { CarriedMember, CarriedParty, PartyCarrier } from '../../shared/underway';

export const REJOIN: DecisionKind = 'party-rejoin';

/** How a member or the leader went: the line that followed their leave line. */
type Gone = 'hangup' | 'quit';

export interface PartyRejoinEvents {
  notice?: NoticeSink;
  /** Ask for the party list: a member a hangup or a quit took out has joined again, unconfirmed. */
  listParty?: () => void;
}

/** Somebody who stopped following, until their hangup or quit is read or `leaderDroppedMs` passes. */
interface Leaving {
  name: string;
  at: number;
  /** The leader this character followed, not a member of the party it leads. */
  leader: boolean;
}

export class PartyRejoin implements PartyCarrier {
  /** Leading: each member, by lower-cased name, in the order they joined. */
  private readonly members = new Map<string, CarriedMember>();
  /** Following: the leader. Never set while `members` holds anybody. */
  private leader: CarriedMember | null = null;
  /** Members, or the leader, just told to have stopped following, by lower-cased name. */
  private readonly leaving = new Map<string, Leaving>();
  /** A party list arrived: the next state's joined members are the whole party. */
  private listed = false;
  /** When the party list was last asked for a member back, until it comes. */
  private listAskedAt: number | null = null;
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
    this.leaving.clear();
    this.listAskedAt = null;
    const at = this.now();
    const lost = (member: CarriedMember): CarriedMember => ({
      name: member.name,
      droppedAt: member.droppedAt ?? at,
      quit: member.quit
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

  /** Whether `name` is a member a hangup or a quit took out of the party this character leads. */
  owesInvite(name: string): boolean {
    const member = this.members.get(key(name));
    return member !== undefined && this.owed(member);
  }

  /**
   * Leading, the members a hangup took out of the party and no party list has
   * printed back in it yet, while they are owed: the lap waits for them. One
   * who quit is invited on return and not waited for (the user, 2026-11-02).
   */
  get away(): string[] {
    return [...this.members.values()]
      .filter((member) => this.owed(member) && !member.quit)
      .map((member) => member.name);
  }

  /**
   * Leading, `who` was left behind: the realm dropped them held as this
   * character stepped off, or they asked to be walked back for. Owed and
   * waited for as a hangup is, so the lap waits past `waitMinutes` and they
   * are invited wherever this character meets them (Rayzor, 2026-11-04: the
   * wait for Brakkle's join gave up after 2 min, and the lap walked through
   * his room 24 times without inviting him).
   */
  behind(who: string): void {
    const minutes = this.config.party.reinviteMinutes;
    const known = this.members.get(key(who));
    if (this.leader !== null || minutes <= 0 || (known !== undefined && this.owed(known))) return;
    const name = known?.name ?? who;
    this.members.set(key(who), { name, droppedAt: this.now(), quit: false });
    this.events.notice?.(t('automation.party.memberBehind', { member: name, minutes }), REJOIN);
    this.write();
  }

  /** Whether `leader` is the leader a hangup or a quit took this character away from. */
  owesJoin(leader: string): boolean {
    return this.leader !== null && key(this.leader.name) === key(leader) && this.owed(this.leader);
  }

  onBlock(block: Block): void {
    if (block.type === 'party-left') this.partyLeft(block.groups);
    else if (block.type === 'party-joined') this.joined(block.groups['player']);
    else if (block.type === 'player-disconnects') this.lost(block.groups['player'], 'hangup');
    // A quit is owed as a hangup is: a player leaves the realm to train and comes back (the user, 2026-11-02).
    else if (block.type === 'player-exits') this.lost(block.groups['player'], 'quit');
    else if (block.type === 'party-roster' || block.type === 'party-alone') {
      this.listed = true;
      this.listAskedAt = null;
    }
  }

  onCharacter(state: CharacterState): void {
    let moved = this.expire();
    const following = state.party.following;
    if (following !== null) {
      moved ||= this.members.size > 0 || this.leader?.name !== following || !this.inIt(this.leader);
      this.members.clear();
      this.leader = { name: following, droppedAt: null, quit: false };
      this.leaving.clear();
    } else {
      const joined = joinedMembers(state);
      // The party list is the authority: somebody in the party it no longer
      // prints left by a line this client did not read. One the link dropped
      // is stamped by then (`lost`) and stays owed.
      if (this.listed) moved = this.prune(new Set(joined.map(({ name }) => key(name)))) || moved;
      for (const { name } of joined) {
        const known = this.members.get(key(name));
        if (known !== undefined && known.name === name && this.inIt(known)) continue;
        // One a hangup or a quit took out is back when a party list prints them, not on the join line alone.
        if (known !== undefined && !this.inIt(known) && !this.listed) {
          this.askList();
          continue;
        }
        this.members.set(key(name), { name, droppedAt: null, quit: false });
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
    // `<Name> is no longer following you.`: they left, or their hangup follows it.
    if (player !== undefined) this.memberLeft(player);
    if (leader === undefined || this.leader === null || key(this.leader.name) !== key(leader))
      return;
    this.leave(this.leader.name, true);
    this.leader = null;
    this.write();
  }

  private lost(who: string | undefined, how: Gone): void {
    if (who === undefined) return;
    const now = this.now();
    const minutes = this.config.party.reinviteMinutes;
    const left = this.justLeft(who, now);
    if (left?.leader === true) {
      this.leader = { name: left.name, droppedAt: now, quit: how === 'quit' };
      if (minutes > 0) this.events.notice?.(leaderGone(how, left.name, minutes), REJOIN);
      this.write();
      return;
    }
    const member =
      this.members.get(key(who)) ??
      (left === undefined ? undefined : { name: left.name, droppedAt: null, quit: false });
    // Owed for a hangup, back in the realm, then quit: still owed, and no longer waited for.
    if (member !== undefined && how === 'quit' && !this.inIt(member) && !member.quit) {
      this.members.set(key(who), { ...member, quit: true });
      if (minutes > 0) this.events.notice?.(memberGone(how, member.name, minutes), REJOIN);
      this.write();
      return;
    }
    if (member !== undefined && this.inIt(member)) {
      this.members.set(key(who), { name: member.name, droppedAt: now, quit: how === 'quit' });
      // The party list says who is left in it (the user, 2026-10-29).
      this.askList();
      if (minutes > 0) this.events.notice?.(memberGone(how, member.name, minutes), REJOIN);
      this.write();
    }
  }

  /** `<Name> started to follow you.` from a member a hangup or a quit took out: the party list says whether it took. */
  private joined(who: string | undefined): void {
    const member = who === undefined ? undefined : this.members.get(key(who));
    if (member !== undefined && this.owed(member)) this.askList();
  }

  /** A member stopped following: gone, unless their hangup or quit is read within `leaderDroppedMs`. */
  private memberLeft(who: string): void {
    const member = this.members.get(key(who));
    if (member === undefined) return;
    if (this.inIt(member)) this.leave(member.name, false);
    this.forget(who);
  }

  /** `name` stopped following, or this character stopped following them: a hangup may follow. */
  private leave(name: string, leader: boolean): void {
    const now = this.now();
    this.pruneLeaving(now);
    this.leaving.set(key(name), { name, at: now, leader });
  }

  /** Who stopped following just before this hangup or quit of `who`, taken. */
  private justLeft(who: string, now: number): Leaving | undefined {
    this.pruneLeaving(now);
    const left = this.leaving.get(key(who));
    this.leaving.delete(key(who));
    return left;
  }

  private pruneLeaving(now: number): void {
    const gap = tuning().remotes.leaderDroppedMs;
    for (const [name, left] of this.leaving) if (now - left.at > gap) this.leaving.delete(name);
  }

  /** Until the list comes, again each `inviteAgainMs` in case the queue dropped it; under the master switch. */
  private askList(): void {
    const now = this.now();
    const asked = this.listAskedAt;
    if (!this.config.enabled || (asked !== null && now - asked < tuning().remotes.inviteAgainMs))
      return;
    this.listAskedAt = now;
    this.events.listParty?.();
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

function memberGone(how: Gone, member: string, minutes: number): string {
  switch (how) {
    case 'hangup':
      return t('automation.party.memberDropped', { member, minutes });
    case 'quit':
      return t('automation.party.memberQuit', { member, minutes });
    default: {
      const never: never = how;
      return never;
    }
  }
}

function leaderGone(how: Gone, leader: string, minutes: number): string {
  switch (how) {
    case 'hangup':
      return t('automation.party.leaderDropped', { leader, minutes });
    case 'quit':
      return t('automation.party.leaderQuit', { leader, minutes });
    default: {
      const never: never = how;
      return never;
    }
  }
}

function key(name: string): string {
  return name.toLowerCase();
}
