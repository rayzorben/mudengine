/**
 * The glyph and buttons beside a marked line, hung off `LINE_OSC`
 * (`@shared/stamps`): the id main writes at the start of the line registers a
 * marker as it is parsed, and the line's mark, from its chunk, a page or a
 * later push, is drawn on it and drawn again when it changes (todo 143). The
 * glyph goes after the line's text and the buttons after the glyph, so the
 * console keeps the server's cells on every path. A row leaves the map when
 * xterm disposes its marker as the line scrolls out. `mudengine-session` ›
 * *A marked line's id rides in the painted text*.
 */
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';

import { LINE_OSC, lineIdAt } from '@shared/stamps';
import { GLYPH_CELLS } from '@shared/template';
import type {
  InlineGlyph,
  LineId,
  MarkChange,
  MarkIcon,
  TerminalAction,
  TerminalActionName,
  TerminalMark
} from '@shared/types';
import type { RoomReference } from '@shared/world';

/**
 * What a button beside a line can do: type, or ask main to act. Two callbacks,
 * because a command composed when the line was drawn and typed when it was
 * pressed is how the old `Deposit All` sent a stale figure.
 */
export interface MarkPress {
  send(command: string): void;
  act(action: TerminalActionName): void;
}

/** What draws a mark: each glyph as markup (`components/marks.ts`), and what a press does. */
export interface MarkDress extends MarkPress {
  glyph(icon: MarkIcon): string;
}

export interface ConsoleMarks {
  /** A chunk's marks, drawn once it is parsed. */
  apply(changes: readonly MarkChange[]): void;
  /** Lines marked anew by a push, drawn once what came before is parsed, and kept for a page. */
  push(changes: readonly MarkChange[]): void;
  /**
   * A page's marks, then every push since: a push can arrive while the page
   * is on its way, after main read the page's marks, and the page's write
   * resets the rows it was drawn on.
   */
  page(changes: readonly MarkChange[]): void;
  /**
   * The console was reset: every row is gone. xterm's `reset` makes new
   * buffers and leaves the old markers undisposed, still holding their line
   * numbers, so a later push for an old line drew its glyph on whatever row
   * now has that number.
   */
  cleared(): void;
  /** The room the name line on this buffer row was printed for; null when the row has none placed. */
  roomOn(bufferRow: number): RoomReference | null;
}

interface Row {
  marker: IMarker;
  drawn: IDecoration[];
  room: RoomReference | null;
}

export function drawMarks(term: Terminal, dress: MarkDress): ConsoleMarks {
  const rows = new Map<LineId, Row>();
  /** The last push for each line, oldest first, bounded by the lines the console holds. */
  const pushed = new Map<LineId, TerminalMark | null>();

  term.parser.registerOscHandler(LINE_OSC, (payload) => {
    const id = lineIdAt(payload);
    if (id === null) return true;
    // The same line written again (a refill) is a new row; the old one is gone with the reset.
    rows.get(id)?.marker.dispose();
    const marker = term.registerMarker(0);
    const row: Row = { marker, drawn: [], room: null };
    rows.set(id, row);
    marker.onDispose(() => {
      if (rows.get(id) === row) rows.delete(id);
    });
    return true;
  });

  const apply = (changes: Iterable<MarkChange>): void => {
    for (const { id, mark } of changes) {
      const row = rows.get(id);
      // A line this console no longer holds, or never wrote.
      if (row === undefined || row.marker.isDisposed) continue;
      for (const decoration of row.drawn) decoration.dispose();
      row.drawn = mark === null ? [] : decorate(term, row.marker, mark, dress);
      row.room = mark?.room ?? null;
    }
  };

  return {
    apply,
    push(changes) {
      for (const { id, mark } of changes) {
        pushed.delete(id);
        pushed.set(id, mark);
      }
      const keep = Math.max(term.rows, term.options.scrollback ?? 0);
      for (const id of pushed.keys()) {
        if (pushed.size <= keep) break;
        pushed.delete(id);
      }
      apply(changes);
    },
    page(changes) {
      apply(changes);
      apply([...pushed].map(([id, mark]) => ({ id, mark })));
    },
    cleared() {
      for (const row of [...rows.values()]) row.marker.dispose();
      rows.clear();
    },
    roomOn(bufferRow) {
      // Asked on a click, over the rows the console holds: bounded by the scrollback.
      for (const row of rows.values()) {
        if (row.marker.line === bufferRow) return row.room;
      }
      return null;
    }
  };
}

