/**
 * A landed step, told to everything that keeps something per room: the trail
 * back (`Trail`) and the fight, which lets go of what did not follow (todo
 * 20261018-1314-02). One port for `RoomTracker`, wired once by the tracker.
 */
import type { CharacterState, Room } from '../../shared/character';
import type { Direction } from '../../shared/world';
import type { FightTracker } from './combat';
import type { Trail } from './trail';

/** Whether the character stands somewhere else than it did. See `CharacterTracker.apply`. */
export function leftRoom(before: Room, after: Room): boolean {
  if (before === after) return false;
  if (before.name !== after.name) return true;
  return (
    before.map !== null &&
    before.number !== null &&
    (before.map !== after.map || before.number !== after.number)
  );
}

export const toldOfSteps =
  (trail: Pick<Trail, 'rememberTheWayBack'>, fight: () => Pick<FightTracker, 'walked'>) =>
  (s: CharacterState, room: Room, moved: Direction | null): void => {
    // A look, a redisplay or a refused step lands in the same room: the fight goes on.
    if (leftRoom(s.room, room)) fight().walked(s, moved);
    trail.rememberTheWayBack(s, room, moved);
  };
