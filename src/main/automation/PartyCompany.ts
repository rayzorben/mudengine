/**
 * Which joined members have been seen standing with this character, in its
 * room or the one before it. The server moves a follower with its leader but
 * prints `<Name> walks into the room` after the leader's room and prompt, so a
 * step decided on arrival sees the follower only in the room behind (Rayzor's
 * `go hole`, 2026-10-31). A name the party listing holds but no room has
 * shown lately is somewhere else. Read by `PartyRegroup`; see
 * `mudengine-automation` › parts/remotes.md.
 */
import { partyMembers, standingHere, type CharacterState } from '../../shared/character';
import { roomAddress, type RoomId } from '../../shared/world';

export class PartyCompany {
  private room: RoomId | null = null;
  /** Lower-cased names seen in `room`, and in the room before it. */
  private here = new Set<string>();
  private before = new Set<string>();

  /** Every state: a new room moves what was seen here to `before`. */
  note(state: CharacterState): void {
    const room = roomAddress(state.room);
    if (room === null) return;
    if (room !== this.room) {
      this.before = this.here;
      this.here = new Set();
      this.room = room;
    }
    const standing = standingHere(state);
    for (const member of partyMembers(state)) {
      const key = member.toLowerCase();
      if (standing.has(key)) this.here.add(key);
    }
  }

  /** Of `members`, those seen with this character here or in the room before, `state` noted first. */
  seenWith(members: readonly string[], state: CharacterState): string[] {
    this.note(state);
    return members.filter((member) => {
      const key = member.toLowerCase();
      return this.here.has(key) || this.before.has(key);
    });
  }

  forget(): void {
    this.room = null;
    this.here = new Set();
    this.before = new Set();
  }
}
