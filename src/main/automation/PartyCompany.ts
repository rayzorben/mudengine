/**
 * Which joined members have been seen standing with this character since
 * they joined. A follower moves with its leader on every step whatever room
 * it is in, and one that cannot is dropped from the party with `<Name> is no
 * longer following you.` (`Exits.cs`, `TryMoveThroughExit`), so a member
 * once seen here is with the leader until it leaves the party. The room
 * cannot say so: the follower's arrival prints after the leader's room and
 * prompt (Rayzor's `go hole`, 2026-10-31), and a sneaking follower's never
 * prints (Cretin behind Festus, 2026-11-27). A name the listing holds but no
 * room has ever shown is somewhere else. Read by `PartyRegroup`; see
 * `mudengine-automation` › parts/remotes.md.
 */
import { partyMembers, standingHere, type CharacterState } from '../../shared/character';

export class PartyCompany {
  /** Lower-cased names of joined members seen standing with this character since they joined. */
  private seen = new Set<string>();

  /** Every state: a member out of the party is forgotten, and a member standing here is kept. */
  note(state: CharacterState): void {
    const joined = partyMembers(state).map((member) => member.toLowerCase());
    const standing = standingHere(state);
    this.seen = new Set(joined.filter((key) => this.seen.has(key) || standing.has(key)));
  }

  /** Of `members`, those seen with this character since they joined, `state` noted first. */
  seenWith(members: readonly string[], state: CharacterState): string[] {
    this.note(state);
    return members.filter((member) => this.seen.has(member.toLowerCase()));
  }

  forget(): void {
    this.seen = new Set();
  }
}
