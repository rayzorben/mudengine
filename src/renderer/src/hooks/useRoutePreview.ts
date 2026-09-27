/**
 * The Map card's route preview: a start, a destination, the route between
 * them cut into legs, and which leg is on screen.
 *
 * No start picked means the character's room, read when the plan is asked
 * for rather than followed, so the character walking on does not replan a
 * preview somebody is paging through. A late answer to an older pair is
 * dropped. See `mudengine-ui` › `parts/map.md` › *The route preview*.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { t } from '../lib/i18n';
import type { RoutePage, RoutePages } from '@shared/routeLegs';
import { errorMessage } from '@shared/values';
import type { RoomId } from '@shared/world';

/** A room the reader picked, with the name the field shows for it. */
export interface PickedRoom {
  id: RoomId;
  name: string;
}

export interface RoutePreview {
  from: PickedRoom | null;
  to: PickedRoom | null;
  pickFrom(room: PickedRoom | null): void;
  pickTo(room: PickedRoom | null): void;
  /** The legs of the planned route; empty while none is planned. */
  legs: RoutePage[];
  /** The leg on screen, an index into `legs`. */
  leg: number;
  page(index: number): void;
  /** Why no route is shown: the plan's refusal, a failure, or no start. */
  refused: string | null;
  planning: boolean;
  /** Drops the destination, the route and the start. */
  clear(): void;
}

export function useRoutePreview(
  routeBetween: (from: RoomId, to: RoomId) => Promise<RoutePages>,
  here: RoomId | null
): RoutePreview {
  const [from, setFrom] = useState<PickedRoom | null>(null);
  const [to, setTo] = useState<PickedRoom | null>(null);
  const [legs, setLegs] = useState<RoutePage[]>([]);
  const [leg, setLeg] = useState(0);
  const [refused, setRefused] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const hereRef = useRef(here);
  hereRef.current = here;
  /*
   * A plan refused for want of a start waits for the room to be known, then
   * asks again. Nothing else replans on the room: a hang-up keeps the preview.
   */
  const [retry, setRetry] = useState(0);
  const waiting = useRef(false);
  const placed = here !== null;
  useEffect(() => {
    if (!placed || !waiting.current) return;
    waiting.current = false;
    setRetry((count) => count + 1);
  }, [placed]);

  useEffect(() => {
    setLegs([]);
    setLeg(0);
    setRefused(null);
    if (to === null) return;
    const start = from?.id ?? hereRef.current;
    waiting.current = start === null;
    if (start === null) {
      setRefused(t('cards.map.preview.noStart'));
      return;
    }
    let live = true;
    setPlanning(true);
    void routeBetween(start, to.id)
      .then(({ route, legs: pages }) => {
        if (!live) return;
        setLegs(pages);
        setRefused(route.blocked ? (route.reason ?? t('cards.map.preview.noRoute')) : null);
      })
      .catch((error) => {
        if (live) setRefused(errorMessage(error));
      })
      .finally(() => {
        if (live) setPlanning(false);
      });
    return () => {
      live = false;
      setPlanning(false);
    };
  }, [from, to, routeBetween, retry]);

  const page = useCallback(
    (index: number) => setLeg(Math.max(0, Math.min(legs.length - 1, index))),
    [legs.length]
  );
  const clear = useCallback(() => {
    setFrom(null);
    setTo(null);
  }, []);

  const shown = Math.min(leg, Math.max(0, legs.length - 1));
  return useMemo(
    () => ({
      from,
      to,
      pickFrom: setFrom,
      pickTo: setTo,
      legs,
      leg: shown,
      page,
      refused,
      planning,
      clear
    }),
    [from, to, legs, shown, page, refused, planning, clear]
  );
}
