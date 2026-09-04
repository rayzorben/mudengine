/**
 * What the Room card says about a room the character cannot see.
 *
 * The server prints one of four light phrases and, for the two darkest,
 * prints *nothing else*: no name, no description, no exits. The engine then
 * places the character by dead reckoning from the last known room and the
 * direction walked, at a lower confidence than a room it has read — or, when
 * the realm data does not agree the destination is dark, refuses to place it
 * at all. Until 2026-08-28 the card drew both cases as though the room had
 * been read normally: the dead-reckoned room with a name and `no exits`, the
 * unplaced one as `No room yet.` while the character stood in it.
 *
 * Two facts, kept apart the way `Room` keeps them: the phrase is what the
 * server said and is always shown; the placement is what the client did about
 * it and is said only when there is something to say.
 */
import { isBlinding, type Room, type RoomLight } from '@shared/character';

export interface LightNote {
  /** The server's own words, shown as themselves. */
  phrase: RoomLight;
  /**
   * Whether the phrase is one of the two the server prints *instead of* a
   * room block — the darkest pair, drawn louder. At the card this is about the
   * phrase, not about whether a block is on the books: a room read under light
   * that then goes dark keeps its block and still gets a blinding phrase.
   */
  blinding: boolean;
  /**
   * Where the name on the card came from, for a room the character cannot
   * see. `dead-reckoning` is a position inferred from the last room and the
   * step taken; `remembered` is a room read under light before the phrase
   * arrived with no move pending — the light ran out, or `look` was typed —
   * so the name is the last one read rather than one read now; `unplaced` is
   * a refusal — the realm data called the destination lit, so the character
   * is somewhere it did not expect and the card must not name a room. Null for
   * a room the client read.
   */
  placement: 'dead-reckoning' | 'remembered' | 'unplaced' | null;
}

export function lightNote(room: Pick<Room, 'light' | 'resolvedBy' | 'name'>): LightNote | null {
  if (room.light === null) return null;
  const blinding = isBlinding(room.light);
  const placement = !blinding
    ? null
    : room.resolvedBy === 'dead-reckoning'
      ? 'dead-reckoning'
      : room.name === null
        ? 'unplaced'
        : 'remembered';
  return { phrase: room.light, blinding, placement };
}

/**
 * Whether an empty exit list means the exits were never read.
 *
 * Null is not zero: a room the server would not describe has exits the client
 * did not see, and `no exits` is a claim about the room that nothing on the
 * wire supports. A lit room with an empty list genuinely has none.
 */
export function exitsUnseen(room: Pick<Room, 'exits' | 'light'>): boolean {
  return room.exits.length === 0 && isBlinding(room.light);
}
