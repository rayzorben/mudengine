/**
 * A direction the **player** typed, waiting for the room that answers it, so
 * a walk or a loop stands down when the player takes the wheel. Out of
 * `SessionManager` (2026-11-08). See `mudengine-session` › `parts/composition.md`.
 *
 * Taking the wheel is *moving the character*, not typing. It used to be any
 * command at all: `st` mid-lap ended the loop with `Manually stopped`. And a
 * direction into a wall is not taking the wheel either, so the typed move is
 * held here until a room says it landed.
 */
import { tuning } from '../app/tuning';
import type { CharacterState, Room } from '../../shared/character';
import { roomAddress } from '../../shared/world';

/**
 * Where the character is standing, in whatever terms are available: the
 * resolved room, else the room's own name. Only ever compared against itself;
 * null in a room nothing has described, which says nothing.
 */
function whereWeStand(room: Room): string | null {
  return roomAddress(room) ?? room.name;
}

export class PlayerSteering {
  /**
   * `where` is the room the move was typed in, so the arrival is recognised by
   * the room *changing*; `at` is what `tuning.session.playerMoveWindowMs`
   * writes it off against, so a refusal nothing classified cannot leave this
   * armed against a walk step three rooms later.
   */
  private armed: { where: string | null; at: number } | null = null;

  /** `steered` stands the walk, the loop and the errands down. */
  constructor(private readonly steered: () => void) {}

  /** The player typed a step in `room`. */
  arm(room: Room): void {
    this.armed = { where: whereWeStand(room), at: Date.now() };
  }

  /** A wall, the menu, a new connection: nothing landed. */
  cancel(): void {
    this.armed = null;
  }

  /**
   * The stop belongs to the *arrival* rather than to the keystroke: a typed
   * `n` that the server refuses moves nobody. Written off after the window,
   * since not every failure is a `direction-failed` this can hear, and an arm
   * left standing would be answered by a walk step's own arrival.
   */
  note(state: CharacterState): void {
    const armed = this.armed;
    if (armed === null) return;
    if (Date.now() - armed.at > tuning().session.playerMoveWindowMs) {
      this.armed = null;
      return;
    }
    const here = whereWeStand(state.room);
    if (here === null || here === armed.where) return;
    this.armed = null;
    this.steered();
  }
}
