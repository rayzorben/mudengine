import { memo, useCallback, useEffect, useRef, useState } from 'react';

import TerminalView, { type TerminalHandle } from './TerminalView';
import { errorMessage } from '@shared/values';
import { t } from '../lib/i18n';
import type { AttachSnapshot, SessionId } from '@shared/ipc';
import type { TerminalConfig } from '@shared/config';
import type { StreamChunk, TerminalSize } from '@shared/types';
import type { NameIndex } from '../lib/names';
import type { PopoverAnchor } from '../lib/popover';
import type { TerminalPalette } from '@shared/themes';

/** What a pane that is not being read reports to the search bar: nothing, and the same nothing every time. */
const NO_RESULT = (): undefined => undefined;

export interface SessionTerminalProps {
  session: SessionId;
  /** Every name this character's realm knows, for the console to recognise. */
  /** The console's name index for this character — the realm's names and the people. */
  index?: NameIndex | null;
  /** A recognised name clicked in the console, and the cell box it sits in. */
  onInspect?(name: string, at: PopoverAnchor): void;
  onSelectPlayer?(session: SessionId, name: string, at: PopoverAnchor): void;
  onSelectGang?(session: SessionId, name: string, at: PopoverAnchor): void;
  /** A room's name clicked in the console: the route panel, on that room. */
  onChooseRoom?(name: string): void;
  /** Whether a pane is currently showing this character. */
  shown: boolean;
  /** Whether this is the pane the keyboard is talking to. */
  focused: boolean;
  /** Which pane it occupies. A character with no pane parks in the focused one. */
  pane: number;
  /** How the panes are laid out, which decides the axis `pane` indexes. */
  flow: 'rows' | 'columns';
  /** Clicking a pane makes it the one the keyboard talks to. */
  onFocusPane(session: SessionId): void;
  settings: TerminalConfig;
  fontStack: string;
  palette: TerminalPalette;
  /** Publishes the handle so the window can focus and search this terminal. */
  onHandle(session: SessionId, handle: TerminalHandle | null): void;
  onInput(session: SessionId, data: string): void;
  onResize(session: SessionId, size: TerminalSize): void;
  /** Decoded characters received, for the throughput readout. */
  onChunk(session: SessionId, chars: number): void;
  /** The state this character was in when the terminal attached to it. */
  onSnapshot(session: SessionId, snapshot: AttachSnapshot): void;
  onSearchResult(result: { index: number; count: number } | undefined): void;
}

/**
 * One character's terminal, and the whole of its stream lifecycle.
 *
 * There is one of these per loaded character and they all stay mounted. A tab
 * switch shows a different one; it never disposes or recreates a terminal,
 * because an xterm holds the scrollback, the scroll position and the parser
 * state that make a session feel continuous. Rebuilding that on every switch
 * would make moving between characters cost a full backscroll replay, which is
 * exactly the thing a multiboxer does constantly.
 *
 * **The hidden ones are laid out, not removed.** Every terminal occupies the
 * same box and inactive ones are `visibility: hidden`, so each still measures
 * the geometry it would have if shown. That is what keeps NAWS honest: a
 * terminal with no box measures zero, and reporting 0x0 — or a fallback 80x24 —
 * re-wraps the scrollback of a character that is standing still. It also makes
 * hidden terminals unfocusable, which the browser gives us for free and which
 * the focus policy wants anyway.
 *
 * Owning the attach here rather than in the window is what keeps the
 * buffer-until-attached rule local: a session keeps talking during the round
 * trip, and those chunks have to be held back until the retained output has
 * been written or the catch-up lands on top of newer output.
 */
