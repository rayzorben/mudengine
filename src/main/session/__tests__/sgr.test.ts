import { describe, expect, it } from 'vitest';

import { colourBefore } from '../sgr';

const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

describe('the colour in effect at a cut', () => {
  it('is the default with no colour before it', () => {
    expect(colourBefore('plain\nlines\n', 12)).toBe('');
    expect(colourBefore('', 0)).toBe('');
  });

  it('is the default after a bare reset', () => {
    const text = `${RED}red${RESET}\nnext`;
    expect(colourBefore(text, text.indexOf('next'))).toBe('');
    expect(colourBefore(`${RED}x\x1b[m\nnext`, 9)).toBe('');
  });

  it('is every sequence since the last reset, in order', () => {
    const text = `${RESET}${BOLD}bold ${RED}and red\nstill red`;
    const cut = text.indexOf('still');
    expect(colourBefore(text, cut)).toBe(`${RESET}${BOLD}${RED}`);
  });

  it('keeps a reset that also sets a colour', () => {
    const text = `${RED}x\x1b[0;32mgreen\nnext`;
    expect(colourBefore(text, text.indexOf('next'))).toBe('\x1b[0;32m');
  });

  it('reads nothing after the cut', () => {
    const text = `${RED}red\n${RESET}after`;
    expect(colourBefore(text, text.indexOf(RESET))).toBe(RED);
  });

  it('with no reset in reach, carries what it can see', () => {
    const text = `${RED}${'x'.repeat(50)}${BOLD}\nnext`;
    expect(colourBefore(text, text.indexOf('next'), 20)).toBe(BOLD);
  });

  it('counts a reset anywhere among a sequence’s parameters', () => {
    const text = `${RED}x\x1b[1;0;31mfresh red\nnext`;
    expect(colourBefore(text, text.indexOf('next'))).toBe('\x1b[1;0;31m');
  });

  it('does not read the 0 inside a 256-colour code as a reset', () => {
    const text = `${BOLD}x\x1b[38;5;0mblack on bold\nnext`;
    expect(colourBefore(text, text.indexOf('next'))).toBe(`${BOLD}\x1b[38;5;0m`);
  });
});
