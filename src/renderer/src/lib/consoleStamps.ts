/**
 * Each status line's time at the console's right edge (todos 25, 27), hung
 * off `STAMP_OSC` (`@shared/stamps`), and the row a decided stamp names gets
 * its gear from `consoleGear` (todo 119): main writes it where a status line row gets
 * its time, naming the decision on a decided command's echo, and a decided
 * notice writes it on its first row. A later stamp on the row replaces it; a
 * clear (text over the erased prompt row) takes both off. The gear takes the
 * rightmost two cells, the time sits left of it, and text reaching either
 * hides it. Nothing is registered for an undecided row while the times are
 * off: a marker costs xterm a listener per trimmed line and a decoration a
 * visit per frame. `mudengine-session` › *A status line's time rides in the painted text*.
 */
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';

import { STAMP_OSC, stampAt } from '@shared/stamps';
import { GLYPH_CELLS } from '@shared/template';
import { clockOf } from '@shared/values';
import { gearOn, type GearDress } from './consoleGear';

/** Cells the time takes, `HH:MM:SS`, and the blank one kept before it. */
const STAMP_CELLS = 8;
const STAMP_GAP = 1;

interface Row {
  marker: IMarker;
  time: IDecoration | null;
  gear: IDecoration | null;
}

export interface ConsoleStamps {
  /** Draw the times of what is parsed from now on, or let go of every one drawn. */
  show(on: boolean): void;
}

/** @param gear How a decided row's gear is drawn and what pressing it opens (`consoleGear`). */
export function drawStamps(term: Terminal, gear: GearDress): ConsoleStamps {
  let shown = false;
  let last: Row | null = null;
  const rows = new Set<Row>();

  const drop = (row: Row): void => {
    rows.delete(row);
    if (last === row) last = null;
  };

  const timeOn = (row: Row, at: number, inset: number): IDecoration | null => {
    const time = term.registerDecoration({
      marker: row.marker,
      anchor: 'right',
      x: inset,
      width: STAMP_CELLS
    });
    time?.onRender((element) => {
      element.classList.add('terminal-stamp');
      element.textContent = clockOf(at);
      const text = term.buffer.active.getLine(row.marker.line)?.translateToString(true) ?? '';
      element.toggleAttribute(
        'data-covered',
        text.length > term.cols - inset - STAMP_CELLS - STAMP_GAP
      );
    });
    return time ?? null;
  };

  term.parser.registerOscHandler(STAMP_OSC, (payload) => {
    const stamp = stampAt(payload);
    // A time with the times off and no gear says nothing to draw, and moves nothing.
    if (stamp === null || (stamp !== 'clear' && !shown && stamp.decision === null)) return true;
    const buffer = term.buffer.active;
    const line = buffer.baseY + buffer.cursorY;
    const onRow = last !== null && !last.marker.isDisposed && last.marker.line === line;
    // A later stamp on the row replaces what it said; a clear takes it off.
    if (onRow) last?.marker.dispose();
    if (stamp === 'clear') return true;
    const marker = term.registerMarker(0);
    const row: Row = { marker, time: null, gear: null };
    rows.add(row);
    last = row;
    marker.onDispose(() => drop(row));
    if (stamp.decision !== null) row.gear = gearOn(term, marker, stamp.decision, gear);
    if (shown) row.time = timeOn(row, stamp.at, row.gear === null ? 0 : GLYPH_CELLS);
    return true;
  });

  return {
    show(on) {
      shown = on;
      if (on) return;
      for (const row of [...rows]) {
        row.time?.dispose();
        row.time = null;
        if (row.gear === null) row.marker.dispose();
      }
    }
  };
}
