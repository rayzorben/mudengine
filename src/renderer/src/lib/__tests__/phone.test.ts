import { describe, expect, it } from 'vitest';

import { fraction, keyboardUp, phoneWanted, runsOf } from '../phone';

describe('phoneWanted', () => {
  it('follows the media query without a flag', () => {
    expect(phoneWanted('', true)).toBe(true);
    expect(phoneWanted('', false)).toBe(false);
  });

  it('lets ?phone force it either way', () => {
    expect(phoneWanted('?phone=1', false)).toBe(true);
    expect(phoneWanted('?phone=0', true)).toBe(false);
  });
});

describe('fraction', () => {
  it('is unknown, never 0, while either figure is unknown or the maximum is 0', () => {
    expect(fraction(null, 100)).toBeNull();
    expect(fraction(50, null)).toBeNull();
    expect(fraction(0, 0)).toBeNull();
  });

  it('is the share left, kept between 0 and 1', () => {
    expect(fraction(50, 200)).toBe(0.25);
    expect(fraction(0, 200)).toBe(0);
    expect(fraction(300, 200)).toBe(1);
  });
});

describe('runsOf', () => {
  it('cuts a line at each colour change and keeps the words', () => {
    expect(runsOf('a \x1b[31mred\x1b[0m b')).toEqual([
      { text: 'a ', tone: null, bold: false },
      { text: 'red', tone: 'red', bold: false },
      { text: ' b', tone: null, bold: false }
    ]);
  });

  it('reads bright colours and bold as bold, and a reset as plain', () => {
    expect(runsOf('\x1b[1;33mgold\x1b[0mx')).toEqual([
      { text: 'gold', tone: 'yellow', bold: true },
      { text: 'x', tone: null, bold: false }
    ]);
    expect(runsOf('\x1b[92mhi')).toEqual([{ text: 'hi', tone: 'green', bold: true }]);
  });

  it('drops cursor sequences and gives nothing for an empty line', () => {
    expect(runsOf('\x1b[79D\x1b[Kready')).toEqual([{ text: 'ready', tone: null, bold: false }]);
    expect(runsOf('')).toEqual([]);
  });
});

describe('keyboardUp', () => {
  it('needs a focused field and a clearly shorter window', () => {
    expect(keyboardUp(600, 900, true)).toBe(true);
    expect(keyboardUp(600, 900, false)).toBe(false);
  });

  it('does not take the browser bars for a keyboard', () => {
    expect(keyboardUp(860, 900, true)).toBe(false);
    expect(keyboardUp(900, 900, true)).toBe(false);
  });
});
