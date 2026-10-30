import { describe, expect, it } from 'vitest';

import { CursorReport } from '../cursorReport';
import { applyQuirks, DEFAULT_QUIRKS } from '../stream-quirks';

const report = (cols = 80, rows = 24): CursorReport => new CursorReport(() => ({ cols, rows }));

describe('CursorReport', () => {
  it('answers ESC[6n with the row and column the text has reached', () => {
    // The Major BBS's auto-sense, OCI 2026-10-30_18-45-39_soul.
    expect(report().feed('Auto-sensing...\r\n    \x1b[6n')).toEqual([
      { asked: '\x1b[6n', answer: '\x1b[2;5R' }
    ]);
  });

  it('follows the cursor across reads', () => {
    const cursor = report();
    cursor.feed('abc');
    expect(cursor.feed('\x1b[6n')[0]?.answer).toBe('\x1b[1;4R');
  });

  it('reports the screen size to the move-to-the-corner probe', () => {
    expect(report(132, 43).feed('\x1b[999;999H\x1b[6n')[0]?.answer).toBe('\x1b[43;132R');
  });

  it('holds the last column until the next glyph wraps, and scrolls at the bottom', () => {
    const cursor = report(4, 2);
    expect(cursor.feed('abcd\x1b[6n')[0]?.answer).toBe('\x1b[1;4R');
    expect(cursor.feed('e\r\n\n\x1b[6n')[0]?.answer).toBe('\x1b[2;1R');
  });

  it('follows relative moves, backspaces and a saved position', () => {
    expect(report().feed('\x1b[5;10H\x1b[2A\x1b[3D\b\x1b[s\x1b[H\x1b[u\x1b[6n')[0]?.answer).toBe(
      '\x1b[3;6R'
    );
  });

  it('leaves every other query unanswered and says so', () => {
    expect(report().feed('\x1b[c\x1b[5n\x1b[?6n\x1b[!\b')).toEqual([
      { asked: '\x1b[c', answer: null },
      { asked: '\x1b[5n', answer: null },
      { asked: '\x1b[?6n', answer: null },
      { asked: '\x1b[!', answer: null }
    ]);
  });

  it('does not move for colour', () => {
    expect(report().feed('\x1b[1;36mab\x1b[0m\x1b[6n')[0]?.answer).toBe('\x1b[1;3R');
  });

  it('reads a clear screen as the terminal paints it, homed', () => {
    const cursor = report();
    expect(cursor.feed(applyQuirks('abc\r\nde\x1b[2J\x1b[6n', DEFAULT_QUIRKS))[0]?.answer).toBe(
      '\x1b[1;1R'
    );
  });

  it('keeps the report on the screen after it shrinks', () => {
    let size = { cols: 80, rows: 24 };
    const cursor = new CursorReport(() => size);
    cursor.feed('\x1b[20;70H');
    size = { cols: 40, rows: 10 };
    expect(cursor.feed('\x1b[6n')[0]?.answer).toBe('\x1b[10;40R');
  });
});
