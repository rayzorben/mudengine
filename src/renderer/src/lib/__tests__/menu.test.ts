import { describe, expect, it } from 'vitest';

import { menuPosition } from '../menu';

const box = (top: number, left: number, width: number, height: number) => ({
  top,
  left,
  right: left + width,
  bottom: top + height
});

const VIEWPORT = { width: 1200, height: 800 };
const MENU = { width: 180, height: 100 };

describe('where a tab menu opens', () => {
  it('hangs below the button and lines up with its right edge', () => {
    // A kebab 16px wide at x=300, 20px tall at y=100.
    expect(menuPosition(box(100, 300, 16, 20), MENU, VIEWPORT)).toEqual({
      top: 124,
      left: 316 - 180
    });
  });

  /*
   * The one that matters. On a full left rail the last character's kebab is
   * near the bottom of the window, and its menu is the one somebody is most
   * likely to be reaching for.
   */
  it('lifts a menu that would open past the bottom of the window', () => {
    const at = menuPosition(box(780, 300, 16, 16), MENU, VIEWPORT);
    expect(at.top + MENU.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('pushes a menu that would open past the left edge back in', () => {
    // A left rail sits at x=0, so right-aligning to its kebab puts the menu at
    // a negative x — invisible rather than merely awkward.
    const at = menuPosition(box(100, 10, 16, 16), MENU, VIEWPORT);
    expect(at.left).toBeGreaterThanOrEqual(0);
  });

  it('pushes a menu that would open past the right edge back in', () => {
    const at = menuPosition(box(100, 1190, 16, 16), MENU, VIEWPORT);
    expect(at.left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  /*
   * A menu larger than the window keeps its near edge, so the entry the caret
   * lands on is the one still on screen. Clamping the other way round would put
   * the first entry off the top.
   */
  it('keeps the near edge when the menu is larger than the window', () => {
    const at = menuPosition(box(10, 10, 16, 16), { width: 2000, height: 2000 }, VIEWPORT);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.left).toBeGreaterThanOrEqual(0);
  });

  /*
   * A right-click has no control to hang off — the anchor is the pointer, and
   * a zero-width box right-aligned to it would open the menu to the *left* of
   * the click, reading as a menu for whatever it covered.
   */
  it('opens down and to the right of a point', () => {
    const at = menuPosition(box(200, 400, 0, 0), MENU, VIEWPORT, 'start');
    expect(at).toEqual({ top: 204, left: 400 });
  });

  it('pulls a point menu back in at the right edge of the window', () => {
    const at = menuPosition(box(200, 1190, 0, 0), MENU, VIEWPORT, 'start');
    expect(at.left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  /* A window with no room in it at all must not produce a negative coordinate. */
  it('survives a viewport smaller than the margins', () => {
    const at = menuPosition(box(0, 0, 0, 0), MENU, { width: 1, height: 1 });
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.left).toBeGreaterThanOrEqual(0);
  });
});
