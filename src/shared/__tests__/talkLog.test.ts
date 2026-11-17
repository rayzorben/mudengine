import { describe, expect, it } from 'vitest';

import { DEFAULT_INTERNAL } from '../internal';
import { talkExcess, talkKeepOf, type TalkKeep } from '../talkLog';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-17T12:00:00Z');
const KEEP: TalkKeep = { least: 3, most: 6, hours: 48 };

/** Lines said this many hours ago, oldest first. */
const agedHours = (...hours: number[]): { at: number }[] =>
  hours.map((ago) => ({ at: NOW - ago * HOUR }));

describe('how much talk is kept', () => {
  it('keeps every line while there are no more than the least', () => {
    expect(talkExcess(agedHours(900, 800, 700), NOW, KEEP)).toBe(0);
  });

  it('drops a line older than the hours, down to the least', () => {
    expect(talkExcess(agedHours(60, 50, 47, 3, 2, 1), NOW, KEEP)).toBe(2);
    expect(talkExcess(agedHours(90, 80, 70, 60, 50), NOW, KEEP)).toBe(2);
  });

  it('keeps a line inside the hours past the least, up to the most', () => {
    expect(talkExcess(agedHours(9, 8, 7, 6, 5, 4), NOW, KEEP)).toBe(0);
    expect(talkExcess(agedHours(9, 8, 7, 6, 5, 4, 3, 2), NOW, KEEP)).toBe(2);
  });

  it('keeps a least that is over the most', () => {
    const loaded: TalkKeep = { ...KEEP, least: 8 };
    expect(talkExcess(agedHours(99, 98, 97, 96, 95, 94, 93, 92), NOW, loaded)).toBe(0);
    expect(talkExcess(agedHours(99, 98, 97, 96, 95, 94, 93, 92, 1), NOW, loaded)).toBe(1);
  });

  it('reads its figures off the view tuning', () => {
    const view = DEFAULT_INTERNAL.tuning.view;
    expect(talkKeepOf(view)).toEqual({
      least: view.talkLimit,
      most: view.talkKeepMost,
      hours: view.talkKeepHours
    });
  });
});
