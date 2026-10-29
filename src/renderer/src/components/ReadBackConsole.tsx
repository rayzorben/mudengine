/**
 * A copy of the backscroll over the live console (todo 120), filled from
 * main's record and opened on the line the reader was on. It holds still; the
 * live console keeps running under it. It fills beneath the live console and
 * is raised once drawn, so the fill is never watched. When it opens and
 * closes is `useReadBack`'s; where the line is, `lib/readBack.ts`'s.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import TerminalView, { type TerminalHandle } from './TerminalView';
import type { IpcApi, SessionId } from '@shared/ipc';
import type { TerminalConfig } from '@shared/config';
import type { TerminalPalette } from '@shared/themes';
import type { TerminalSize } from '@shared/types';
import type { RoomReference } from '@shared/world';
import { t } from '../lib/i18n';
import { fillFrom, useBackscrollPages } from '../hooks/useBackscrollPages';
import type { ScrollEdge } from '../lib/pages';
import type { Place } from '../lib/readBack';
import type { NameIndex } from '../lib/names';
import type { PopoverAnchor } from '../lib/popover';

export interface ReadBackConsoleProps {
  api: Pick<IpcApi, 'backscrollPage' | 'onMarks'>;
  session: SessionId;
  /** The line to open on, or null to open at the last line (a search). */
  place: Place | null;
  /** Drawn and raised: `handle` is the copy's, for a search waiting on it. */
  onShown(handle: TerminalHandle): void;
  /** The reader is done with it. */
  onClose(): void;
  /** It has gone, however it went. */
  onGone(): void;
  /** A key typed while it is up: the live console's, and it closes the copy. */
  onInput(data: string): void;
  /** Said in the live console, which outlives the copy. */
  onFailed(message: string): void;
  onSearchResult(result: { index: number; count: number } | undefined): void;
  settings: TerminalConfig;
  timestamps: boolean;
  fontStack: string;
  palette: TerminalPalette;
  index?: NameIndex | null;
  onInspect?(name: string, at: PopoverAnchor): void;
  onSelectPlayer?(name: string, at: PopoverAnchor): void;
  onSelectGang?(name: string, at: PopoverAnchor): void;
  onSelectSlot?(slot: string, at: PopoverAnchor): void;
  onChooseRoom?(name: string, room: RoomReference | null): void;
}

/** The copy's own geometry is the live console's; it reports none. */
const NO_RESIZE = (_size: TerminalSize): void => {};
const NO_LOST_ENTER = (): void => {};

function ReadBackConsole({
  api,
  session,
  place,
  onShown,
  onClose,
  onGone,
  onInput,
  onFailed,
  onSearchResult,
  settings,
  timestamps,
  fontStack,
  palette,
  index,
  onInspect,
  onSelectPlayer,
  onSelectGang,
  onSelectSlot,
  onChooseRoom
}: ReadBackConsoleProps) {
  const handleRef = useRef<TerminalHandle | null>(null);
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  const pages = useBackscrollPages(api, session, handleRef, settings.scrollback);
  const loadingRef = useRef(false);
  loadingRef.current = pages.loading;
  const { attached, onEdge: pageEdge } = pages;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      onGone();
    },
    [onGone]
  );

  // A line it holds marked anew: the room left loses its buttons here too (todo 143).
  useEffect(
    () =>
      api.onMarks(({ session: from, payload }) => {
        if (from === session) handleRef.current?.marks(payload);
      }),
    [api, session]
  );

  // The first page is asked for once, at mount; the hold only grows after.
  const firstPage = useRef(pages.hold);
  const ready = useCallback(
    (handle: TerminalHandle) => {
      handleRef.current = handle;
      // A failure is said in the live console, which outlives the copy.
      const into = { refill: handle.refill, notice: onFailed };
      fillFrom(api, session, firstPage.current, firstPage.current, into, (older) => {
        if (!mounted.current) return;
        if (older === null) {
          onClose();
          return;
        }
        attached(older);
        // After the fill's own last scroll, which runs once this returns and
        // would otherwise move the reader back to the last line and close it.
        queueMicrotask(() => {
          if (!mounted.current) return;
          shownRef.current = true;
          if (place !== null && !handle.showPlace(place)) handle.notice(t('terminal.readBackLost'));
          setShown(true);
          onShown(handle);
        });
      });
    },
    [api, session, place, attached, onFailed, onClose, onShown]
  );

  const edge = useCallback(
    (at: ScrollEdge) => {
      pageEdge(at);
      // A fill passes the last line on its way; only a reader reaching it closes the copy.
      if (at === 'latest' && shownRef.current && !loadingRef.current) onClose();
    },
    [pageEdge, onClose]
  );

  return (
    <div className="read-back" data-shown={shown ? 'true' : 'false'}>
      {(pages.more !== null || pages.loading) && (
        <button
          className="jump-latest load-more"
          disabled={pages.loading}
          onClick={() => pages.more?.load()}
          type="button"
        >
          {pages.loading
            ? t('terminal.loadingMore')
            : t('terminal.loadMore', { count: (pages.more?.count ?? 0).toLocaleString() })}
        </button>
      )}
      <TerminalView
        fontStack={fontStack}
        index={index}
        onInput={onInput}
        onInspect={onInspect}
        onSelectPlayer={onSelectPlayer}
        onSelectGang={onSelectGang}
        onSelectSlot={onSelectSlot}
        onChooseRoom={onChooseRoom}
        onReady={ready}
        onResize={NO_RESIZE}
        onLostEnter={NO_LOST_ENTER}
        onSearchResult={onSearchResult}
        palette={palette}
        reportSize={false}
        settings={settings}
        timestamps={timestamps}
        scrollback={pages.hold}
        onEdge={edge}
        onLeave={onClose}
      />
    </div>
  );
}

export default memo(ReadBackConsole);
