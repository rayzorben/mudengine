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
 * walked. Only the page being walked and the next arrive with the paging; a
 * page further on is asked for when the pager turns to it, and drawn once it
 * lands (todo 20261102-1008-02). See `mudengine-ui` › `parts/map.md` ›
 * *The route preview*.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { NO_WALK_PAGES, pageWalking, type RoutePage, type WalkPages } from '@shared/routeLegs';
import { errorMessage } from '@shared/values';
import type { WalkProgress } from '@shared/walk';
import { roomId } from '@shared/world';

export interface WalkPager {
  /** Every page of the walk; one not yet sent is undefined until it is turned to. */
  legs: ReadonlyArray<RoutePage | undefined>;
  /** The page the character is on; null while nothing is walked. */
  walking: number | null;
  /** A page ahead the reader turned to; null while the pager follows the walk. */
  shown: number | null;
  page(index: number): void;
  /** Back to the page being walked. */
  follow(): void;
}

/** No page turned to past the ones sent. */
const NO_LATER = { paging: 0, pages: new Map<number, RoutePage>() } as const;

/** A page past the ones the paging sent, by the paging's number (`IpcApi.walkPage`). */
export type LoadWalkPage = (paging: number, index: number) => Promise<RoutePage | null>;

export function useWalkPages(
  load: () => Promise<WalkPages>,
  loadPage: LoadWalkPage,
  walk: WalkProgress
): WalkPager {
  /* The pages, with the route they were asked for, so a new route never reads the last one's. */
  const [held, setHeld] = useState<{ route: string; pages: WalkPages } | null>(null);
  /* The pages turned to past the ones sent, by the paging they belong to. */
  const [later, setLater] = useState<{ paging: number; pages: ReadonlyMap<number, RoutePage> }>(
    NO_LATER
  );
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

  const extra = later.paging === paged.paging ? later.pages : NO_LATER.pages;
  const legs = useMemo(
    () => paged.lengths.map((_, at) => paged.legs[at] ?? extra.get(at)),
    [paged, extra]
  );
  const index = pageWalking(paged.lengths, walk.done - paged.done);
  const current = index === null ? undefined : legs[index];
  /* The walk reached a page that was not sent: it is asked for, not paged again. */
  const owed = index !== null && current === undefined;
  const matches = current !== undefined && here !== null && current.rooms.includes(here);
  const walking = on && matches ? index : null;

  /*
   * Stale pages are asked for again once, and not again until the pages have
   * matched the walk, so a walk the paging never matches (a room the realm
   * does not place) pages once, not on every step. A push behind the paging
   * is waited for, not asked about.
   */
  const stale = on && paged.lengths.length > 0 && walk.done >= paged.done && !matches && !owed;
  useEffect(() => {
    if (!stale) {
      if (matches) setAsked(false);
      return;
    }
    if (asked) return;
    setAsked(true);
    setAsks((count) => count + 1);
  }, [stale, matches, asked]);

  /*
   * A page not sent is asked for when the walk or the pager reaches it. A
   * paging main no longer keeps answers null: the walk is paged again once,
   * and a page turned to in the old paging is let go, since the new one
   * numbers its pages from where the character stands.
   */
  const wanted = on && owed ? index : look !== null && legs[look] === undefined ? look : null;
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    if (wanted === null) return;
    const { paging } = paged;
    let live = true;
    void loadPage(paging, wanted)
      .then((page) => {
        if (!live) return;
        if (page !== null) {
          setLater((kept) => {
            const pages = new Map(kept.paging === paging ? kept.pages : []);
            pages.set(wanted, page);
            return { paging, pages };
          });
          return;
        }
        if (refused === paging) return;
        setRefused(paging);
        setLook(null);
        setAsks((count) => count + 1);
      })
      .catch((error) => {
        console.error(`[map] the walk's page ${wanted + 1}: ${errorMessage(error)}`);
      });
    return () => {
      live = false;
    };
  }, [wanted, paged, loadPage, refused]);

  const last = paged.lengths.length - 1;
  const page = useCallback(
    (to: number): void => {
      if (walking === null) return;
      const clamped = Math.max(walking, Math.min(last, to));
      setLook(clamped === walking ? null : clamped);
    },
    [walking, last]
  );
  const follow = useCallback((): void => setLook(null), []);

  // Once the walk reaches the page turned to, the pager follows it again. A
  // page still on its way leaves the page being walked on screen.
  const shown =
    walking !== null && look !== null && look > walking && legs[look] !== undefined ? look : null;
  return useMemo(
    () => ({ legs, walking, shown, page, follow }),
    [legs, walking, shown, page, follow]
  );
}
