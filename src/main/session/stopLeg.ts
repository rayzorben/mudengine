/**
 * A loop stop's leg from where the character stands, for `LoopRunner`'s
 * planner: unplaced is said, a stop the realm cannot settle is said, and the
 * leg carries the way off a stopper's rooms so a refused one can be traced
 * (todo 20261105-1440-01). `mudengine-automation` › `parts/loops.md`.
 */
import { t } from '../app/i18n';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WalkKind } from '../../shared/walk';
import { roomAddress, roomId, type Route } from '../../shared/world';
import type { Errands } from './Errands';

export interface StopLegParts {
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<Errands, 'findStop' | 'planFromHere'>;
}

export function stopLeg(
  parts: StopLegParts,
  stop: { name: string; at: { map: number; room: number } | null },
  kind: WalkKind
): Route | string {
  if (roomAddress(parts.tracker.current.room) === null) return t('session.loop.unknownRoom');
  const found = parts.errands.findStop(stop);
  if (typeof found === 'string') return found;
  return parts.errands.planFromHere(roomId(found.map, found.room), { withoutStopper: true }, kind);
}
