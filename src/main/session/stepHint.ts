/**
 * What the walker's step tells the tracker about the room block coming back:
 * an exit whose cast moves the character (two blocks), a room command that
 * draws (one block, somewhere in the draw), a portal to stated coordinates,
 * or a plain step. `mudengine-wire` › `parts/room.md` › *An exit whose cast
 * moves you answers with two room blocks*.
 */
import type { Direction, Landing, RoomId } from '../../shared/world';
import { landingRooms } from '../../shared/world';
import type { CharacterTracker } from '../parse/CharacterTracker';

export type StepHints = Pick<CharacterTracker, 'hintCast' | 'hintTeleport' | 'hintMove'>;

export function hintStep(
  tracker: StepHints,
  command: string,
  direction: Direction | 'portal',
  to: RoomId,
  landing?: Landing
): void {
  const drawn = landing === undefined ? [] : landingRooms(landing);
  if (direction !== 'portal' && landing !== undefined) {
    tracker.hintCast(command, direction, drawn);
    return;
  }
  if (direction === 'portal' && drawn.length > 1) {
    // A room command whose run draws: `to` is only the draw's first room
    // (`commandWays`), so the landing is looked for among all of them.
    tracker.hintCast(command, null, drawn);
    return;
  }
  if (direction === 'portal') {
    // A scripted teleport lands by the script's coordinates, never by an exit;
    // `to` is `map/room` by construction, parsed rather than trusted.
    const target = /^(\d{1,3})\/(\d{1,6})$/.exec(to);
    if (target) tracker.hintTeleport(command, Number(target[1]), Number(target[2]));
    return;
  }
  tracker.hintMove(command, direction);
}
