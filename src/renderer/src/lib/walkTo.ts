/**
 * A room walked to in one click, from a row that names it: the palette's
 * *Goto* and *Nearest* rows (todo 70). Planned and walked through `routeTo`
 * and `walkRoute`, the one navigation engine; what cannot be
 * walked unread opens the route panel on the room instead, so a click never
 * does nothing. See `mudengine-ui` › `parts/input.md`.
 */
import type { IpcApi, SessionId } from '@shared/ipc';
import type { WorldRoom } from '@shared/world';

export interface WalkToDeps {
  api: Pick<IpcApi, 'routeTo' | 'walkRoute'>;
  /** The character that walks. */
  session: SessionId;
  /** The route panel, on a room. */
  openRouteOn(room: WorldRoom, search: null): void;
}

export function walkTo(room: WorldRoom, { api, session, openRouteOn }: WalkToDeps): void {
  void api
    .routeTo(session, room.map, room.room)
    .then(async (route) => {
      // Nothing to walk, or nothing that *can* be walked: the panel is
      // where a blocked route states its conditions and where a room
      // already stood in says so, and it is the surface every other
      // room click reaches.
      if (route.blocked || route.steps.length === 0) return route;
      // And a way through what the player keeps out of: the panel is
      // where the way through and the way round are chosen between.
      if (route.keptOut !== undefined) return route;
      // The plan was drawn from here a moment ago. If the character moved
      // since, main answers with a new plan, and the route panel shows it.
      const answer = await api.walkRoute(session, route);
      return 'started' in answer ? null : route;
    })
    .then((unwalked) => {
      if (unwalked === null) return;
      openRouteOn(room, null);
    })
    .catch(() => {
      // A route that could not be planned at all: the panel says why,
      // rather than a click that does nothing.
      openRouteOn(room, null);
    });
}
