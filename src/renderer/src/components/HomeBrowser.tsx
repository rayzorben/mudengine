import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent
} from 'react';

import type { DirectoryEntry, HomeListing } from '@shared/ipc';
import Icon from './Icon';
import { writeClipboard } from '../lib/clipboard';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { PickKind } from '../lib/pickers';
import { uploadToClient } from '../lib/upload';

export interface HomeBrowserProps {
  /** Where to open: a path under the client's home, or null for its root. */
  start: string | null;
  /**
   * When choosing a file: what is being chosen, and the hand-back called
   * with the path, or null when dismissed. Null when merely showing where
   * something is.
   */
  pick: { kind: PickKind; resolve(file: string | null): void } | null;
  onClose(): void;
}

/** One separator, the platform's, inferred from the path the client gave. */
function join(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return `${dir}${name}`;
  return `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;
}

/** The dialog's title for what is being chosen. */
function pickTitle(kind: PickKind): string {
  switch (kind) {
    case 'realm':
      return t('browser.pickTitle.realm');
    case 'layout':
      return t('browser.pickTitle.layout');
    case 'character':
      return t('browser.pickTitle.character');
    default: {
      const never: never = kind;
      return never;
    }
  }
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
 * file* and its siblings open there, and what every file picker draws
 * (`lib/pickers.ts`), with an upload from the viewer's own machine beside
 * the listing (`lib/upload.ts`). Names and sizes only, never
 * contents: the listing comes from `Invoke.browseHome`, whose header says
 * why, and the row of the file that was asked about is marked.
 *
 * The same box every dialog over the console is drawn in (`.palette`), and
 * the same rules: Escape puts it away, a click on the scrim puts it away,
 * and every control keeps the caret where it was.
 */
export default function HomeBrowser({ start, pick, onClose }: HomeBrowserProps) {
  const api = window.mudengine;
  const [listing, setListing] = useState<HomeListing | null>(null);
  const [loading, setLoading] = useState(true);
  /** An upload on its way, by file name, or why the last one was refused. */
  const [upload, setUpload] = useState<
    { kind: 'sending'; name: string } | { kind: 'refused'; error: string } | null
  >(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const onPick = pick?.resolve ?? null;

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

  /*
   * The viewer's own file, sent to the client and handed back as the path it
   * was stored at, as if picked from the listing. A dismiss while it is on
   * its way has already answered the picker and closed this dialog, so a
   * late answer touches nothing: its `onClose` would close whatever dialog
   * is open by then.
   */
  const sending = useRef(false);
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    []
  );
  const onUploadChosen = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = '';
      if (file === null || onPick === null || sending.current) return;
      sending.current = true;
      setUpload({ kind: 'sending', name: file.name });
      void uploadToClient(file).then((answer) => {
        sending.current = false;
        if (gone.current) return;
        if (answer.kind === 'refused') {
          setUpload(answer);
          return;
        }
        setUpload(null);
        onPick(answer.file);
        onClose();
      });
    },
    [onPick, onClose]
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

  const picking = pick !== null;
  const title = pick === null ? t('browser.title') : pickTitle(pick.kind);
  const shown = listing?.dir ?? start ?? '';

  return (
    <div className="palette-scrim home-browser-scrim" onMouseDown={dismiss} role="presentation">
      <div
        aria-label={title}
        aria-modal="true"
        className="surface palette home-browser"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        ref={frame}
        role="dialog"
        tabIndex={-1}
      >
        <header className="home-browser-head">
          <span className="home-browser-title">{title}</span>
          <span className="home-browser-actions">
            {picking && (
              <button
                className="quiet"
                data-upload="true"
                disabled={upload?.kind === 'sending'}
                onClick={() => fileInput.current?.click()}
                onMouseDown={keepFocus}
                title={t('browser.upload.hint')}
                type="button"
              >
                <Icon name="upload" />
                {t('browser.upload.button')}
              </button>
            )}
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
        {picking && (
          <input
            className="home-browser-file"
            hidden
            onChange={onUploadChosen}
            ref={fileInput}
            tabIndex={-1}
            type="file"
          />
        )}
        {upload !== null && (
          <div
            className="home-browser-upload"
            data-state={upload.kind}
            role={upload.kind === 'refused' ? 'alert' : 'status'}
          >
            {upload.kind === 'sending'
              ? t('browser.upload.sending', { name: upload.name })
              : upload.error}
          </div>
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
