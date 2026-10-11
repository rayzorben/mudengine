import { describe, expect, it } from 'vitest';

import { takeBackAtEnter } from '../takeBack';

// A line typed in the terminal that the client reads itself (todo 83).
describe('a line taken back at Enter', () => {
  it('erases what the server holds, one backspace a character', () => {
    expect(takeBackAtEnter('get all', '\r', {})).toEqual({
      erase: '\b'.repeat(7),
      line: 'get all'
    });
    expect(takeBackAtEnter(' a {mob}', '\r\n', {})).toEqual({
      erase: '\b'.repeat(8),
      line: 'a {mob}'
    });
  });

  it('leaves any other line, and any chunk but a bare Enter, as typed', () => {
    // Positive control: the first case above is the same line at Enter.
    expect(takeBackAtEnter('get all', 'x', {})).toBeNull();
    expect(takeBackAtEnter('get all', 'get all\r', {})).toBeNull();
    expect(takeBackAtEnter('get torch', '\r', {})).toBeNull();
    expect(takeBackAtEnter('', '\r', {})).toBeNull();
  });

  it('takes back a line that opens on an alias (todo 74)', () => {
    const aliases = { kk: 'pu kobold' };
    expect(takeBackAtEnter('kk thief', '\r', aliases)).toEqual({
      erase: '\b'.repeat(8),
      line: 'kk thief'
    });
    // Positive control: with no alias the same line goes as typed.
    expect(takeBackAtEnter('kk thief', '\r', {})).toBeNull();
  });
});
