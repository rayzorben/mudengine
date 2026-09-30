import { describe, expect, it } from 'vitest';

import { goalKey, lessonsFor, type KonamiLesson } from '../konamiLessons';

const lesson = (level: number | null, at: number): KonamiLesson => ({
  at,
  goal: { kind: 'hunt', key: 'lair:kobold', name: 'kobold' },
  level,
  hpMax: 30,
  armourClass: 1,
  attack: 'aa',
  outcome: 'died',
  why: null,
  killers: ['kobold'],
  room: 'Cave',
  atTheSpot: true,
  expGained: null,
  minutes: 3
});

describe('the lessons sent with a brief', () => {
  it('are the ones learned near this level, newest first', () => {
    const kept = [lesson(1, 1), lesson(2, 2), lesson(25, 3), lesson(null, 4)];
    expect(lessonsFor(kept, 1, 2, 10).map((row) => row.at)).toEqual([4, 2, 1]);
    // A death to a kobold at level 1 says nothing at level 25.
    expect(lessonsFor(kept, 25, 2, 10).map((row) => row.at)).toEqual([4, 3]);
    expect(lessonsFor(kept, 1, 2, 1).map((row) => row.at)).toEqual([4]);
  });

  it('are matched to a spot by its key', () => {
    expect(goalKey(lesson(1, 1).goal)).toBe('hunt:lair:kobold');
    expect(goalKey({ kind: 'wait' })).toBe('wait');
  });
});
