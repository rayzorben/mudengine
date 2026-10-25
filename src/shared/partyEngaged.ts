/**
 * Whether the party is fighting here, read off the members' volunteered blows
 * (`Party.engaged`, `Party.threatened`): the one reading the follower's assist
 * and defence and the leader's walk share (todo 20261023-1951-01). A sighting
 * counts while it is fresh and its monster is still listed.
 */
import {
  joinedMembers,
  monstersHere,
  type CharacterState,
  type PartyFight,
  type PartyThreat,
  type RoomOccupant
} from './character';
import { mobListed } from './mobRules';

/**
 * An area attack's target, `<Name> moves to attack everyone in the room.`
 * (`Player.cs:6169`, `Spell.cs:2131`; wire, Killa in
 * `logs/2026-09-13_22-38-55_festus`): every monster the room lists, never a
 * monster named for the phrase (todos 747, 756).
 */
export function isAreaTarget(target: string): boolean {
  return /^everyone in the room[.!]?$/i.test(target.trim());
}

/** What a member's swing at `target` files: the whole room, one monster, or nothing for a person. */
export function partyFight(
  s: Pick<CharacterState, 'room'>,
  target: string,
  at: number
): PartyFight | null {
  if (isAreaTarget(target)) return { kind: 'room', at };
  const mob = target.trim().replace(/[.!]+$/, '');
  const person = s.room.occupants.some(
    (there) => there.kind === 'player' && there.name.toLowerCase() === mob.toLowerCase()
  );
  return person ? null : { kind: 'mob', target: mob, at };
}

/**
 * What one sighting still points at: the monster as the room lists it, `room`
 * for a whole-room attack, or null once it is older than `freshMs` or its
 * monster left.
 */
export function freshSighting(
  state: Pick<CharacterState, 'room'>,
  seen: PartyFight | PartyThreat | undefined,
  now: number,
  freshMs: number
): RoomOccupant | 'room' | null {
  if (seen === undefined || now - seen.at > freshMs) return null;
  if ('kind' in seen && seen.kind === 'room') return 'room';
  return mobListed(state.room.occupants, seen.target) ?? null;
}

/**
 * Leading, whether a member here is still fighting a monster in this room:
 * swinging at it, or under `defending` (`party.defendParty`) being hit by it.
 * A whole-room attack counts while any monster is listed.
 */
export function partyFightHere(
  state: CharacterState,
  now: number,
  freshMs: number,
  defending: boolean
): boolean {
  if (state.party.following !== null || joinedMembers(state).length === 0) return false;
  const fighting = (seen: PartyFight | PartyThreat): boolean => {
    const at = freshSighting(state, seen, now, freshMs);
    return at === 'room' ? monstersHere(state) : at !== null;
  };
  return (
    Object.values(state.party.engaged).some(fighting) ||
    (defending && Object.values(state.party.threatened).some(fighting))
  );
}
