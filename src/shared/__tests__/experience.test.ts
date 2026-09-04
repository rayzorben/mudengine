import { describe, expect, it } from 'vitest';

import {
  derivedExperienceTable,
  experienceChart,
  experienceOwed,
  experienceStanding,
  withDerivedExperience,
  withRealmExperience,
  type ExperienceLevel
} from '../experience';

/**
 * Two whole tables off the wire, and they are the whole point of this file.
 *
 * Recorded by this client on Paradigm (`~/.config/mudengine/logs`) from two
 * characters whose race and class the same sessions state on their stat sheets.
 * Twenty-two numbers, and the arithmetic in `experience.ts` has to reproduce
 * every one of them exactly — an approximation that is out by one at level 9 is
 * a client telling somebody they can train when they cannot.
 */
const GAUNT_ONE_MYSTIC = {
  /** `Gaunt One` 120 + `Mystic` 420, over a base of 100. */
  percent: 640,
  from: [6400, 12800, 23466, 43021, 73750, 126428, 205445, 333848, 519319, 807829, 1211743, 1817614]
};
const KANG_PALADIN = {
  /** `Kang` 150 + `Paladin` 490. */
  percent: 740,
  from: [7400, 14800, 27133, 49743, 85273, 146182, 237545, 386010, 600460, 934048]
};

/** A wire table as rows, levels ascending from 2. */
function rowsFrom(values: number[], first = 2): ExperienceLevel[] {
  return values.map((experience, index) => ({
    level: first + index,
    experience,
    source: 'realm' as const
  }));
}

