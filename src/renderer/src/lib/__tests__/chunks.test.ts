import { describe, expect, it } from 'vitest';

import { printedWidth, splitMarks } from '../chunks';

const mark = { icon: 'bank' as const, label: 'Bank of Godfrey' };

describe('splitting a chunk at its marks', () => {
  it('is one segment when nothing is marked', () => {
    expect(splitMarks({ seq: 1, at: 0, text: 'a\r\nb\r\n' })).toEqual([{ text: 'a\r\nb\r\n' }]);
  });

  it('cuts a marked line out whole, terminator included', () => {
    const text = 'Town\r\n\x1b[1mBank\x1b[0m\r\nExits: n\r\n';
    expect(splitMarks({ seq: 1, at: 0, text, marks: [{ offset: 6, mark }] })).toEqual([
      { text: 'Town\r\n' },
      { text: '\x1b[1mBank\x1b[0m\r\n', mark },
      { text: 'Exits: n\r\n' }
    ]);
  });

  it('runs a marked line to the end of the chunk when nothing ends it', () => {
    expect(splitMarks({ seq: 1, at: 0, text: 'Bank', marks: [{ offset: 0, mark }] })).toEqual([
      { text: 'Bank', mark }
    ]);
  });

  it('ignores an offset that is out of order or out of range', () => {
    expect(splitMarks({ seq: 1, at: 0, text: 'ab\r\n', marks: [{ offset: 9, mark }] })).toEqual([
      { text: 'ab\r\n' }
    ]);
  });
});

describe('how wide a printed line is', () => {
  it('counts glyphs, not escapes or the terminator', () => {
    expect(printedWidth('\x1b[1;33mBank of Godfrey\x1b[0m\r\n')).toBe(15);
    expect(printedWidth('plain\r')).toBe(5);
  });
});
