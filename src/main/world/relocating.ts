/**
 * A room that moves the character is a wall, exactly as an exit that casts
 * one is (`edgePenalty`'s `spellEffect === 'relocates'`): the walker's next
 * command goes out from wherever the plan says it is standing, and a room
 * that puts it somewhere the exit table does not name breaks every step
 * after it. 1,557 rooms of the shipped realm cast one. Priced at
 * `deadlyShare`, not `wallCost`, because a room's hazard is a share and
 * `dangerPenalty` turns a share at the wall into the wall. One reading for
 * every walk (`Errands.roomHazard`) and the lap (`relocatingHazard`).
 */
import { tuning } from '../app/tuning';
import { hazardAvoided, hazardCarried } from '../../shared/world';
import type { WorldGraph } from './WorldGraph';

type StatedHazard = NonNullable<ReturnType<WorldGraph['hazardOf']>>;

/** The share a room's stated spell costs because it moves the character; null where it does not, or what is carried or up stops it. */
export function relocatingShare(
  stated: StatedHazard,
  carrying: readonly number[] | undefined,
  up: readonly number[] | undefined
): number | null {
  if (hazardAvoided(stated, carrying, up)) return null;
  return hazardCarried(stated, carrying, up).relocates === true ? tuning().world.deadlyShare : null;
}
