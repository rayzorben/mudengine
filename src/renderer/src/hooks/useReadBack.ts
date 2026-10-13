/**
 * Reading further back than the live console holds (todo 120): when the copy
 * of the backscroll (`ReadBackConsole`) opens and closes, and what the window
 * is handed while it is up. Past the live console's top it opens on the
 * reader's line; Find opens it at its last line. Any key, from either
 * console, Jump to latest, or reaching its last line closes it, and the live
 * console is back at the game. See `mudengine-ui` › *A console holds a short
 * scroll up*.
 */
import { useCallback, useRef, useState, type RefObject } from 'react';

import type { TerminalHandle } from '../components/TerminalView';
import type { ScrollEdge } from '../lib/pages';
import type { Place } from '../lib/readBack';

export interface ReadBack {
  /** The copy to draw and the line it opens on, or null while there is none. */
  open: { place: Place | null } | null;
  /** The live console's edges: past its top, while main has older lines, the copy opens. */
  liveEdge(edge: ScrollEdge): void;
  /** Main keeps this many lines older than the live console was sent. */
  olderThanLive(count: number): void;
  /**
   * A rewrite of the live console starts or ends; the edges it passes are not
   * the reader's. Rewrites can overlap, and each start is ended once.
   */
  rewriting(on: boolean): void;
  /** A key for the game, typed in either console: it ends the reading back. */
  input(data: string): void;
  /** What the window is given of the live console: Find reads the copy, Jump to latest leaves it. */
  handOut(live: TerminalHandle): Pick<TerminalHandle, 'search' | 'jumpToLatest'>;
  /** The copy is drawn, and this is its handle. */
  shown(copy: TerminalHandle): void;
  /** The reader is done with the copy. */
  close(): void;
  /** The copy has gone, however it went. */
  gone(): void;
}

export function useReadBack(
  live: RefObject<TerminalHandle | null>,
  send: (data: string) => void
): ReadBack {
  const [open, setOpen] = useState<ReadBack['open']>(null);
  /** Read where a state would lag a key: is the copy up. */
  const isOpen = useRef(false);
  const copy = useRef<TerminalHandle | null>(null);
  /** A search asked for before the copy was drawn, run once it is. */
  const waiting = useRef<((copy: TerminalHandle) => void) | null>(null);
  const older = useRef(0);
  /** Rewrites under way: a second can start before the first is drawn. */
  const rewrites = useRef(0);

  const openOn = useCallback((place: Place | null) => {
    if (isOpen.current) return;
    isOpen.current = true;
    setOpen({ place });
  }, []);

  const close = useCallback(() => {
    if (!isOpen.current) return;
    isOpen.current = false;
    copy.current = null;
    waiting.current = null;
    setOpen(null);
    live.current?.jumpToLatest();
  }, [live]);

  const gone = useCallback(() => {
    copy.current = null;
    waiting.current = null;
  }, []);

  const shown = useCallback((drawn: TerminalHandle) => {
    copy.current = drawn;
    waiting.current?.(drawn);
    waiting.current = null;
  }, []);

  const liveEdge = useCallback(
    (edge: ScrollEdge) => {
      const handle = live.current;
      if (edge !== 'top' || handle === null || rewrites.current > 0) return;
      if (older.current > 0 || handle.atCapacity()) openOn(handle.place());
    },
    [live, openOn]
  );

  const olderThanLive = useCallback((count: number) => {
    older.current = count;
  }, []);

  const rewriting = useCallback((on: boolean) => {
    rewrites.current = Math.max(0, rewrites.current + (on ? 1 : -1));
  }, []);

  const input = useCallback(
    (data: string) => {
      close();
      send(data);
    },
    [close, send]
  );

  const handOut = useCallback(
    (handle: TerminalHandle): Pick<TerminalHandle, 'search' | 'jumpToLatest'> => ({
      search: (query, direction) => {
        const drawn = copy.current;
        if (drawn !== null) return drawn.search(query, direction);
        if (query.length === 0) return handle.search(query, direction);
        waiting.current = (opened) => opened.search(query, direction);
        openOn(null);
      },
      jumpToLatest: () => {
        if (isOpen.current) close();
        else handle.jumpToLatest();
      }
    }),
    [openOn, close]
  );

  return { open, liveEdge, olderThanLive, rewriting, input, handOut, shown, close, gone };
}
