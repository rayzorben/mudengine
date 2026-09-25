/**
 * What the shown character asks its realm, bound to it: a room search, a
 * plan, a walk, the local map, a room's brief, the pack's wearer, a name's
 * lookup, a probe through the arbiter, a found way struck out.
 *
 * Out of `App` (todo 733). Two characters may be on two realms, so nothing
 * here is asked of the client. See `mudengine-ui` › `parts/map.md`.
 */
import { useCallback } from 'react';

import type { IpcApi, SessionId } from '@shared/ipc';
import { asRoomReference, type RoomId, type Route } from '@shared/world';

export interface ShownRealmInputs {
  api: Pick<
    IpcApi,
    | 'searchRooms'
    | 'walkRoute'
    | 'collectThenWalk'
    | 'localMap'
    | 'roomBrief'
    | 'wearer'
    | 'lookup'
    | 'ask'
    | 'forget'
    | 'routeTo'
  >;
  /** The character on screen. */
  session: SessionId;
}

export function useShownRealm({ api, session }: ShownRealmInputs) {
  // Addressed: this character's realm, not the client's.
  const searchRooms = useCallback(
    (query: string) => api.searchRooms(session, query),
    [api, session]
  );
  const walkRoute = useCallback(
    (route: Route, run: boolean) => api.walkRoute(session, route, run),
    [api, session]
  );
  /** *Collect it first*, from the route panel, for every item the way names (todo 07). */
  const collectThenWalk = useCallback(
    (items: Array<{ id: number; name: string }>, route: Route, run: boolean) =>
      api.collectThenWalk(session, items, route, run),
    [api, session]
  );

  /*
   * `radius` is optional and passed straight through: the Map card measures
   * its own box and asks for what it can show, while the route panel — whose
   * map is a fixed strip in a fixed panel — takes main's default.
   */
  const loadMap = useCallback(
    (map: number, room: number, radius?: number) => api.localMap(session, map, room, radius),
    [api, session]
  );
  /**
   * The realm's whole answer about one room, for the quick view.
   *
   * Addressed like every other world query: two characters may be on two
   * realms, and a room id means different rooms on each.
   */
  const loadRoomBrief = useCallback(
    (room: RoomId) => {
      const at = asRoomReference(room);
      // A room id that is not a `map/room` pair names no room at all, which is
      // the same answer as a realm that does not hold it.
      return at === null ? Promise.resolve(null) : api.roomBrief(session, at.map, at.room);
    },
    [api, session]
  );
  /** Who this character is, for deciding what the pack may put on. */
  const loadWearer = useCallback(() => api.wearer(session), [api, session]);
  const lookupName = useCallback((query: string) => api.lookup(session, query), [api, session]);
  /** A probe asked for from a card, through the arbiter. */
  const ask = useCallback(
    (command: string) => {
      void api.ask(session, command);
    },
    [api, session]
  );

  /**
   * The player striking a found way out, because it was not one.
   *
   * Main answers with the whole record over the same push that learning
   * uses, so every window showing the card sees the row go.
   */
  const forget = useCallback(
    (discovery: { from: string; command: string }) => {
      void api.forget(session, discovery);
    },
    [api, session]
  );
  const routeTo = useCallback(
    (room: { map: number; room: number }) => api.routeTo(session, room.map, room.room),
    [api, session]
  );

  return {
    searchRooms,
    walkRoute,
    collectThenWalk,
    loadMap,
    loadRoomBrief,
    loadWearer,
    lookupName,
    ask,
    forget,
    routeTo
  };
}
