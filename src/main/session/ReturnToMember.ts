/**
 * Leading, a member the lap waits for (`PartyRejoin.away`: a hangup, or left
 * behind) is waited for in the room they were last seen in (the user,
 * 2026-11-04: Rayzor stepped out of Brakkle's room and waited next door, so
 * Brakkle could not be invited). While the party waits on nobody else and
 * nothing moves or fights, one walk there through `ComeBack.askedTo`, which
 * plans it within `party.comebackRooms` steps, invites them on arrival and
 * leaves the resume to the wait. Not into a room that hurts. Once a room per
 * member until this character has stood in it.
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { standingHere, type CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import { roomAddress, type RoomId } from '../../shared/world';
import { COMEBACK } from './ComeBack';

export interface ReturnToMemberPort {
  /** Where `who` was last seen in `Also here:` (`PlayerRecord.lastRoom`). */
  lastSeen(who: string): RoomId | null;
  /**
   * Whether the party's wait holds the lap or route for members away alone
   * (`PartyWait.holdingOnlyForAway`): a member held or resting here is dropped
   * by the realm when the leader steps off.
   */
  holding(): boolean;
  /** A fight here, the state's or one only its signs show (`fightHere`). */
  fighting(state: CharacterState): boolean;
  /**
   * Whether anything moves the character now: a walk, a walk back, a step out
   * of a room that hurts. A move still out is `ComeBack`'s to wait for.
   */
  moving(): boolean;
  /** `RoomHazards.roomHurts`, as a yes or no. */
  hurts(room: RoomId): boolean;
  /** `party.comebackRooms`: 0 never walks back. */
  rooms(): number;
  /** The one leg there within `limit` steps, invited on arrival, refusals said (`ComeBack.askedTo`). */
  walkTo(who: string, to: RoomId, limit: number): void;
  notice: NoticeSink;
}

export class ReturnToMember {
  /** The room each member, lower-cased, was walked back to or refused for, until this character stands in it. */
  private readonly done = new Map<string, RoomId>();

  constructor(private readonly port: ReturnToMemberPort) {}

  /** Every state, with the members the lap waits for. */
  onCharacter(state: CharacterState, away: readonly string[]): void {
    const here = roomAddress(state.room);
    const owed = new Set(away.map((who) => who.toLowerCase()));
    for (const [key, room] of [...this.done]) {
      if (!owed.has(key) || room === here) this.done.delete(key);
    }
    if (here === null || state.party.following !== null || this.port.fighting(state)) return;
    const rooms = this.port.rooms();
    if (rooms <= 0 || !this.port.holding() || this.port.moving()) return;
    const standing = standingHere(state);
    for (const who of away) {
      const key = who.toLowerCase();
      const to = this.port.lastSeen(who);
      if (to === null || to === here || standing.has(key) || this.done.get(key) === to) continue;
      this.done.set(key, to);
      if (this.port.hurts(to)) {
        this.port.notice(t('session.comeBack.returnHurts', { who, address: to }), COMEBACK);
        continue;
      }
      this.port.walkTo(who, to, rooms);
      // One walk at a time: the next member waits for this one to land.
      return;
    }
  }

  forget(): void {
    this.done.clear();
  }
}
