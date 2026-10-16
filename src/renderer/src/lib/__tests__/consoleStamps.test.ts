import { describe, expect, it } from 'vitest';

import { timeInset } from '../consoleStamps';
import { GLYPH_CELLS } from '@shared/template';

// Todo 156: a blank cell between the time and the gear, and a plain row's time at the edge.
describe('where a status line time sits', () => {
  it('keeps a plain row at the right edge', () => {
    expect(timeInset(false)).toBe(0);
  });

  it('leaves a blank cell between the time and the gear', () => {
    expect(timeInset(true)).toBe(GLYPH_CELLS + 1);
  });
});