function SessionTerminal({
  session,
  shown,
  focused,
  pane,
  flow,
  onFocusPane,
  settings,
  fontStack,
  palette,
  onHandle,
  onInput,
  onResize,
  onChunk,
  onSnapshot,
  onSearchResult,
  index,
  onInspect,
  onSelectPlayer,
  onSelectGang,
  onChooseRoom
}: SessionTerminalProps) {
  const api = window.mudengine;
  const handleRef = useRef<TerminalHandle | null>(null);
  const pending = useRef<StreamChunk[]>([]);
  const attached = useRef(false);
  const [ready, setReady] = useState(false);

  const handleReady = useCallback(
    (handle: TerminalHandle) => {
      handleRef.current = handle;
      onHandle(session, handle);
      setReady(true);
    },
    [onHandle, session]
  );

  useEffect(() => {
    return () => {
      handleRef.current = null;
      onHandle(session, null);
    };
  }, [onHandle, session]);

  /** This character's output, and nobody else's. */
  useEffect(() => {
    return api.onData(({ session: from, payload }) => {
      if (from !== session) return;
      onChunk(session, payload.text.length);
      const handle = handleRef.current;
      if (handle && attached.current) handle.write(payload);
      else pending.current.push(payload);
    });
  }, [api, session, onChunk]);

  /**
   * Attach on mount, detach on unmount.
   *
   * Attaching says "this window is showing that session" and resolves with
   * everything needed to draw it from cold. Main owns the retained output
   * precisely so this is lossless — see docs/profiles.md §6.
   */
  useEffect(() => {
    const handle = handleRef.current;
    if (!ready || !handle) return;

    let live = true;
    attached.current = false;

    void api
      .attach(session)
      .then((snapshot) => {
        if (!live) return;
        if (snapshot.backscroll.length > 0) {
          handle.write({ seq: -1, at: Date.now(), text: snapshot.backscroll });
        }
        attached.current = true;
        for (const chunk of pending.current) handle.write(chunk);
        pending.current = [];
        onSnapshot(session, snapshot);
      })
      .catch((error: unknown) => {
        /*
         * A failed attach must not leave this terminal buffering for ever:
         * chunks keep arriving through `onData` regardless, so the retained
         * backscroll is lost but the live stream is still worth showing.
         * Said in the stream itself, because a terminal silently missing its
         * history is indistinguishable from one that has none.
         */
        if (!live) return;
        console.error(`[terminal] attach failed for session ${session}:`, error);
        attached.current = true;
        for (const chunk of pending.current) handle.write(chunk);
        pending.current = [];
        handle.notice(t('terminal.backscrollRestoreFailed', { message: errorMessage(error) }));
      });

    return () => {
      live = false;
      attached.current = false;
      void api.detach(session);
    };
  }, [api, session, ready, onSnapshot]);

  const input = useCallback((data: string) => onInput(session, data), [onInput, session]);
  const resize = useCallback((size: TerminalSize) => onResize(session, size), [onResize, session]);

  /*
   * Placed by grid coordinate rather than by document order, which is what lets
   * every character keep a mounted terminal while only some have a pane. Grid
   * items given the same coordinates overlap, so a character with no pane parks
   * in the focused one, hidden — laid out, and therefore still measurable.
   */
  const place =
    flow === 'columns'
      ? { gridColumn: pane + 1, gridRow: 1 }
      : { gridRow: pane + 1, gridColumn: 1 };

  // Addressed at this character, whose console was clicked — not the shown one.
  const selectPlayer = useCallback(
    (name: string, at: PopoverAnchor) => onSelectPlayer?.(session, name, at),
    [onSelectPlayer, session]
  );
  // The same, for a gang: its membership is read out of *this* character's
  // roster and registry, which is not the shown character's.
  const selectGang = useCallback(
    (name: string, at: PopoverAnchor) => onSelectGang?.(session, name, at),
    [onSelectGang, session]
  );

  return (
    <div
      className="terminal-layer"
      data-focused={focused ? 'true' : 'false'}
      data-shown={shown ? 'true' : 'false'}
      onMouseDown={() => onFocusPane(session)}
      style={place}
    >
      <TerminalView
        fontStack={fontStack}
        index={index}
        onInput={input}
        onInspect={onInspect}
        onSelectPlayer={selectPlayer}
        onSelectGang={selectGang}
        onChooseRoom={onChooseRoom}
        onReady={handleReady}
        onResize={resize}
        // Search belongs to the terminal being read, so only the focused pane
        // reports counts into the search bar. One shared no-op for the rest:
        // an arrow written here was a fresh function per render, which made
        // every unfocused terminal re-render on every commit of the window.
        onSearchResult={focused ? onSearchResult : NO_RESULT}
        palette={palette}
        // Every pane reports its own geometry; a character with no pane keeps
        // the last one it was really shown at.
        reportSize={shown}
        settings={settings}
      />
    </div>
  );
}

export default memo(SessionTerminal);
