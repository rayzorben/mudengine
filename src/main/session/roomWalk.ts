/**
 * A walk to a room a person named, as `@goto` (todo 17) and a macro's
 * `{goto}` line (todo 134) both read and walk it: a room name, `map/room`, or
 * both (`readStop`), matched against the realm, and the player's own route
 * there through the one navigation engine. One match or none; several are
 * said with their addresses, never picked between.
 */
import { readStop, type RoomMatch } from '../../shared/loops';
import { roomId, type RoomId, type RoomReference, type Route } from '../../shared/world';

/** Where a room is and the way there from here (`Errands`). */
export interface RoomFinder {
  matchStop(stop: { name: string; at: RoomReference | null }): RoomMatch;
  planFromHere(to: RoomId): Route | string;
}

/** The room a request names, as `@goto` reads it. */
export function roomNamed(request: string, rooms: Pick<RoomFinder, 'matchStop'>): RoomMatch {
  return rooms.matchStop(readStop(request));
}

/**
 * The player's own route to `at`, through `walkRoute` so a running lap is
 * stopped for it and the supply list gets its say. The refusal, or the walk.
 */
export function walkTo(
  at: RoomReference,
  rooms: Pick<RoomFinder, 'planFromHere'>,
  walkRoute: (route: Route) => string | null
): { stepCount: number; room: string } | string {
  const plan = rooms.planFromHere(roomId(at.map, at.room));
  if (typeof plan === 'string') return plan;
  const refused = walkRoute(plan);
  if (refused !== null) return refused;
  return {
    stepCount: plan.steps.length,
    room: plan.steps.at(-1)?.name ?? roomId(at.map, at.room)
  };
}