describe('the chart the realm data implies', () => {
  it('reproduces a Gaunt One Mystic table, all twelve levels', () => {
    const chart = experienceChart(GAUNT_ONE_MYSTIC.percent, 13);
    expect(chart.map((row) => row.experience)).toEqual(GAUNT_ONE_MYSTIC.from);
  });

  it('reproduces a Kang Paladin table, all ten', () => {
    const chart = experienceChart(KANG_PALADIN.percent, 11);
    expect(chart.map((row) => row.experience)).toEqual(KANG_PALADIN.from);
  });

  it('costs a character with no race or class bonus exactly 1000 at level 2', () => {
    // `captures/115`: `Exp: 75000000 Level: 1 Exp needed for next level: 0
    // (1000)`. The base the two percentages scale, stated by a realm where
    // neither of them contributes anything.
    expect(experienceChart(100, 2)[0]?.experience).toBe(1000);
  });

  it('floors at every step rather than compounding a fraction', () => {
    /*
     * The distinction that makes the numbers exact rather than close. Chaining
     * from the *floored* previous value gives 519319 at level 10 for the Gaunt
     * One; carrying the fraction through gives 519318, which is the shape of
     * error that shows up nowhere until somebody cannot train.
     */
    const chart = experienceChart(GAUNT_ONE_MYSTIC.percent, 10);
    expect(chart.at(-1)?.experience).toBe(519319);
  });

  it('states nothing at all for a realm that named no percentage', () => {
    expect(experienceChart(0, 12)).toEqual([]);
    expect(derivedExperienceTable(0, 4)).toBeNull();
  });

  it('reproduces two GreaterMUD readings as well, which is a second server', () => {
    /*
     * `orohost`, 2026-08-26 to 08-28. A Kang Mystic seeded at 2850 and a
     * Half-Ogre Mystic seeded at 2800, each with the realm's own price for a
     * level several steps up the chain. Different server, different realm data,
     * same ladder.
     */
    expect(experienceChart(285, 6).at(-1)?.experience).toBe(32842);
    expect(experienceChart(280, 7).at(-1)?.experience).toBe(55309);
  });

  it('derives the same ten-level window the realm prints', () => {
    // A level-3 character's own listing runs 2 to 11; a level-5 character's
    // runs 4 to 13, which is what the recorded session at level 5 shows.
    const low = derivedExperienceTable(KANG_PALADIN.percent, 3);
    expect(low?.rows.map((row) => row.level)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const high = derivedExperienceTable(GAUNT_ONE_MYSTIC.percent, 5);
    expect(high?.rows.map((row) => row.level)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(high?.rows[0]?.experience).toBe(23466);
  });

  it('derives nothing at all above the level the ladder is confirmed to', () => {
    /*
     * The falsification, with a seed the same session states: the Half-Ogre
     * Mystic above is charged 40,195,899 for level 29 and the chain says
     * 99,835,591. So the chain stops at `EXPERIENCE_CONFIRMED_TO`, and a
     * character past it gets nothing rather than a window trailing off — half a
     * window reads as the realm's table with rows missing.
     */
    expect(experienceChart(280, 29).at(-1)?.experience).not.toBe(40_195_899);
    expect(derivedExperienceTable(280, 28)).toBeNull();
    expect(derivedExperienceTable(280, 15)).toBeNull();
    // The last level that still derives something, and it stops at 13.
    const edge = derivedExperienceTable(KANG_PALADIN.percent, 14);
    expect(edge?.rows.map((row) => row.level)).toEqual([13]);
  });

  it('marks every derived row as derived', () => {
    const table = derivedExperienceTable(KANG_PALADIN.percent, 3);
    expect(table?.rows.every((row) => row.source === 'database')).toBe(true);
  });
});

describe('folding in what the realm said', () => {
  it('takes the realm’s word for a level it states', () => {
    const table = withRealmExperience(null, [{ level: 2, experience: 7400 }]);
    expect(table?.rows).toEqual([{ level: 2, experience: 7400, source: 'realm' }]);
  });

  it('leaves the rest of a derivation standing where the realm confirms it', () => {
    // The summary line states one row. Throwing away nine the client can
    // defend because the tenth was confirmed would be a strictly worse card.
    const derived = derivedExperienceTable(KANG_PALADIN.percent, 3);
    const table = withRealmExperience(derived, [{ level: 4, experience: 27133 }]);
    expect(table?.rows).toHaveLength(10);
    expect(table?.rows.find((row) => row.level === 4)).toEqual({
      level: 4,
      experience: 27133,
      source: 'realm'
    });
    expect(table?.rows.find((row) => row.level === 5)?.source).toBe('database');
  });

  it('discards the whole derivation when the realm contradicts one row of it', () => {
    /*
     * The chain is one seed and one ladder, so a single wrong value says one of
     * the two is wrong — and the rows that still agree are agreeing by luck.
     * What is left is what the realm itself has said, which is always enough
     * for the question the card is for.
     */
    const derived = derivedExperienceTable(KANG_PALADIN.percent, 3);
    const table = withRealmExperience(derived, [{ level: 4, experience: 99999 }]);
    expect(table?.rows).toEqual([{ level: 4, experience: 99999, source: 'realm' }]);
  });

  it('accumulates the windows as the realm prints them', () => {
    const first = withRealmExperience(null, rowsFrom(KANG_PALADIN.from));
    const later = withRealmExperience(first, rowsFrom([1211743, 1817614], 12));
    expect(later?.rows).toHaveLength(12);
    expect(later?.rows.find((row) => row.level === 12)?.experience).toBe(1211743);
  });

  it('is unmoved by a listing with nothing readable in it', () => {
    const derived = derivedExperienceTable(KANG_PALADIN.percent, 3);
    expect(withRealmExperience(derived, [])).toBe(derived);
    expect(withRealmExperience(derived, [{ level: 1, experience: 0 }])).toBe(derived);
  });
});

describe('folding a derived window under what the realm said', () => {
  const derived = (level: number) => derivedExperienceTable(KANG_PALADIN.percent, level)!;

  it('fills in the nine rows GreaterMUD never prints', () => {
    /*
     * The case this exists for. `exp` on GreaterMUD answers with the summary
     * line and no table at all — nought tables across every recorded `orohost`
     * session — so the only row the wire ever states there is the next level's
     * price. Freezing the derivation on it left a chart of one row on the realm
     * this client now ships as its default.
     */
    const stated = withRealmExperience(null, [{ level: 4, experience: 27133 }]);
    const table = withDerivedExperience(stated, derived(3));
    expect(table?.rows).toHaveLength(10);
    expect(table?.rows.find((row) => row.level === 4)?.source).toBe('realm');
    expect(table?.rows.filter((row) => row.source === 'database')).toHaveLength(9);
  });

  it('adds nothing at all once the realm has contradicted the chain', () => {
    // The freeze, kept — and kept without a flag to remember it by: the row
    // that refused the chain is still there to refuse it on the next block.
    const stated = withRealmExperience(null, [{ level: 4, experience: 99999 }]);
    expect(withDerivedExperience(stated, derived(3))).toBe(stated);
  });

  it('replaces the whole of an older chain when the seed has changed', () => {
    // A character rerolled onto another race or class. Two chains in one table
    // is a chart that is wrong wherever the two disagree and says nothing about
    // where that is.
    const first = withDerivedExperience(null, derived(3));
    const table = withDerivedExperience(first, derivedExperienceTable(640, 3)!);
    expect(table?.rows.find((row) => row.level === 2)?.experience).toBe(6400);
    expect(table?.rows.every((row) => row.source === 'database')).toBe(true);
  });

  it('is unmoved when it has nothing to add', () => {
    const first = withDerivedExperience(null, derived(3));
    expect(withDerivedExperience(first, derived(3))).toBe(first);
  });
});

describe('what is still owed, and who said so', () => {
  const wire = withRealmExperience(null, rowsFrom(KANG_PALADIN.from));
  const guess = derivedExperienceTable(KANG_PALADIN.percent, 3);

  it('prefers the realm’s own figure while it answers the same question', () => {
    /*
     * `Exp needed for next level` is the server's arithmetic and, on a realm
     * whose prompt carries `Need=`, it is restated several times a second.
     * Drawing a derived number in front of it inverts the rule that the wire
     * wins — and `orohost` prices two of its classes differently from every
     * realm database on this machine, so the derived seed there is wrong for
     * some characters and the wire is right for all of them.
     */
    const standing = experienceStanding(3, 20_000, guess);
    expect(experienceOwed(7_133, standing)).toEqual({ value: 7_133, derived: false });
  });

  it('falls back to the table only where the realm’s figure cannot answer', () => {
    // Ahead of its level: the realm reports 0, which is true and about a
    // different level from the one being earned towards.
    const standing = experienceStanding(3, 75_547, guess);
    expect(experienceOwed(0, standing)).toEqual({ value: 9_726, derived: true });
  });

  it('does not mark a figure the realm itself stated', () => {
    const standing = experienceStanding(3, 75_547, wire);
    expect(experienceOwed(0, standing)).toEqual({ value: 9_726, derived: false });
  });

  it('answers with the realm’s figure when there is no table at all', () => {
    expect(experienceOwed(1_234, null)).toEqual({ value: 1_234, derived: false });
    expect(experienceOwed(null, null)).toEqual({ value: null, derived: false });
  });
});

describe('where a character actually stands', () => {
  const table = withRealmExperience(null, rowsFrom(KANG_PALADIN.from));

  it('names the level already paid for, and the one being earned towards', () => {
    // The recorded session: level 3, 75,547 experience — enough for level 5,
    // and 9,726 short of level 6. The realm's own summary says `Exp needed for
    // next level: 0`, which is true and answers a different question.
    const standing = experienceStanding(3, 75_547, table);
    expect(standing).toEqual({
      level: 3,
      earned: 5,
      next: 6,
      needed: 9_726,
      ahead: true,
      nextSource: 'realm',
      earnedSource: 'realm'
    });
  });

  it('says nothing is ahead when the level and the experience agree', () => {
    const standing = experienceStanding(3, 20_000, table);
    expect(standing).toMatchObject({ earned: 3, next: 4, needed: 7_133, ahead: false });
  });

  it('refuses to guess past the end of the window', () => {
    // Outrunning the table is not a licence to invent the row after it.
    const standing = experienceStanding(11, 2_000_000, table);
    expect(standing).toMatchObject({ next: null, needed: null });
  });

  it('answers nothing at all while a half of it is unknown', () => {
    expect(experienceStanding(null, 100, table)).toBeNull();
    expect(experienceStanding(3, null, table)).toBeNull();
    expect(experienceStanding(3, 100, null)).toBeNull();
  });
});
