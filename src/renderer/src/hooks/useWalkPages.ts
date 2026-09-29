/**
 * The route being walked, in the pages the Map card's preview uses, and which
 * of them is on screen.
 *
 * Paged once per route in main (`Invoke.walkPages`) and followed here by the
 * steps walked since, so a step costs no paging. A route redrawn under the
 * walk (a replan, a detour) no longer matches the page the steps land on, and
 * is paged again from where the character stands, once until the pages match
 * again, since each paging is a pass on main's thread. The pager starts at the
 * page being walked and goes on to the destination; the page behind is
 * walked. See `mudengine-ui` › `parts/map.md` › *The route preview*.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { NO_WALK_PAGES, pageWalking, type RoutePage, type WalkPages } from '@shared/routeLegs';
import { errorMessage } from '@shared/values';
import type { WalkProgress } from '@shared/walk';
import { roomId } from '@shared/world';

export interface WalkPager {
  legs: readonly RoutePage[];
  /** The page the character is on; null while nothing is walked. */
  walking: number | null;
  /** A page ahead the reader turned to; null while the pager follows the walk. */
  shown: number | null;
  page(index: number): void;
  /** Back to the page being walked. */
  follow(): void;
}

export function useWalkPages(load: () => Promise<WalkPages>, walk: WalkProgress): WalkPager {
  /* The pages, with the route they were asked for, so a new route never reads the last one's. */
  const [held, setHeld] = useState<{ route: string; pages: WalkPages } | null>(null);
  const [look, setLook] = useState<number | null>(null);
  const [asks, setAsks] = useState(0);
  /* Set by a stale re-ask, cleared once the pages match the walk again. */
  const [asked, setAsked] = useState(false);
  const here = walk.path[0] ?? null;
  const on = walk.status === 'walking' && here !== null;
  const where = walk.destinationRoom;
  // A new route, or the same one ended: a replan inside one route is found by
  // its pages going stale below.
  const route = on && where !== null ? `${roomId(where.map, where.room)}/${walk.total}` : null;

  const paged = held !== null && held.route === route ? held.pages : NO_WALK_PAGES;

  useEffect(() => {
    setLook(null);
    setAsked(false);
  }, [route]);

  // A re-ask keeps the pages on screen until the new ones land.
  useEffect(() => {
    if (route === null) return;
    let live = true;
    void load()
      .then((pages) => {
        if (live) setHeld({ route, pages });
      })
      .catch((error) => {
        // The live map still draws the walk; the pager is what goes missing.
        console.error(`[map] the walk's pages: ${errorMessage(error)}`);
      });
    return () => {
      live = false;
    };
  }, [load, route, asks]);

  const index = pageWalking(paged.legs, walk.done - paged.done);
  const current = index === null ? undefined : paged.legs[index];
  const matches = current !== undefined && here !== null && current.rooms.includes(here);
  const walking = on && matches ? index : null;

  /*
   * Stale pages are asked for again once, and not again until the pages have
   * matched the walk, so a walk the paging never matches (a room the realm
   * does not place) pages once, not on every step. A push behind the paging
   * is waited for, not asked about.
   */
  const stale = on && paged.legs.length > 0 && walk.done >= paged.done && !matches;
  useEffect(() => {
    if (!stale) {
      if (matches) setAsked(false);
      return;
    }
    if (asked) return;
    setAsked(true);
    setAsks((count) => count + 1);
  }, [stale, matches, asked]);

  const last = paged.legs.length - 1;
  const page = useCallback(
    (to: number): void => {
      if (walking === null) return;
      const clamped = Math.max(walking, Math.min(last, to));
      setLook(clamped === walking ? null : clamped);
    },
    [walking, last]
  );
  const follow = useCallback((): void => setLook(null), []);

  // Once the walk reaches the page turned to, the pager follows it again.
  const shown = walking !== null && look !== null && look > walking ? look : null;
  return useMemo(
    () => ({ legs: paged.legs, walking, shown, page, follow }),
    [paged.legs, walking, shown, page, follow]
  );
}
