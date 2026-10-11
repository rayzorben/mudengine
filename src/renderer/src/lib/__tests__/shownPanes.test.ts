import { describe, expect, it } from 'vitest';

import { parseShown } from '../shownPanes';

describe('parseShown', () => {
  it('reads what writeShown writes', () => {
    expect(parseShown(JSON.stringify({ panes: ['festus', 'rayzor'], at: 1 }))).toEqual({
      panes: ['festus', 'rayzor'],
      at: 1
    });
  });

  // The value is on the player's own disk and an older build may have written it.
  it('keeps only what it can use', () => {
    expect(parseShown('null')).toEqual({ panes: [], at: 0 });
    expect(parseShown(JSON.stringify({ panes: ['festus', 3, null], at: 1.5 }))).toEqual({
      panes: ['festus'],
      at: 0
    });
    expect(parseShown(JSON.stringify({ panes: 'festus', at: -2 }))).toEqual({ panes: [], at: 0 });
  });
});
