import { describe, expect, it } from 'vitest';

import { caughtInTerminal, takeBackAtEnter } from '../takeBack';

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

describe('a line typed in the terminal', () => {
  it('is taken back when main runs it, or when its mark has to come off', () => {
    expect(caughtInTerminal('get all', {})).toBe(true);
    expect(caughtInTerminal('a {mob}', {})).toBe(true);
    expect(caughtInTerminal('\\get all', {})).toBe(true);
  });

  it('is taken back when it opens on an alias, marked or not (todo 74)', () => {
    const aliases = { kk: 'pu kobold' };
    expect(caughtInTerminal('kk', aliases)).toBe(true);
    expect(caughtInTerminal('kk thief', aliases)).toBe(true);
    expect(caughtInTerminal('\\kk', aliases)).toBe(true);
    // Positive control above: without the alias the same word goes as typed.
    expect(caughtInTerminal('kk', {})).toBe(false);
    expect(caughtInTerminal('gos kk', aliases)).toBe(false);
  });

  it('is taken back as the alias command, marked or not (todo 134)', () => {
    expect(caughtInTerminal('alias', {})).toBe(true);
    expect(caughtInTerminal('alias doit ne;sw', {})).toBe(true);
    expect(caughtInTerminal('\\alias', {})).toBe(true);
    expect(caughtInTerminal('{goto 1/297}', {})).toBe(true);
    // Positive control: speech that names it is not.
    expect(caughtInTerminal('gos alias', {})).toBe(false);
  });

  it('goes as typed otherwise, a ; line included', () => {
    // Positive control above: the same words alone are caught.
    expect(caughtInTerminal('gos get all', {})).toBe(false);
    expect(caughtInTerminal('sw;get all', {})).toBe(false);
    expect(caughtInTerminal('look', {})).toBe(false);
    expect(caughtInTerminal('', {})).toBe(false);
  });
});
