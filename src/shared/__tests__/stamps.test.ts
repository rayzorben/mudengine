import { describe, expect, it } from 'vitest';

import { afterStamp, stampAt, stampChunk, stampOf, unstamped } from '../stamps';
import type { TerminalMark } from '../types';

const mark: TerminalMark = { icon: 'shop', label: 'General Store' };

describe('a block carries the time it reached the console', () => {
  it('opens the chunk with its time and moves each mark past it', () => {
    const chunk = stampChunk({
      seq: 1,
      at: 1791418218773,
      text: 'a\r\nShop\r\n',
      marks: [{ offset: 3, mark }]
    });
    const stamp = stampOf(1791418218773);
    expect(chunk.text).toBe(`${stamp}a\r\nShop\r\n`);
    expect(chunk.text.slice(chunk.marks?.[0]?.offset)).toBe('Shop\r\n');
  });

  /* A reply leaves the command's row on the time it went out. */
  it('goes after the line break a reply opens with, unless nothing follows it', () => {
    expect(stampChunk({ seq: 1, at: 7, text: '\r\nTown Square\r\n' }).text).toBe(
      `\r\n${stampOf(7)}Town Square\r\n`
    );
    expect(stampChunk({ seq: 1, at: 7, text: '\r\n' }).text).toBe(`${stampOf(7)}\r\n`);
    expect(afterStamp(`${stampOf(7)}[HP=1]:`)).toBe(stampOf(7).length);
    expect(afterStamp('[HP=1]:')).toBe(0);
  });

  it('is taken out whole for a reader that measures the text', () => {
    expect(unstamped(`${stampOf(5)}\x1b[79D\x1b[K[HP=30]:${stampOf(6)}`)).toBe(
      '\x1b[79D\x1b[K[HP=30]:'
    );
    expect(unstamped('\x1b]0;title\x07')).toBe('\x1b]0;title\x07');
  });

  it('reads back the time, and nothing else', () => {
    expect(stampAt('1791418218773')).toBe(1791418218773);
    expect(stampAt('')).toBeNull();
    expect(stampAt('12;x')).toBeNull();
  });
});
