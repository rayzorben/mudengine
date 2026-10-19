import { describe, expect, it } from 'vitest';

import { arenaRadiusAt, mapAlphaAt, zoomAt, zoomsIn } from '../gameZoom';

describe('combat zoom', () => {
  it('zooms in only for a fight the map is following', () => {
    expect(zoomsIn(true, true)).toBe(true);
    expect(zoomsIn(true, false)).toBe(false);
    expect(zoomsIn(false, true)).toBe(false);
  });

  it('rests at the arena it had, and grows toward most of the view', () => {
    expect(arenaRadiusAt(720, 500, 110, 0)).toBe(110);
    expect(arenaRadiusAt(720, 500, 110, 1)).toBeCloseTo(190, 0);
    // A view too small to grow in keeps its arena.
    expect(arenaRadiusAt(200, 200, 110, 1)).toBe(110);
  });

  it("comes back to the player's own zoom and a solid map", () => {
    expect(zoomAt(1.2, 0)).toBe(1.2);
    expect(zoomAt(1, 1)).toBeGreaterThan(1.9);
    expect(mapAlphaAt(0)).toBe(1);
    expect(mapAlphaAt(1)).toBeCloseTo(0.32, 5);
  });
});
