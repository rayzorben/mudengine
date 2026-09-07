import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { DirectoryEntry, HomeListing } from '@shared/ipc';
import Icon from './Icon';
import { writeClipboard } from '../lib/clipboard';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface HomeBrowserProps {
  /** Where to open: a path under the client's home, or null for its root. */
  start: string | null;
  /**
   * When choosing a file: called with the path, or null when dismissed. Null
   * when merely showing where something is.
   */
  onPick: ((file: string | null) => void) | null;
  onClose(): void;
}

/** One separator, the platform's, inferred from the path the client gave. */
function join(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return `${dir}${name}`;
  return `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;
}

/** Bytes as a person reads them. Integers only; a size is not a measurement. */
function formatSize(size: number | null): string {
  if (size === null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A directory under the client's home, drawn in the window.
 *
 * The desktop client reveals a path by opening the operating system's file
 * manager. A browser tab cannot — the files are on the machine the client
 * runs on, not the one the tab is on — so this is what *Show the options
 * file* and its siblings open there, and what the realm picker draws when
 * a database is chosen (`lib/pickers.ts`). Names and sizes only, never
 * contents: the listing comes from `Invoke.browseHome`, whose header says
 * why, and the row of the file that was asked about is marked.
 *
 * The same box every dialog over the console is drawn in (`.palette`), and
 * the same rules: Escape puts it away, a click on the scrim puts it away,
 * and every control keeps the caret where it was.
 */
export default function HomeBrowser({ start, onPick, onClose }: HomeBrowserProps) {
  const api = window.mudengine;
  const [listing, setListing] = useState<HomeListing | null>(null);
  const [loading, setLoading] = useState(true);
  const frame = useRef<HTMLDivElement | null>(null);

  const browse = useCallback(
    (target: string | null) => {
      setLoading(true);
      void api.browseHome(target).then((next) => {
        setListing(next);
        setLoading(false);
      });
    },
    [api]
  );

  useEffect(() => {
    browse(start);
  }, [browse, start]);

  // The dialog holds the keyboard while it is up, so Escape reaches it and
  // not the realm; it is handed back by whoever closes it.
  useEffect(() => {
    frame.current?.focus();
  }, []);

  const dismiss = useCallback(() => {
    onPick?.(null);
    onClose();
  }, [onPick, onClose]);

  const choose = useCallback(
    (entry: DirectoryEntry) => {
      if (!listing) return;
      const full = join(listing.dir, entry.name);
      if (entry.kind === 'directory') {
        browse(full);
        return;
      }
      if (onPick && entry.kind === 'file') {
        onPick(full);
        onClose();
      }
    },
    [browse, listing, onPick, onClose]
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    dismiss();
  };

  const copyPath = useCallback(() => {
    if (!listing) return;
    void writeClipboard(listing.selected ? join(listing.dir, listing.selected) : listing.dir);
  }, [listing]);

  const picking = onPick !== null;
  const shown = listing?.dir ?? start ?? '';

  return (
    <div className="palette-scrim home-browser-scrim" onMouseDown={dismiss} role="presentation">
      <div
        aria-label={picking ? t('browser.pickTitle') : t('browser.title')}
        aria-modal="true"
        className="surface palette home-browser"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={frame}
        role="dialog"
        tabIndex={-1}
      >
        <header className="home-browser-head">
          <span className="home-browser-title">
            {picking ? t('browser.pickTitle') : t('browser.title')}
          </span>
          <span className="home-browser-actions">
            <button
              className="quiet"
              disabled={!listing || listing.parent === null}
              onClick={() => listing?.parent && browse(listing.parent)}
              onMouseDown={keepFocus}
              title={t('browser.up')}
              type="button"
            >
              <Icon name="chevronUp" />
              {t('browser.up')}
            </button>
            <button
              className="quiet"
              disabled={!listing}
              onClick={copyPath}
              onMouseDown={keepFocus}
              title={t('browser.copyPath')}
              type="button"
            >
              <Icon name="copy" />
              {t('browser.copyPath')}
            </button>
            <button
              aria-label={t('browser.close')}
              className="quiet"
              onClick={dismiss}
              onMouseDown={keepFocus}
              title={t('browser.close')}
              type="button"
            >
              <Icon name="close" />
            </button>
          </span>
        </header>
        <div className="home-browser-path" title={shown}>
          {shown}
        </div>
        {/*
          Where a choice can come from, said on the dialog and not only in the
          README: the client's own files, which in a container is its volume,
          and a database has to be put there before it can be chosen here.
        */}
        {picking && listing !== null && (
          <div className="home-browser-scope">{t('browser.pickScope', { root: listing.root })}</div>
        )}

        {loading && listing === null ? (
          <div className="empty">{t('browser.loading')}</div>
        ) : listing === null || listing.error !== null ? (
          <div className="empty">{listing?.error ?? t('browser.loading')}</div>
        ) : listing.entries.length === 0 ? (
          <div className="empty">{t('browser.empty')}</div>
        ) : (
          <ul aria-busy={loading} role="list">
            {listing.entries.map((entry) => {
              const openable = entry.kind === 'directory' || (picking && entry.kind === 'file');
              return (
                <li
                  data-kind={entry.kind}
                  data-realm={entry.realm ? 'true' : undefined}
                  data-selected={listing.selected === entry.name ? 'true' : undefined}
                  key={entry.name}
                >
                  <button
                    className="home-browser-row"
                    disabled={!openable}
                    onClick={() => choose(entry)}
                    onMouseDown={keepFocus}
                    type="button"
                  >
                    <Icon name={entry.kind === 'directory' ? 'folder' : 'fileText'} />
                    <span className="home-browser-name">{entry.name}</span>
                    {entry.realm && <span className="chip info">{t('browser.realmChip')}</span>}
                    <span className="hint">{formatSize(entry.size)}</span>
                    {picking && entry.kind === 'file' && (
                      <span className="hint">{t('browser.use')}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
