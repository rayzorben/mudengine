/**
 * Where this character came from: the confirmed moves behind it, oldest
 * first, and the way back out of the room the newest one landed in.
 *
 * Out of `CharacterTracker` (todo 724; `mudengine-wire` › `parts/tracker.md`).
 * Written where a room block commits (`RoomSources.rememberTheWayBack`), so
 * every move reaches it whoever sent it; read only by the escape and the back
 * button (`Travel`), through the tracker's `trail`, `wayBackFrom` and
 * `retraced` — `mudengine-automation` › `parts/safety.md` › *The way back is
 * the tracker's*. Whether the menu should let go of it: todo 752.
 */
import type { CharacterState, Room } from '../../shared/character';
import { roomId, type Direction, type RoomId, type TrailStep } from '../../shared/world';
import { tuning } from '../app/tuning';

export class Trail {
  private backtrail: TrailStep[] = [];

  /**
   * The last few moves the character is known to have made, oldest first.
   *
   * See `TrailStep`. This is *where we came from*, and it is here rather than
   * in `Walker` because the tracker is the only thing that knows: it holds the
   * expectation queue that says a move was asked for, and it does the room
   * resolution that says where the move landed. Every move goes through this
   * one place — a walker step, a typed direction, a party follow — so the trail
   * does not care who was driving, which is the whole of the difference from
   * the walker's own history.
   *
   * Bounded by `tuning.walk.trailSteps` — the back button walks it, so it is
   * a session's history rather than the few steps a retreat looks over, and
   * the escape reads its tail (`tuning.walk.recentSteps`) for that reason.
   * A back step gives its entry up again (`retraced`). Cleared by a reset — a
   * new connection — and by a death, because the realm moves a dead character
   * to its area's temple along no edge and the trail out of the room it died
   * in leads back to whatever killed it.
   */
  get steps(): readonly TrailStep[] {
    return this.backtrail;
  }

  /**
   * The way back out of `here`, when the last confirmed move landed here.
   *
   * The strongest answer an escape can have: an exit *known* to lead somewhere
   * this character was standing, alive, moments ago — as against an exit the
   * realm data says exists, which is only known to lead somewhere.
   *
   * Null when the character is not standing where the newest move left it: the
   * opposite of a step taken from somewhere else leads somewhere else. That is
   * a real refusal rather than a formality, because a retreat that has already
   * run once is exactly the case — see `Travel.escape`, which walks
   * further down the trail before it gives up on retracing.
   */
  wayBackFrom(here: RoomId): TrailStep | null {
    const last = this.backtrail.at(-1);
    return last !== undefined && last.to === here ? last : null;
  }

  /**
   * A move landed, and both ends of it are known. Write it down.
   *
   * The one place *where we came from* is recorded, called from where a room
   * block is committed (`room.ts`) — so a step the walker sent, a direction the
   * player typed and a party follow all reach it the same way, which is the
   * whole point of it living there (see `TrailStep`).
   *
   * Four things must hold, and each is a refusal rather than a default:
   *
   * - **A move was expected.** `moved` is the direction off the expectation the
   *   arriving room consumed. A room block nobody asked for — the server's own
   *   courtesy reprint, a look — moved nothing.
   * - **It was a compass move.** A teleport is queued as a move with no
   *   direction, and it arrives along no edge: there is no opposite to state.
   * - **Both ends are placed.** An unresolved or ambiguous room is not a room
   *   to claim a way back to. Refuse rather than guess.
   * - **The ends differ.** A move the server refused can still be answered with
   *   a room block for where the character already stands, and `n` recorded as
   *   leading from a room to itself would make `s` the way out of it.
   */
  rememberTheWayBack(s: CharacterState, room: Room, moved: Direction | null): void {
    if (moved === null) return;
    if (room.map === null || room.number === null) return;
    if (s.room.map === null || s.room.number === null) return;
    const from = roomId(s.room.map, s.room.number);
    const to = roomId(room.map, room.number);
    if (from === to) return;
    this.backtrail.push({ from, direction: moved, to });
    if (this.backtrail.length > tuning().walk.trailSteps) this.backtrail.shift();
  }

  /**
   * The character has walked back over `step`: give it up, and everything the
   * way back recorded after it.
   *
   * The trail is a navigation history, so **going back pops it**. Without
   * that, one press of back records the move it made and the next press walks
   * back over *that* — two rooms oscillating for ever, which is the naive
   * reverse under another name.
   *
   * The **step**, not a length, because the way back is not always one step
   * and the trail is bounded: at `trailSteps` every push shifts the oldest
   * entry off, so an index taken before the walk names a different move by the
   * time it lands. `SessionManager` marks the entry the press was made about
   * and everything from it is given up together. Nothing is given up until the
   * character is actually standing in the room it went back to, so a walk that
   * stopped half way leaves the history true.
   */
  retraced(step: TrailStep): void {
    for (let at = this.backtrail.length - 1; at >= 0; at -= 1) {
      const held = this.backtrail[at];
      if (held === undefined) continue;
      if (held.from === step.from && held.direction === step.direction && held.to === step.to) {
        this.backtrail.length = at;
        return;
      }
    }
  }

  /** Nothing on the trail is one room from where the character stands any more. */
  forget(): void {
    this.backtrail = [];
  }
}
