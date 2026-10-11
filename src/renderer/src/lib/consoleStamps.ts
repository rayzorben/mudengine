/**
 * Each status line's time at the console's right edge (todos 25, 27). Main
 * puts `STAMP_OSC` (`@shared/stamps`) in the painted text where a status line
 * row gets its time, so a live row and a replayed page carry the same time.
 * A later time on the same row (a command's echo at the prompt) moves it; a
 * clear on it (text written over the erased prompt row) takes it off.
 * A row whose text reaches the time's cells hides it, so the game's text stays
 * readable. Nothing is registered while the times are off: a marker costs
 * xterm a listener per trimmed line and a decoration a visit per frame.
 * `mudengine-session` › *A block's time rides in the painted text*.
 */
import type { IMarker, Terminal } from '@xterm/xterm';

import { STAMP_OSC, stampAt } from '@shared/stamps';
import { clockOf } from '@shared/values';

/** Cells the time takes, `HH:MM:SS`, and the blank one kept before it. */
const STAMP_CELLS = 8;
const STAMP_GAP = 1;

interface Stamp {
  marker: IMarker;
  at: number;
}

export interface ConsoleStamps {
  /** Draw the times of what is parsed from now on, or let go of every one drawn. */
  show(on: boolean): void;
}

export function drawStamps(term: Terminal): ConsoleStamps {
  let shown = false;
  let last: Stamp | null = null;
  const drawn = new Set<IMarker>();

  term.parser.registerOscHandler(STAMP_OSC, (payload) => {
    const at = shown ? stampAt(payload) : null;
    if (at === null) return true;
    const buffer = term.buffer.active;
    const row = buffer.baseY + buffer.cursorY;
    const onRow = last !== null && !last.marker.isDisposed && last.marker.line === row;
    if (at === 'clear') {
      if (onRow) last?.marker.dispose();
      return true;
    }
    if (onRow && last !== null) {
      last.at = at;
      return true;
    }
    const marker = term.registerMarker(0);
    const stamp: Stamp = { marker, at };
    last = stamp;
    drawn.add(marker);
    marker.onDispose(() => drawn.delete(marker));
    term
      .registerDecoration({ marker, anchor: 'right', x: 0, width: STAMP_CELLS })
      ?.onRender((element) => {
        element.classList.add('terminal-stamp');
        element.textContent = clockOf(stamp.at);
        const text = term.buffer.active.getLine(marker.line)?.translateToString(true) ?? '';
        element.toggleAttribute('data-covered', text.length > term.cols - STAMP_CELLS - STAMP_GAP);
      });
    return true;
  });

  return {
    show(on) {
      shown = on;
      if (on) return;
      for (const marker of [...drawn]) marker.dispose();
      last = null;
    }
  };
}
