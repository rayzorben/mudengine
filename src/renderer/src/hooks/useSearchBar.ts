/**
 * The backscroll search bar: whether it is open, what the shown console last
 * answered, and closing it, which hands the caret back.
 *
 * Out of `App` (todo 732) with the state it owns. See `mudengine-ui` ›
 * *Focus lives in the terminal*.
 */
import { useCallback, useState } from 'react';

import type { SearchResult } from '../components/SearchBar';
import type { TerminalHandle } from '../components/TerminalView';

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

/**
 * @param terminal The console on screen, read when the bar acts.
 * @param returnFocus The window's one hand-back.
 */
export function useSearchBar(
  terminal: () => Pick<TerminalHandle, 'search'> | null,
  returnFocus: () => void
): SearchBarState {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SearchResult | undefined>(undefined);

  const openSearch = useCallback(() => setOpen(true), []);

  /*
   * Search is a dialog that takes typed input, so closing it hands focus back
   * to the terminal — the same contract the palette honours.
   */
  const close = useCallback(() => {
    setOpen(false);
    setResult(undefined);
    terminal()?.search('', 'next');
    returnFocus();
  }, [terminal, returnFocus]);

  const toggle = useCallback(() => {
    if (open) close();
    else setOpen(true);
  }, [open, close]);

  const run = useCallback(
    (query: string, direction: 'next' | 'previous') => {
      terminal()?.search(query, direction);
    },
    [terminal]
  );

  return { open, result, setResult, openSearch, close, toggle, run };
}
