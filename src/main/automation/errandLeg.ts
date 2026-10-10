/**
 * One leg of a trip's walk to a room, planned from where the character
 * stands: refused while it is running, past the trip's leg budget (a fight
 * ends a leg, and each is planned again), where no route is found, or where
 * the walker will not take it. Shared by the gear trip and the cash run, so
 * how a trip walks a leg is said once.
 */
import { t } from '../app/i18n';
import type { RoomId, Route } from '../../shared/world';

export interface LegWalker {
  escaping(): boolean;
  routeTo(room: RoomId): Route | string;
  walk(route: Route): string | null;
}

/** Null where the leg is under way, else the trip's ending. */
export type LegRefusal = { ends: string } | { notReached: string } | null;

/** Walks leg number `legs` of at most `maxLegs` to `room`, called `place`. */
export function walkLeg(
  walker: LegWalker,
  room: RoomId,
  place: string,
  legs: number,
  maxLegs: number
): LegRefusal {
  if (walker.escaping()) return { ends: t('automation.hostTrip.endedEscaping') };
  if (legs > maxLegs) return { ends: t('automation.hostTrip.tooManyLegs', { place }) };
  const route = walker.routeTo(room);
  const refused =
    typeof route === 'string'
      ? route
      : route.blocked
        ? (route.reason ?? t('automation.walk.refusalNoRoute'))
        : walker.walk(route);
  return refused === null ? null : { notReached: refused };
}
