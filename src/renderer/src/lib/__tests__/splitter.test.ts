import { describe, expect, it } from 'vitest';

import {
  CONSOLE_COLUMNS,
  DOCK_RANGE,
  TAB_RAIL_RANGE,
  ceilingFor,
  consoleTrack,
  clampWidth,
  CONSOLE_RANGE,
  keyAdjust,
  rememberedColumns,
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
  /*
   * 10px cells and 20px of each pane that is not cells. A pane holding 70
   * columns is 720px: the track grows by the 10 columns it is short.
   */
  it('grows or shrinks by the columns each pane is short or over', () => {
    expect(consoleTrack(760, 720, 20, 10, 1)).toBe(860);
    // Two panes side by side at 90 each give back 10 columns apiece.
    expect(consoleTrack(1868, 920, 20, 10, 2)).toBe(1668);
  });

  it('is a fixed point once the console holds what it keeps', () => {
    expect(consoleTrack(860, 820, 20, 10, 1)).toBe(860);
    expect(consoleTrack(1060, 1020, 20, 10, 1, CONSOLE_RANGE.max - 20)).toBe(1060);
  });

  /*
   * The split that flaked (todo 09): one pane of eighty becomes two before
   * either terminal has fitted. Each pane is already laid out at half the
   * track, so the track is answered for two panes of eighty at once, and no
   * fit lands at forty columns first.
   */
  it('answers a change in panes across before the terminals fit', () => {
    // 820px holding eighty; split two ways with an 8px gap, each pane is 406px.
    expect(consoleTrack(820, 406, 20, 10, 2)).toBe(1648);
  });

  it('rounds up, so the track is never a fraction of a column short', () => {
    expect(consoleTrack(700, 700, 36.4, 8.4, 1)).toBe(709);
  });

  it('is unknown before the terminal has been measured', () => {
    expect(consoleTrack(800, 0, 20, 10, 1)).toBeNull();
    expect(consoleTrack(800, 800, 20, Number.NaN, 1)).toBeNull();
    expect(consoleTrack(0, 800, 20, 10, 1)).toBeNull();
    expect(consoleTrack(800, 800, Number.NaN, 10, 1)).toBeNull();
  });
});

describe('a remembered console width', () => {
  it('is held between eighty and a hundred and twenty whole columns', () => {
    expect(rememberedColumns(100.4)).toBe(100);
    expect(rememberedColumns(40)).toBe(CONSOLE_RANGE.min);
    expect(rememberedColumns(400)).toBe(CONSOLE_RANGE.max);
  });

  it('is nothing for what is not a number', () => {
    expect(rememberedColumns('96')).toBeNull();
    expect(rememberedColumns(Number.NaN)).toBeNull();
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
