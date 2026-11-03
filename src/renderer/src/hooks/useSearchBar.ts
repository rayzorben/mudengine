/**
 * The backscroll search bar: whether it is open, what the shown console last
 * answered, and closing it, which hands the caret back.
 *
 * Out of `App` (todo 732) with the state it owns. See `mudengine-ui` ›
 * *Focus lives in the terminal*.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SearchResult } from '../components/SearchBar';
import type { TerminalHandle } from '../components/TerminalView';
import type { SessionId } from '@shared/ipc';

export interface SearchBarState {
  open: boolean;
  /** The shown console's answer to the last query, or undefined before one. */
  result: SearchResult | undefined;
  /** Where a console reports its answer (`SessionTerminal.onSearchResult`). */
  setResult(result: SearchResult | undefined): void;
  /** Open it; the bar takes the caret itself. */
  openSearch(): void;
  close(): void;
  toggle(): void;
  run(query: string, direction: 'next' | 'previous'): void;
}

type Searched = Pick<TerminalHandle, 'search'>;

/**
 * @param session The character on screen, whose console the bar searches.
 * @param consoles Each character's console, while its tab is open.
 * @param returnFocus The window's one hand-back.
 */
export function useSearchBar(
  session: SessionId,
  consoles: { readonly current: ReadonlyMap<SessionId, Searched> },
  returnFocus: () => void
): SearchBarState {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SearchResult | undefined>(undefined);
  /** Whose console holds the marks, and what it was asked, until the bar clears it. */
  const searched = useRef<{ session: SessionId; query: string } | null>(null);

  /** Clears the marks a find left on another character's console. */
  const clearOther = useCallback(
    (shown: SessionId) => {
      const held = searched.current;
      if (held !== null && held.session !== shown) consoles.current.get(held.session)?.search('', 'next');
    },
    [consoles]
  );

  const openSearch = useCallback(() => setOpen(true), []);

  /*
   * Search is a dialog that takes typed input, so closing it hands focus back
   * to the terminal — the same contract the palette honours.
   */
  const close = useCallback(() => {
    setOpen(false);
    setResult(undefined);
    clearOther(session);
    searched.current = null;
    consoles.current.get(session)?.search('', 'next');
    returnFocus();
  }, [session, consoles, clearOther, returnFocus]);

  const toggle = useCallback(() => {
    if (open) close();
    else setOpen(true);
  }, [open, close]);

  const run = useCallback(
    (query: string, direction: 'next' | 'previous') => {
      clearOther(session);
      searched.current = { session, query };
      consoles.current.get(session)?.search(query, direction);
    },
    [session, consoles, clearOther]
  );

  /*
   * Each console keeps its own marks and reports its own count, and only the
   * shown one's count reaches the bar (`SessionTerminal`). A switch with the
   * bar open clears the marks left on the other character's console and asks
   * the shown one the same question, so the count is always this console's.
   */
  useEffect(() => {
    const held = searched.current;
    if (held === null || held.session === session) return;
    setResult(undefined);
    run(held.query, 'next');
  }, [session, run]);

  return { open, result, setResult, openSearch, close, toggle, run };
}
