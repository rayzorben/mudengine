/**
 * The walk under way in the Map card's pages (todo 09), sent a little at a
 * time (todo 20261102-1008-02): the page being walked and the next go with
 * the answer, and the rest are kept here, one paging per session, for the
 * pager to ask for as it turns to them. A page with a sheet carries a
 * decorated map for each floor, so a long walk sent whole was 100 KB or
 * more on every stop a loop reached. See `mudengine-ui` › `parts/map.md`.
 */
import { tuning } from '../app/tuning';
import type { SessionId } from '../../shared/ipc';
import { NO_WALK_PAGES, type RoutePage, type WalkPages } from '../../shared/routeLegs';
import type { RoomId, Route, RouteStep } from '../../shared/world';

/** What of the walker the paging reads. */
export interface PagedWalk {
  readonly remaining: readonly RouteStep[];
  readonly progress: { readonly done: number };
}

/** Pages a route from `start` on the session's realm; null with no realm data. */
export type PageRoute = (route: Route, start: RoomId) => RoutePage[] | null;

interface Kept {
  readonly paging: number;
  readonly legs: readonly RoutePage[];
}

export class WalkPaging {
  private readonly kept = new Map<SessionId, Kept>();
  private next = 1;

  /** The walk paged from where the character stands, with its first pages. */
  first(session: SessionId, walk: PagedWalk | undefined, pageRoute: PageRoute): WalkPages {
    const steps = walk?.remaining ?? [];
    const start = steps[0]?.from;
    // The paging reads the steps alone; the cost was spent choosing them.
    const legs =
      walk === undefined || start === undefined
        ? null
        : pageRoute({ steps: [...steps], cost: 0, blocked: false }, start);
    if (walk === undefined || legs === null) {
      this.kept.delete(session);
      return NO_WALK_PAGES;
    }
    const paging = this.next;
    this.next += 1;
    this.kept.set(session, { paging, legs });
    const sent = Math.max(1, tuning().world.walkPagesSent);
    return { paging, done: walk.progress.done, count: legs.length, legs: legs.slice(0, sent) };
  }

  /** Page `index` of `paging`, while it is still the session's; null otherwise. */
  later(session: SessionId, paging: unknown, index: unknown): RoutePage | null {
    const kept = this.kept.get(session);
    if (kept === undefined || kept.paging !== paging || !Number.isSafeInteger(index)) return null;
    return kept.legs[index as number] ?? null;
  }

  /** A closed session's paging goes with it. */
  forget(session: SessionId): void {
    this.kept.delete(session);
  }
}
