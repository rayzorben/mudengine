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

describe('the tutorial setting', () => {
  it('is on unless a file says otherwise', () => {
    expect(normalizeGameView({}).tutorial).toBe(true);
    expect(normalizeGameView({ tutorial: 'no' }).tutorial).toBe(true);
    expect(normalizeGameView({ tutorial: false }).tutorial).toBe(false);
  });
});

describe('the room art opacity setting', () => {
  it('is 85% unless a file says otherwise', () => {
    expect(DEFAULT_GAME_VIEW.roomArtOpacity).toBe(0.85);
    expect(normalizeGameView({}).roomArtOpacity).toBe(0.85);
    expect(normalizeGameView({ roomArtOpacity: 'dim' }).roomArtOpacity).toBe(0.85);
  });

  it('reads a fraction or a percent, and 0 hides the picture', () => {
    expect(normalizeGameView({ roomArtOpacity: 0.4 }).roomArtOpacity).toBe(0.4);
    expect(normalizeGameView({ roomArtOpacity: 60 }).roomArtOpacity).toBe(0.6);
    expect(normalizeGameView({ roomArtOpacity: 0 }).roomArtOpacity).toBe(0);
    expect(normalizeGameView({ roomArtOpacity: 150 }).roomArtOpacity).toBe(1);
  });
});
