import { describe, expect, it } from 'vitest';

import { arenaRadiusAt, mapAlphaAt, zoomAt, zoomsIn } from '../gameZoom';

describe('combat zoom', () => {
  it('zooms in only when it is on, for a fight the map is following', () => {
    expect(zoomsIn(0.5, true, true)).toBe(true);
    expect(zoomsIn(0, true, true)).toBe(false);
    expect(zoomsIn(0.5, true, false)).toBe(false);
    expect(zoomsIn(0.5, false, true)).toBe(false);
  });

  it('grows the arena by the share set, whatever the size of the window', () => {
    expect(arenaRadiusAt(124, 0.5, 0)).toBe(124);
    expect(arenaRadiusAt(124, 0.5, 1)).toBe(186);
    expect(arenaRadiusAt(124, 0.1, 1)).toBeCloseTo(136.4, 5);
  });

  it("brings the map nearer in step, and back to the player's own zoom", () => {
    expect(zoomAt(1.2, 0.5, 0)).toBe(1.2);
    expect(zoomAt(1, 0.5, 1)).toBe(1.5);
    expect(mapAlphaAt(0.9, 0)).toBe(1);
    expect(mapAlphaAt(0.9, 1)).toBeCloseTo(0.4, 5);
    expect(mapAlphaAt(0, 1)).toBe(1);
  });
});
