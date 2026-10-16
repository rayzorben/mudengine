import { describe, expect, it } from 'vitest';

import { printedWidth, sliceLines } from '../chunks';

describe('how wide a printed line is', () => {
  it('counts glyphs, not escapes or the terminator', () => {
    expect(printedWidth('\x1b[1;33mBank of Godfrey\x1b[0m\r\n')).toBe(15);
    expect(printedWidth('plain\r')).toBe(5);
  });
});

/*
 * A restored backscroll handed to the terminal a slice at a time (todo 02):
 * xterm yields between writes and never inside one.
 */
describe('slicing a restored backscroll', () => {
  it('cuts on line ends, loses nothing, and keeps each piece at least the size', () => {
    const text = Array.from({ length: 50 }, (_, n) => `line ${n}\r\n`).join('');
    const pieces = sliceLines(text, 40);
    expect(pieces.join('')).toBe(text);
    expect(pieces.length).toBeGreaterThan(5);
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.endsWith('\n')).toBe(true);
      expect(piece.length).toBeGreaterThanOrEqual(40);
    }
  });

  it('keeps a line longer than the size whole, and a tail with no line end', () => {
    const long = 'x'.repeat(100);
    expect(sliceLines(`${long}\nab`, 10)).toEqual([`${long}\n`, 'ab']);
    expect(sliceLines('', 10)).toEqual([]);
    expect(sliceLines('short', 10)).toEqual(['short']);
  });
});
