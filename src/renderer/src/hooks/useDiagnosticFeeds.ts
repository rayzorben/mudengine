/**
 * The two feeds main sends only while this window shows them: `Push.line`,
 * for the Stream card (the diagnostics rail, a floated or pinned Stream
 * card), caught up from the retained lines when it opens; and the debug
 * feed, for `DebugView`.
 *
 * Out of `App` (todo 733). See `mudengine-ui` › *The window redraws what
 * changed*.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionViews } from './useSessionViews';
import { tuning } from '../lib/tuning';
import type { IpcApi, SessionId, SessionSummary } from '@shared/ipc';

export interface DiagnosticFeedInputs {
  api: Pick<IpcApi, 'debugFeed' | 'diagnostics' | 'getLines'>;
  /** The roster, whose retained lines a feed opening catches up. */
  sessions: readonly Pick<SessionSummary, 'id'>[];
  /** The diagnostics rail, which draws the Stream card. */
  railOpen: boolean;
  /** Whether the shown character has the Stream card floating. */
  streamFloating: boolean;
  debugOpen: boolean;
  patchView: SessionViews['patchView'];
}

/** @returns The report a pinned float makes of whether it holds the Stream card. */
export function useDiagnosticFeeds({
  api,
  sessions,
  railOpen,
  streamFloating,
  debugOpen,
  patchView
}: DiagnosticFeedInputs): (sid: SessionId, has: boolean) => void {
  /**
   * Characters other than the shown one whose *pinned* floats include the
   * Stream card. The per-line feed is sent only while something in this window
   * shows it (see `wantsLineFeed`), and a pinned stream float is the one
   * consumer the shown character's layout cannot answer for — uncounted, it
   * would quietly freeze whenever the rail was closed.
   */
  const [pinnedStreams, setPinnedStreams] = useState<ReadonlySet<SessionId>>(() => new Set());
  const noteStreamFloat = useCallback((sid: SessionId, has: boolean) => {
    setPinnedStreams((prev) => {
      if (prev.has(sid) === has) return prev;
      const next = new Set(prev);
      if (has) next.add(sid);
      else next.delete(sid);
      return next;
    });
  }, []);

  /** For the line-feed catch-up, which must not re-run on a roster push. */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /**
   * Whether anything in this window is showing the per-line diagnostics feed.
   *
   * `Push.line` is the one push that arrives at stream rate, and only the
   * Stream card reads it — hidden by default — so main sends it only while
   * this window has declared interest. Opening the feed re-asks for the
   * retained lines rather than replaying the pushes missed while it was
   * closed.
   */
  const wantsLineFeed = railOpen || streamFloating || pinnedStreams.size > 0;
  /*
   * And the debug feed, which is a *second* flag.
   *
   * It produces several records per framed line where `Push.line` produces
   * one, and only `DebugView` subscribes to it — so a window with the
   * diagnostics rail open, or a pinned Stream float, must not be sent records
   * nothing in it reads. Told to main on its own edge, and told immediately:
   * unlike the line feed there is no flap to wait out, because nothing else in
   * the window can ask for this one.
   */
  useEffect(() => {
    api.debugFeed(debugOpen);
    return () => api.debugFeed(false);
  }, [api, debugOpen]);
  /**
   * Whether main currently has this window's feed on. A tab switch away from
   * a character with a pinned stream float reads as *off* for one commit —
   * the float's report lands a commit later — and acting on that flap would
   * stop the feed and re-fetch every session per switch. So the on edge is
   * immediate and skips the catch-up when the feed never actually stopped,
   * and the off edge waits out a flap before standing down.
   */
  const feedOnRef = useRef(false);
  useEffect(() => {
    if (wantsLineFeed) {
      const wasOn = feedOnRef.current;
      feedOnRef.current = true;
      api.diagnostics(true);
      if (wasOn) return;
      for (const entry of sessionsRef.current) {
        const sid = entry.id;
        void api.getLines(sid).then((lines) =>
          patchView(sid, (v) => {
            /*
             * The fetch is a snapshot of a *growing* log, so it must not
             * replace outright: a line pushed while the fetch was in the air
             * is applied ahead of this patch, and replacing dropped it from
             * the one card whose job is to be the faithful record of framing.
             * Everything at or before the fetch's newest line is superseded
             * by the fetch; everything after it is kept. `at` guards the seam
             * too, because `seq` restarts per connection and a stale line
             * from an older session can carry a higher one.
             */
            const fetched = lines.slice(-tuning().lineLogLimit);
            const newest = fetched[fetched.length - 1];
            if (!newest) return v;
            const tail = v.lines.filter((line) => line.seq > newest.seq && line.at >= newest.at);
            return { ...v, lines: [...fetched, ...tail].slice(-tuning().lineLogLimit) };
          })
        );
      }
      return;
    }
    const settle = window.setTimeout(() => {
      feedOnRef.current = false;
      api.diagnostics(false);
    }, tuning().chromeFlushMs);
    return () => window.clearTimeout(settle);
  }, [api, wantsLineFeed, patchView]);

  return noteStreamFloat;
}
