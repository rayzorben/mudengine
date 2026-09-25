/**
 * The route panel opened on a room the player pointed at: a room clicked on a
 * map, a room's name clicked in the console, a `map/room` string a quest step
 * names. Resolved against the shown character's realm first, and never
 * walked: the panel is where a plan is read.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › `parts/map.md`.
 */
import { useCallback } from 'react';

import type { IpcApi, SessionId } from '@shared/ipc';
import { asRoomReference, type WorldRoom } from '@shared/world';

export interface RouteOpenerInputs {
  api: Pick<IpcApi, 'searchRooms'>;
  /** The character on screen, whose realm the room is resolved in. */
  session: SessionId;
  /** The route panel, on a room or searching for a name. */
  openRouteOn(room: WorldRoom | null, search: string | null): void;
}

export function useRouteOpeners({ api, session, openRouteOn }: RouteOpenerInputs) {
  /**
   * A room clicked on the map opens the route panel with the plan already on
   * screen. It does not walk: a map click is the easiest possible way to send a
   * character somewhere by accident, so the steps still get read first.
   */
  const chooseOnMap = useCallback(
    (map: number, room: number) => {
      /*
       * Resolved before it opens. The panel's head states the realm's facts
       * about the destination -- its name, a shop, a lair, the exits -- and a
       * bare pair carries none, so the head used to open blank on this path.
       * A `map/room` query is answered by the index, exactly one room or
       * none; a room the realm does not have opens as the bare pair, which
       * the panel then reports rather than guessing at.
       */
      void api.searchRooms(session, `${map}/${room}`).then((rooms) => {
        const found = rooms.find((match) => match.map === map && match.room === room);
        // A pair names exactly one room, so nothing is left ambiguous here —
        // and a name left over from an earlier click would seed the field
        // against the room this one settled.
        openRouteOn(found ?? { map, room, name: '', exits: [] }, null);
      });
    },
    [api, session, openRouteOn]
  );

  /**
   * A room's name clicked in the console: the route panel, on that room.
   *
   * The question about a room you are not standing in is *how do I get there*,
   * which is the panel the map and the Route face already open — so a room is
   * the one recognised name that does not answer with a readout.
   *
   * **A name is not an address.** The realm has 3,779 distinct room names over
   * 55,806 rooms, so most name several places — thirteen Town Gates, two Mossy
   * Tunnels — and picking one of them would be the guess this project refuses,
   * with a walk at the end of it. So the *name* goes to the panel and the panel
   * lists what it matched; a name matching exactly one room opens on that room,
   * which is what the search field there already does with a typed name.
   */
  const chooseRoomNamed = useCallback(
    (name: string) => {
      void api.searchRooms(session, name).then((rooms) => {
        // Exactly one room, and it is the one meant. Anything else — several
        // rooms sharing the name, or none — is left to the panel's own list
        // rather than resolved here, where there is nothing to show the reader.
        const exact = rooms.filter((room) => room.name.toLowerCase() === name.toLowerCase());
        const one = exact.length === 1 ? exact[0]! : null;
        // Several rooms share the name, or the realm has none: the panel opens
        // searching for it rather than on a room nobody chose.
        openRouteOn(one, one === null ? name : null);
      });
    },
    [api, session, openRouteOn]
  );

  /**
   * The route panel, opened from a `map/room` string.
   *
   * The quest book states where a step's NPC stands as the realm writes it, so
   * it holds the pair as text rather than as two numbers. Parsed through
   * `asRoomReference`, which is the **one** parser a `map/room` string has —
   * a second spelling of it is what `WalkProgress` already refuses — and a
   * string that is not one opens nothing rather than guessing at a room.
   *
   * `useCallback` rather than an arrow at the call site: `QuestCard` is
   * memoised, and a prop built in a render is a memo defeated.
   */
  const goToRoom = useCallback(
    (room: string) => {
      const at = asRoomReference(room);
      if (at !== null) chooseOnMap(at.map, at.room);
    },
    [chooseOnMap]
  );

  return { chooseOnMap, chooseRoomNamed, goToRoom };
}
