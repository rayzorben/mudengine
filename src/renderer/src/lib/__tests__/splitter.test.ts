import { describe, expect, it } from 'vitest';

import {
  CONSOLE_COLUMNS,
  RAIL_RANGE,
  TAB_RAIL_RANGE,
  ceilingFor,
  clampWidth,
  keyAdjust,
  rememberedWidth
} from '../splitter';

describe('a pane width', () => {
  it('stays within its comfortable range', () => {
    expect(clampWidth(100, RAIL_RANGE)).toBe(RAIL_RANGE.min);
    expect(clampWidth(9000, RAIL_RANGE)).toBe(RAIL_RANGE.max);
    expect(clampWidth(400.6, RAIL_RANGE)).toBe(401);
  });

  it('sits at its minimum when the ceiling has collapsed under it', () => {
    // The window cannot give both the rail and the console what they want;
    // the rail yields and the console is reported narrow rather than rearranged.
    expect(clampWidth(300, { min: 260, max: 120 })).toBe(260);
    expect(clampWidth(Number.NaN, RAIL_RANGE)).toBe(RAIL_RANGE.min);
  });
});

describe('the console floor', () => {
  it('lets a pane take only the console’s slack beyond eighty columns', () => {
    // 10px cells, console 1000px wide: 200px of slack over the floor.
    const range = ceilingFor(RAIL_RANGE, 300, 1000, 10);
    expect(range.max).toBe(500);
    expect(range.min).toBe(RAIL_RANGE.min);
  });

  it('never exceeds the pane’s own maximum', () => {
    expect(ceilingFor(RAIL_RANGE, 300, 5000, 10).max).toBe(RAIL_RANGE.max);
  });

  it('gives width back to a console already under the floor, down to the pane’s minimum', () => {
    // 50px short of eighty columns: the pane yields exactly that much.
    const range = ceilingFor(TAB_RAIL_RANGE, 200, CONSOLE_COLUMNS * 10 - 50, 10);
    expect(clampWidth(200, range)).toBe(150);
    // And no further than its own minimum, however short the console is.
    const worse = ceilingFor(TAB_RAIL_RANGE, 200, CONSOLE_COLUMNS * 10 - 500, 10);
    expect(clampWidth(200, worse)).toBe(TAB_RAIL_RANGE.min);
  });

  it('falls back to the pane’s own range when nothing has been measured', () => {
    expect(ceilingFor(RAIL_RANGE, 300, 1000, 0)).toEqual(RAIL_RANGE);
    expect(ceilingFor(RAIL_RANGE, 300, Number.NaN, 10)).toEqual(RAIL_RANGE);
  });
});

describe('the keyboard', () => {
  it('follows the window-splitter pattern, with the growing arrow per edge', () => {
    expect(keyAdjust('ArrowLeft', false, 'ArrowLeft')).toBe(16);
    expect(keyAdjust('ArrowRight', false, 'ArrowLeft')).toBe(-16);
    expect(keyAdjust('ArrowRight', true, 'ArrowRight')).toBe(64);
    expect(keyAdjust('Home', false, 'ArrowLeft')).toBe('min');
    expect(keyAdjust('End', false, 'ArrowLeft')).toBe('max');
    expect(keyAdjust('Enter', false, 'ArrowLeft')).toBeNull();
  });
});

describe('a remembered width', () => {
  it('is clamped on the way in and refused when it is not a number', () => {
    expect(rememberedWidth(9999, RAIL_RANGE)).toBe(RAIL_RANGE.max);
    expect(rememberedWidth('340', RAIL_RANGE)).toBeNull();
    expect(rememberedWidth(Number.POSITIVE_INFINITY, RAIL_RANGE)).toBeNull();
  });
});
