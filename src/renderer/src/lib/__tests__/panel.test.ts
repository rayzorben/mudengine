import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PANEL,
  PANEL_MIN,
  movedPanel,
  normalizePanel,
  panelStyle,
  resizedPanel
} from '../panel';

/*
 * The settings screen is a panel a reader moves and resizes over the console
 * (todo 04). The arithmetic of a drag is the half that goes wrong and the half
 * a pointer cannot reach in a unit test, so it is pure and checked here.
 */
describe('where a movable panel sits', () => {
  it('falls back to a whole box inside the workspace', () => {
    expect(normalizePanel(null)).toEqual(DEFAULT_PANEL);
    expect(DEFAULT_PANEL.x + DEFAULT_PANEL.w).toBeLessThanOrEqual(1);
    expect(DEFAULT_PANEL.y + DEFAULT_PANEL.h).toBeLessThanOrEqual(1);
  });

  it('keeps a stored box wholly on screen, clamping the size before the place', () => {
    // A box from a larger display, or one an older build wrote: the width is
    // capped first, and the position is then capped against the capped width —
    // the other order leaves a right edge outside with nothing to pull it back.
    expect(normalizePanel({ x: 0.9, y: 0.9, w: 1.4, h: 1.4 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1
    });
    expect(normalizePanel({ x: 0.8, y: 0.1, w: 0.5, h: 0.5 })).toMatchObject({ x: 0.5, w: 0.5 });
  });

  it('refuses a box too small to read a form in, and nonsense in the file', () => {
    expect(normalizePanel({ w: 0.01, h: 0.01 })).toMatchObject(PANEL_MIN);
    expect(normalizePanel({ x: Number.NaN, w: Infinity } as never)).toEqual(DEFAULT_PANEL);
  });

  it('moves by the drag and stops at the edge', () => {
    const from = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    const moved = movedPanel(from, 0.2, 0.1);
    // Fractions, so the arithmetic is floating point and the assertion says so.
    expect(moved.x).toBeCloseTo(0.3);
    expect(moved.y).toBeCloseTo(0.2);
    // Dragged off the left and top: it stops flush, never half outside.
    expect(movedPanel(from, -1, -1)).toMatchObject({ x: 0, y: 0 });
    expect(movedPanel(from, 1, 1)).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it('resizes the corner alone, so the place never moves under the hand', () => {
    const from = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    expect(resizedPanel(from, 0.1, -0.1)).toEqual({ x: 0.2, y: 0.2, w: 0.6, h: 0.4 });
    // Dragged past the window's edge: the corner stops there rather than the
    // panel growing outside it.
    expect(resizedPanel(from, 1, 1)).toEqual({ x: 0.2, y: 0.2, w: 0.8, h: 0.8 });
    expect(resizedPanel(from, -1, -1)).toMatchObject(PANEL_MIN);
  });

  it('draws in percentages, so one display’s box is another’s', () => {
    expect(panelStyle({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 })).toEqual({
      left: '25%',
      top: '50%',
      width: '50%',
      height: '25%'
    });
  });

  /*
   * And a panel nobody has dragged has **no box**: it keeps the size the
   * stylesheet gives it, centred. A fraction cannot serve both ends of the
   * range — the form wants about 750px for its four tracks of switches, which
   * is 54% of a wide window and 94% of a narrow one — so it is not asked to,
   * and `min(1180px, 94vw)` in the stylesheet answers both.
   */
  it('draws nothing at all until something has been dragged', () => {
    expect(panelStyle(null)).toBeUndefined();
  });
});
