import { describe, expect, it } from 'vitest';

import { applyQuirks, splitTrailingEscape, DEFAULT_QUIRKS } from '../stream-quirks';

describe('applyQuirks', () => {
  it('pre-scrolls and homes the cursor around a clear-screen', () => {
    const out = applyQuirks('before\x1b[2Jafter', DEFAULT_QUIRKS);
    expect(out).toContain('\n\x1b[2J\x1b[H');
    expect(out.startsWith('before\n')).toBe(true);
    expect(out.endsWith('after')).toBe(true);
  });

  it('is a no-op when the quirk is disabled', () => {
    const input = 'a\x1b[2Jb';
    expect(applyQuirks(input, { ...DEFAULT_QUIRKS, preScrollOnClear: false })).toBe(input);
  });
});

describe('splitTrailingEscape', () => {
  it('emits text with no escape untouched', () => {
    expect(splitTrailingEscape('hello')).toEqual({ emit: 'hello', hold: '' });
  });

  it('holds back an incomplete CSI sequence', () => {
    expect(splitTrailingEscape('red \x1b[1;3')).toEqual({ emit: 'red ', hold: '\x1b[1;3' });
  });

  it('emits a complete CSI sequence', () => {
    const input = 'red \x1b[1;31m';
    expect(splitTrailingEscape(input)).toEqual({ emit: input, hold: '' });
  });

  it('holds back a lone trailing ESC', () => {
    expect(splitTrailingEscape('x\x1b')).toEqual({ emit: 'x', hold: '\x1b' });
  });

  it('gives up on an implausibly long fragment rather than stalling', () => {
    const input = `x\x1b[${'0'.repeat(64)}`;
    expect(splitTrailingEscape(input).hold).toBe('');
  });
});
