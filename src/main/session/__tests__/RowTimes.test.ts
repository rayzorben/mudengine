import { describe, expect, it } from 'vitest';

import { RowTimes } from '../RowTimes';
import { PROMPT_REPAINT } from '../../net/stream-quirks';

/* How the feed uses it, row by row through real reads, is in `TerminalFeed.test.ts`. */
const PROMPT = '[HP=34/MA=12]:';

describe('RowTimes', () => {
  it('gives a fresh row its time once and starts over after a line break', () => {
    const rows = new RowTimes();
    expect(rows.before(PROMPT, 'status')).toBe('time');
    expect(rows.before(' (Resting)', 'other')).toBeNull();
    expect(rows.before('\r\n', 'other')).toBeNull();
    expect(rows.before(PROMPT, 'status')).toBe('time');
  });

  it('clears only a timed row the repaint has erased, and only for visible text', () => {
    const rows = new RowTimes();
    rows.before(PROMPT, 'status');
    expect(rows.before(PROMPT_REPAINT, 'other')).toBeNull();
    expect(rows.before('\x1b[0m', 'other')).toBeNull();
    expect(rows.before('Bob gossips: hi\r\n', 'other')).toBe('clear');
    expect(rows.before('A rat\r\n', 'other')).toBeNull();
  });
});

/* The echo of a command a setting made times its row, so the gear its time carries is drawn (todo 119). */
describe('a row about a decision', () => {
  it('is timed wherever it lands, and a line written over it takes the time off', () => {
    const rows = new RowTimes();
    expect(rows.before('get shield', 'echo', true)).toBe('time');
    expect(rows.before(PROMPT_REPAINT, 'other')).toBeNull();
    expect(rows.before('*Combat Engaged*', 'other')).toBe('clear');
  });

  it('is not timed when nothing was decided', () => {
    expect(new RowTimes().before('get shield', 'echo')).toBeNull();
  });
});
