import { describe, expect, it } from 'vitest';

import {
  CONSOLE_COLUMNS,
  DOCK_RANGE,
  TAB_RAIL_RANGE,
  ceilingFor,
  consoleTrack,
  clampWidth,
  keyAdjust,
  rememberedWidth
} from '../splitter';

describe('a pane width', () => {
  it('stays within its comfortable range', () => {
    expect(clampWidth(100, DOCK_RANGE)).toBe(DOCK_RANGE.min);
    expect(clampWidth(9000, DOCK_RANGE)).toBe(DOCK_RANGE.max);
    expect(clampWidth(400.6, DOCK_RANGE)).toBe(401);
  });

  it('sits at its minimum when the ceiling has collapsed under it', () => {
    // The window cannot give both the tab rail and the console what they
    // want; the tab rail yields and the console is reported narrow rather than rearranged.
    expect(clampWidth(300, { min: 260, max: 120 })).toBe(260);
    expect(clampWidth(Number.NaN, DOCK_RANGE)).toBe(DOCK_RANGE.min);
  });
});

describe('the console floor', () => {
  it('lets a pane take only the console’s slack beyond eighty columns', () => {
    // 10px cells, 850px of console and rail: 50px of slack over the floor.
    const range = ceilingFor(TAB_RAIL_RANGE, 200, 850, 10);
    expect(range.max).toBe(250);
    expect(range.min).toBe(TAB_RAIL_RANGE.min);
  });

  it('never exceeds the pane’s own maximum', () => {
    expect(ceilingFor(DOCK_RANGE, 300, 5000, 10).max).toBe(DOCK_RANGE.max);
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
    expect(ceilingFor(DOCK_RANGE, 300, 1000, 0)).toEqual(DOCK_RANGE);
    expect(ceilingFor(DOCK_RANGE, 300, Number.NaN, 10)).toEqual(DOCK_RANGE);
  });
});

describe('the console track', () => {
  it('grows or shrinks by the columns it is short or over, per pane across', () => {
    // 10px cells: 70 columns fitted in 760px wants 100px more.
    expect(consoleTrack(760, 70, 10, 1)).toBe(860);
    // Two panes side by side at 90 each give back 10 columns apiece.
    expect(consoleTrack(1900, 90, 10, 2)).toBe(1700);
  });

  it('is a fixed point once the console holds eighty', () => {
    expect(consoleTrack(860, CONSOLE_COLUMNS, 10, 1)).toBe(860);
  });

  it('rounds up, so the track is never a fraction of a column short', () => {
    expect(consoleTrack(700, 79, 8.4, 1)).toBe(709);
  });

  it('is unknown before the terminal has been measured', () => {
    expect(consoleTrack(800, 0, 10, 1)).toBeNull();
    expect(consoleTrack(800, 80, Number.NaN, 1)).toBeNull();
    expect(consoleTrack(0, 80, 10, 1)).toBeNull();
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
    expect(rememberedWidth(9999, DOCK_RANGE)).toBe(DOCK_RANGE.max);
    expect(rememberedWidth('340', DOCK_RANGE)).toBeNull();
    expect(rememberedWidth(Number.POSITIVE_INFINITY, DOCK_RANGE)).toBeNull();
  });
});
