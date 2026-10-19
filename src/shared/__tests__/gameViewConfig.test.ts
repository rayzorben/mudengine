import { describe, expect, it } from 'vitest';

import { DEFAULT_GAME_VIEW, normalizeGameView } from '../gameViewConfig';

describe('the combat zoom setting', () => {
  it('is off unless a file says otherwise', () => {
    expect(DEFAULT_GAME_VIEW.combatZoom).toBe(0);
    expect(normalizeGameView({}).combatZoom).toBe(0);
    expect(normalizeGameView({ combatZoom: 'big' }).combatZoom).toBe(0);
  });

  it('reads a hand-written figure as the nearest step offered', () => {
    expect(normalizeGameView({ combatZoom: 0.33 }).combatZoom).toBe(0.3);
    expect(normalizeGameView({ combatZoom: 2 }).combatZoom).toBe(0.9);
    expect(normalizeGameView({ combatZoom: -1 }).combatZoom).toBe(0);
  });
});
