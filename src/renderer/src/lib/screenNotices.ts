/**
 * Where a notice goes while the server is drawing a screen with the cursor.
 *
 * A notice is written at the cursor. In the scrolling game that is the end of
 * the text, but Paradigm's stat screen (`train stats`) draws a whole menu with
 * cursor moves and leaves the cursor on the field being edited, so a notice
 * there was painted across the menu (todo 02, 2026-10-03). A drawn screen is
 * any drawn row below the cursor; while one is up, notices go in the rows under
 * its lowest drawn row, the cursor saved and put back around them so the
 * server's next byte lands where it left it. Every action here runs at the
 * writer's `settled` moment, when the buffer answers for what is on screen.
 */

import type { Terminal } from '@xterm/xterm';

import { SGR_RESET } from '@shared/template';
import { noticeRows, noticeSequence } from './console';

/** The part of a terminal this reads and writes: the screen as parsed. */
export interface NoticeSurface {
  readonly rows: number;
  readonly columns: number;
  /** Cursor row and column on the screen, from 0. */
  readonly cursorY: number;
  readonly cursorX: number;
  /** Buffer lines above the screen's top row. */
  readonly baseY: number;
  /** Whether screen row `y` has any text on it. */
  drawn(y: number): boolean;
  write(bytes: string): void;
}

export interface ScreenNotices {
  /** Say that a notice is on its way through the writer. */
  expect(): void;
  /** Write a notice now: at the cursor, or under a drawn screen. */
  notice(message: string): void;
  /** Whether server bytes must be bracketed by `lift` and `settle`. */
  readonly active: boolean;
  /** Before server bytes: take the notices off a drawn screen. */
  lift(): void;
  /** After server bytes: put them back, or into the text once the screen is gone. */
  settle(): void;
  /** The terminal was reset, and everything on it is gone. */
  forget(): void;
}

const SAVE = '\x1b7';
const RESTORE = '\x1b8';
const ERASE_ROW = '\x1b[2K';
const moveTo = (y: number): string => `\x1b[${y + 1};1H`;

/** A terminal's active screen as parsed, read when asked; writes go straight to it. */
export function terminalSurface(term: Terminal): NoticeSurface {
  const buffer = term.buffer.active;
  return {
    rows: term.rows,
    columns: term.cols,
    cursorY: buffer.cursorY,
    cursorX: buffer.cursorX,
    baseY: buffer.baseY,
    drawn: (y) =>
      (buffer
        .getLine(buffer.baseY + y)
        ?.translateToString(true)
        .trim() ?? '') !== '',
    write: (bytes) => term.write(bytes)
  };
}

/** The lowest drawn row under the cursor, or null when the cursor is below all of it. */
export function drawnBelow(surface: NoticeSurface): number | null {
  for (let y = surface.rows - 1; y > surface.cursorY; y -= 1) {
    if (surface.drawn(y)) return y;
  }
  return null;
}

export function screenNotices(surface: () => NoticeSurface): ScreenNotices {
  /** Raised while a screen was up and not yet in the text. */
  let held: string[] = [];
  /** Buffer lines the held notices are written on now, the first `shown` of them. */
  let placed: number[] = [];
  let shown = 0;
  let coming = 0;

  /** Write the held notices into the text, in order: the screen is gone. */
  const intoText = (screen: NoticeSurface): void => {
    let atLineStart = screen.cursorX === 0;
    for (const message of held) {
      screen.write(noticeSequence(message, atLineStart));
      atLineStart = true;
    }
    held = [];
  };

  /*
   * Each notice is written whole or not at all, in order, and never past the
   * bottom row: a scroll would move the server's menu off the rows it
   * addresses. One that does not fit stays held until the screen ends.
   */
  const place = (screen: NoticeSurface, from: number): void => {
    let y = from;
    let bytes = '';
    for (const message of held.slice(shown)) {
      const rows = noticeRows(message, screen.columns);
      if (y + rows.length > screen.rows) break;
      for (const row of rows) {
        bytes += moveTo(y) + row;
        placed.push(screen.baseY + y);
        y += 1;
      }
      shown += 1;
    }
    // The server's colours are reset first, or a notice wears its highlight.
    if (bytes !== '') screen.write(`${SAVE}${SGR_RESET}${bytes}${RESTORE}`);
  };

  const lift = (): void => {
    shown = 0;
    if (placed.length === 0) return;
    const screen = surface();
    const rows = placed.map((line) => line - screen.baseY).filter((y) => y >= 0 && y < screen.rows);
    placed = [];
    // Reset first here too, or the erase paints the server's background.
    screen.write(`${SAVE}${SGR_RESET}${rows.map((y) => moveTo(y) + ERASE_ROW).join('')}${RESTORE}`);
  };

  /** Lay the held notices out again: the screen is as the server left it, with none on it. */
  const settle = (): void => {
    if (held.length === 0) return;
    const screen = surface();
    const lowest = drawnBelow(screen);
    if (lowest === null) intoText(screen);
    else place(screen, lowest + 1);
  };

  /*
   * A notice joins the ones already on the screen, under the last of them.
   * They are not lifted and laid out again: the erase would not be parsed yet,
   * so the screen read for the layout would still show them.
   */
  const add = (message: string): void => {
    held.push(message);
    const last = placed.at(-1);
    if (last === undefined) {
      settle();
      return;
    }
    const screen = surface();
    if (shown === held.length - 1) place(screen, last - screen.baseY + 1);
  };

  return {
    expect: () => {
      coming += 1;
    },
    notice: (message) => {
      coming = Math.max(0, coming - 1);
      add(message);
    },
    get active() {
      return coming > 0 || held.length > 0;
    },
    lift,
    settle,
    forget: () => {
      held = [];
      placed = [];
      shown = 0;
    }
  };
}
