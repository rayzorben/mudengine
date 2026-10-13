/**
 * How much the copy of a character's backscroll holds, and the page
 * it brings back at the top (`ReadBackConsole`, todo 120). See `lib/pages.ts`
 * and `mudengine-ui` › *A console holds a page of backscroll*.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { TerminalHandle } from '../components/TerminalView';
import { errorMessage } from '@shared/values';
import type { IpcApi, SessionId } from '@shared/ipc';
import { t } from '../lib/i18n';
import { onePage, widened, type ScrollEdge } from '../lib/pages';
import { tuning } from '../lib/tuning';

export interface BackscrollPages {
  /** Lines the console holds now. */
  hold: number;
  /** The next page, offered while the reader is at the oldest line held; null otherwise. */
  more: { count: number; load(): void } | null;
  /** A load is on its way or being written. */
  loading: boolean;
  /** Where the reader is, from the console. */
  onEdge(edge: ScrollEdge): void;
  /** How many lines main kept older than the first page handed over. */
  attached(older: number): void;
}

/**
 * A console rewritten with main's newest `lines` lines: the one way a console
 * is filled from main after its attach. `done` has the older lines main still
 * keeps, or null when the page could not be had (said through `into.notice`).
 */
export function fillFrom(
  api: Pick<IpcApi, 'backscrollPage'>,
  session: SessionId,
  lines: number,
  /** The lines the console keeps once filled; at least `lines`. */
  keep: number,
  into: Pick<TerminalHandle, 'refill' | 'notice'>,
  done: (older: number | null) => void
): void {
  api.backscrollPage(session, lines).then(
    (got) => into.refill(got.text, Math.max(lines, keep), () => done(got.older)),
    (error: unknown) => {
      into.notice(t('terminal.loadMoreFailed', { message: errorMessage(error) }));
      done(null);
    }
  );
}

export function useBackscrollPages(
  api: Pick<IpcApi, 'backscrollPage'>,
  session: SessionId,
  handle: RefObject<TerminalHandle | null>,
  /** What main keeps: `terminal.scrollback`. */
  keep: number
): BackscrollPages {
  const page = tuning().consolePageLines;
  const [hold, setHold] = useState(() => onePage(page, keep));
  /** Lines the next page brings back, worked out when the reader reaches the top; 0 offers none. */
  const [offer, setOffer] = useState(0);
  const [loading, setLoading] = useState(false);
  /** Older lines main had when last asked. Lines scrolled off since are older too (`atCapacity`). */
  const older = useRef(0);
  const loadingRef = useRef(false);
  const holdRef = useRef(hold);
  holdRef.current = hold;

  // `terminal.scrollback` lowered under a widened console.
  useEffect(() => setHold((was) => Math.min(was, keep)), [keep]);

  /*
   * Lines scrolled off the console since main was asked are older too, and
   * uncounted; until then main's `older` is the most there is.
   */
  const nextPage = useCallback((): number => {
    const room = Math.min(page, keep - holdRef.current);
    if (handle.current?.atCapacity() === true) return room;
    return Math.min(room, older.current);
  }, [page, keep, handle]);

  const onEdge = useCallback(
    (edge: ScrollEdge) => {
      // A refill fills from the top and passes the live edge on its way.
      if (loadingRef.current) return;
      setOffer(edge === 'top' ? nextPage() : 0);
      // Back at the latest line, the pages brought back are let go.
      if (edge === 'latest') setHold(onePage(page, keep));
    },
    [page, keep, nextPage]
  );

  /** Asks main for a page of `lines` and rewrites the console with it. */
  const fetchPage = useCallback(
    (lines: number) => {
      const to = handle.current;
      if (to === null || loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setOffer(0);
      fillFrom(api, session, lines, lines, to, (got) => {
        if (got !== null) {
          older.current = got;
          setHold(lines);
        }
        loadingRef.current = false;
        setLoading(false);
      });
    },
    [api, session, handle]
  );

  const load = useCallback(
    () => fetchPage(widened(holdRef.current, page, keep)),
    [fetchPage, page, keep]
  );

  const attached = useCallback((count: number) => {
    older.current = count;
  }, []);

  return {
    hold,
    more: offer > 0 && !loading ? { count: offer, load } : null,
    loading,
    onEdge,
    attached
  };
}
