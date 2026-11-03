/**
 * The walk under way in the Map card's pages (todo 09), sent a little at a
 * time (todo 20261102-1008-02): the page being walked and the next go with
 * the answer, with every page's step count, and the rest are kept here for
 * the card to ask for as the walk or the pager reaches them. The last few
 * pagings per session are kept, so a second view of the character paging
 * the walk again does not strand the first. A page with a sheet carries a
 * decorated map for each floor, so a long walk sent whole was 100 KB or
 * more on every stop a loop reached. See `mudengine-ui` › `parts/map.md`.
 */
import { tuning } from '../app/tuning';
import type { SessionId } from '../../shared/ipc';
import { NO_WALK_PAGES, pageSteps, type RoutePage, type WalkPages } from '../../shared/routeLegs';
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
  private readonly kept = new Map<SessionId, readonly Kept[]>();
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
    const held = this.kept.get(session) ?? [];
    const keep = Math.max(1, tuning().world.walkPagingsKept);
    this.kept.set(session, [...held, { paging, legs }].slice(-keep));
    const sent = Math.max(1, tuning().world.walkPagesSent);
    return {
      paging,
      done: walk.progress.done,
      lengths: legs.map(pageSteps),
      legs: legs.slice(0, sent)
    };
  }

  /** Page `index` of `paging`, while that paging is still kept; null otherwise. */
  later(session: SessionId, paging: unknown, index: unknown): RoutePage | null {
    const kept = this.kept.get(session)?.find((entry) => entry.paging === paging);
    if (kept === undefined || !Number.isSafeInteger(index)) return null;
    return kept.legs[index as number] ?? null;
  }

  /** A closed session's pagings go with it. */
  forget(session: SessionId): void {
    this.kept.delete(session);
  }
}