/** The glyph and buttons for `mark`, placed after what the row paints. */
function decorate(
  term: Terminal,
  marker: IMarker,
  mark: TerminalMark,
  dress: MarkDress
): IDecoration[] {
  // What the row paints, measured from the buffer: a column is a cell, and an escape sequence paints none.
  const printed = term.buffer.active.getLine(marker.line)?.translateToString(true).length ?? 0;
  const drawn: IDecoration[] = [];
  const icon = mark.icon;
  let from = printed + 1;
  if (icon !== undefined) {
    const glyph = term.registerDecoration({ marker, x: from, width: GLYPH_CELLS });
    glyph?.onRender((element) => {
      if (element.dataset['mark'] === icon) return;
      element.dataset['mark'] = icon;
      // Added, never assigned: xterm's own class carries the positioning.
      element.classList.add('terminal-mark');
      element.title = mark.label;
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', mark.label);
      element.innerHTML = dress.glyph(icon);
    });
    if (glyph) drawn.push(glyph);
    from += GLYPH_CELLS + 1;
  }
  for (const glyph of mark.inline ?? []) {
    const decoration = inlineGlyph(term, marker, glyph, dress);
    if (decoration) drawn.push(decoration);
  }
  if (mark.actions?.length) {
    const buttons = actionButtons(term, marker, mark.actions, from, dress);
    if (buttons) drawn.push(buttons);
  }
  return drawn;
}

/**
 * A glyph inside a line the client drew: over the two blank cells the drawing
 * left for it. With commands it is a button, the equip gate beside a carried
 * item, sent down the path a keystroke takes; without, a statement with its
 * label for a tooltip.
 */
function inlineGlyph(
  term: Terminal,
  marker: IMarker,
  glyph: InlineGlyph,
  dress: MarkDress
): IDecoration | undefined {
  const decoration = term.registerDecoration({ marker, x: glyph.x, width: GLYPH_CELLS });
  decoration?.onRender((element) => {
    if (element.dataset['mark'] === glyph.icon) return;
    element.dataset['mark'] = glyph.icon;
    element.classList.add('terminal-mark', 'terminal-glyph');
    element.title = glyph.label;
    element.setAttribute('aria-label', glyph.label);
    element.innerHTML = dress.glyph(glyph.icon);
    const commands = glyph.commands;
    if (commands === undefined || commands.length === 0) {
      element.setAttribute('role', 'img');
      return;
    }
    element.dataset['action'] = 'true';
    element.setAttribute('role', 'button');
    // Clickable and never a tab stop: focus lives in the terminal, and the pack card has the same control.
    element.tabIndex = -1;
    element.addEventListener('mousedown', (event) => event.preventDefault());
    element.addEventListener('click', () => {
      for (const command of commands) dress.send(command);
    });
  });
  return decoration;
}

/**
 * The buttons after a marked line's text and glyph, on the decoration layer
 * so nothing the server laid out moves. The width is stated in cells and
 * xterm places it from its own measured cell size, so no pixel constant. A
 * press sends the realm's own commands down the path a keystroke takes, or
 * names an action for main to run.
 */
function actionButtons(
  term: Terminal,
  marker: IMarker,
  actions: readonly TerminalAction[],
  from: number,
  press: MarkPress
): IDecoration | undefined {
  const width = Math.max(1, term.cols - from);
  const decoration = term.registerDecoration({ marker, x: from, width });
  decoration?.onRender((element) => {
    if (element.dataset['actions'] === 'true') return;
    element.dataset['actions'] = 'true';
    element.classList.add('terminal-actions');
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'terminal-action';
      button.textContent = action.label;
      button.title = action.title;
      // Clicked but never typed into: the caret stays where it was.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        if (action.act !== undefined) press.act(action.act);
        else for (const command of action.commands) press.send(command);
      });
      element.append(button);
    }
  });
  return decoration;
}
