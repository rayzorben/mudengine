import { useEffect, useRef, useState, type FormEvent } from 'react';

import Icon from './Icon';
import { t } from '../lib/i18n';

/**
 * Find-in-backscroll.
 *
 * 100,000 lines of scrollback is only useful if you can get back to a line you
 * half-remember. The bar is a dialog that takes typed input, so per the focus
 * policy (docs/ui-design.md §3.6) it takes focus while open and hands it back
 * to the terminal the moment it closes — by `Esc`, by the close button, or by
 * the shortcut that opened it.
 *
 * It sits inside the terminal cell rather than floating over the slate: it is
 * about the stream, and glass never covers the terminal (§1).
 */
export interface SearchBarProps {
  open: boolean;
  /** Runs a search and reports how many matches there are. */
  onSearch(query: string, direction: 'next' | 'previous'): void;
  onClose(): void;
  /** `undefined` while no search has run; otherwise the live match count. */
  result: SearchResult | undefined;
}

export interface SearchResult {
  index: number;
  count: number;
}

export default function SearchBar({ open, onSearch, onClose, result }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // After paint, so the opening transition does not eat the caret.
    const id = window.requestAnimationFrame(() => inputRef.current?.select());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (query.length > 0) onSearch(query, 'next');
  };

  return (
    <form className="surface search-bar" onSubmit={submit} role="search">
      <input
        aria-label={t('terminal.search.inputLabel')}
        onChange={(event) => {
          setQuery(event.target.value);
          // Search as you type, so the count is live rather than a step you
          // have to remember to take.
          onSearch(event.target.value, 'next');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            onSearch(query, 'previous');
          }
        }}
        placeholder={t('terminal.search.placeholder')}
        ref={inputRef}
        value={query}
      />

      <span className={`search-count${result && result.count === 0 ? ' empty' : ''}`}>
        {query.length === 0
          ? ''
          : result && result.count > 0
            ? t('terminal.search.matchCount', {
                currentMatch: result.index + 1,
                totalMatches: result.count
              })
            : t('terminal.search.noMatches')}
      </span>

      <button
        aria-label={t('terminal.search.previousLabel')}
        onClick={() => onSearch(query, 'previous')}
        type="button"
      >
        ↑
      </button>
      <button
        aria-label={t('terminal.search.nextLabel')}
        onClick={() => onSearch(query, 'next')}
        type="button"
      >
        ↓
      </button>
      <button
        aria-label={t('terminal.search.closeLabel')}
        className="quiet"
        onClick={onClose}
        type="button"
      >
        <Icon name="close" />
      </button>
    </form>
  );
}
