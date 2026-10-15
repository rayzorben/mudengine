import { describe, expect, it } from 'vitest';

import { afterStamp, clearOf, lastStamp, stampAt, stampChunk, stampOf, unstamped } from '../stamps';
import type { TerminalMark } from '../types';

const mark: TerminalMark = { icon: 'shop', label: 'General Store' };

describe('a status line carries the time it reached the console', () => {
  it('writes each row time in at its offset and moves each mark past it', () => {
    const chunk = stampChunk({
      seq: 1,
      at: 1791418218773,
      text: 'Shop\r\n[HP=1]:',
      marks: [{ offset: 0, mark }],
      times: [
        { offset: 0, put: 'clear' },
        { offset: 6, put: 'time' }
      ]
    });
    const stamp = stampOf(1791418218773);
    expect(chunk.text).toBe(`${clearOf()}Shop\r\n${stamp}[HP=1]:`);
    expect(chunk.text.slice(chunk.marks?.[0]?.offset)).toBe('Shop\r\n' + stamp + '[HP=1]:');
    expect('times' in chunk).toBe(false);
  });

  it('leaves a chunk that times no row as it is', () => {
    expect(stampChunk({ seq: 1, at: 7, text: 'Town Square\r\n' }).text).toBe('Town Square\r\n');
    expect(afterStamp(`${stampOf(7)}[HP=1]:`)).toBe(stampOf(7).length);
    expect(afterStamp('[HP=1]:')).toBe(0);
  });

  it('is taken out whole for a reader that measures the text', () => {
    expect(unstamped(`${stampOf(5)}\x1b[79D\x1b[K[HP=30]:${stampOf(6)}`)).toBe(
      '\x1b[79D\x1b[K[HP=30]:'
    );
    expect(unstamped('\x1b]0;title\x07')).toBe('\x1b]0;title\x07');
    expect(unstamped(`a${clearOf()}b`)).toBe('ab');
    expect(lastStamp(`${stampOf(5)}x${clearOf()}y`)).toBe(clearOf());
    expect(lastStamp('x')).toBe('');
  });

  it('reads back the time, and nothing else', () => {
    expect(stampAt('1791418218773')).toEqual({ at: 1791418218773, decision: null });
    expect(stampAt('-')).toBe('clear');
    expect(stampAt('')).toBeNull();
    expect(stampAt('12;x')).toBeNull();
  });
});

describe('a row about a decision names it after the time (todo 119)', () => {
  it('writes the kind into the stamp, reads it back, and takes it out with the time', () => {
    const chunk = stampChunk({
      seq: 1,
      at: 9,
      text: '[HP=1]:wear shield',
      marks: [{ offset: 7, mark }],
      times: [{ offset: 0, put: 'time', decision: 'found-gear-wear' }]
    });
    expect(chunk.text).toBe(`${stampOf(9, 'found-gear-wear')}[HP=1]:wear shield`);
    expect(chunk.marks?.[0]?.offset).toBe(stampOf(9, 'found-gear-wear').length + 7);
    expect(stampAt('9;found-gear-wear')).toEqual({ at: 9, decision: 'found-gear-wear' });
    expect(unstamped(chunk.text)).toBe('[HP=1]:wear shield');
    expect(afterStamp(chunk.text)).toBe(stampOf(9, 'found-gear-wear').length);
  });

  it('refuses a kind this build does not know', () => {
    expect(stampAt('9;no-such-thing')).toBeNull();
  });
});
