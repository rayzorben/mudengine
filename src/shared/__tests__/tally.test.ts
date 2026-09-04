import { describe, expect, it } from 'vitest';

import {
  blowKind,
  damageDealt,
  engagedFor,
  engagedShare,
  mean,
  NO_TALLY,
  perRound,
  ratePerHour,
  readTally,
  share,
  sinceBaseline,
  swings,
  turnedAside,
  withBlow,
  type CombatTally
} from '../tally';

/**
 * The three kinds this server's own text distinguishes, and nothing else.
 * Combat text is realm *data* — the verb comes out of a per-weapon template —
 * so what is fixed is the adverb and the cast, never a list of verbs.
 */
describe('which kind of blow a line was', () => {
  it('reads a critical off the adverb, whatever verb the weapon uses', () => {
    // All four from the capture corpus, in four different weapons' words.
    expect(blowKind('critically slice gigantic black ooze')).toBe('critical');
    expect(blowKind('critically punch massive ice dragon')).toBe('critical');
    expect(blowKind('critically jumpkick mamba')).toBe('critical');
    expect(blowKind('critically hurl your chakram at fat roc')).toBe('critical');
  });

  /*
   * `bs buttah` → `*Combat Engaged*` → `You surprise punch Buttah for 37
   * damage!`. Five captures carry it; this file's own header used to say none
   * did, and every one of these was being counted as an ordinary melee blow.
   */
  it('reads a backstab off the surprise, whatever verb the weapon uses', () => {
    expect(blowKind('surprise punch Buttah')).toBe('backstab');
    expect(blowKind('surprise impale HeMan')).toBe('backstab');
    expect(blowKind('surprise chop ice sorceress')).toBe('backstab');
    expect(blowKind('surprise slice large ghoul')).toBe('backstab');
  });

  /* No line in the corpus carries both words. The order says which claim wins
     if a realm ever prints one: the attack that was made, not how it rolled. */
  it('answers backstab when a line somehow carries both words', () => {
    expect(blowKind('critically surprise chop ice golem')).toBe('backstab');
  });

  it('reads a spell off the cast', () => {
    expect(blowKind('cast earthfist at storm giant king')).toBe('spell');
    expect(blowKind('cast unholy force on Covenant')).toBe('spell');
  });

  it('reads everything else as melee, however exotic the verb', () => {
    expect(blowKind('skewer silver cobra')).toBe('melee');
    expect(blowKind('hurl your chakram at giant crab')).toBe('melee');
    expect(blowKind('punch white jelly')).toBe('melee');
  });

  /* A line with no words at all still has to answer something, and melee is
     the answer that adds a blow to the total without inventing a category. */
  it('answers melee for a line it was given nothing of', () => {
    expect(blowKind(undefined)).toBe('melee');
    expect(blowKind('')).toBe('melee');
  });
});

describe('folding a blow into a running total', () => {
  it('keeps both extremes, and starts them at the first blow rather than zero', () => {
    const one = withBlow({ hits: 0, damage: 0, least: null, most: null }, 12);
    expect(one).toEqual({ hits: 1, damage: 12, least: 12, most: 12 });
    const two = withBlow(one, 4);
    expect(two).toEqual({ hits: 2, damage: 16, least: 4, most: 12 });
    expect(withBlow(two, 40).most).toBe(40);
  });
});

/* Absence is absence: a readout that renders an unmeasured average as `0.0`
   is the same lie a vital painted red for want of a number is. */
describe('a figure nothing has been measured for', () => {
  it('is null, never zero', () => {
    expect(mean(0, 0)).toBeNull();
    expect(share(0, 0)).toBeNull();
    expect(ratePerHour(0, null, Date.now())).toBeNull();
    expect(perRound(NO_TALLY, Date.now(), 5000)).toBeNull();
    expect(engagedShare(NO_TALLY, Date.now())).toBeNull();
  });

  /* A scope that has measured no time is the one case with no answer: an
     hourly figure extrapolated from nothing is a made-up number, not a
     small error. */
  it('needs the scope to have measured some time', () => {
    const at = 1_000_000;
    expect(ratePerHour(5_000, at, at)).toBeNull();
    expect(ratePerHour(5_000, at, at - 1)).toBeNull();
  });

  /*
   * The whole complaint the scope rate answers (todo 01).
   *
   * The rolling window it replaced needed two marks a minute apart, and marks
   * arriving inside that minute replaced the last one — so during a fight,
   * where something is counted every few seconds, the window never grew past
   * one mark and every rate on the card read `—` for as long as the character
   * kept fighting. A rate is answerable from the first second the scope has
   * measured.
   */
  /*
   * **And a scope that has barely started is refused, which the first version
   * of this got wrong.** `since` is set by the first block that moves the
   * tally and the card re-renders on the next status line, so the first
   * reading divided by tens of milliseconds: 66 experience 300ms in drew
   * `792,000/hr`, and `Will level in` — the figure somebody decides *keep
   * going or go and train* on — drew nine seconds.
   */
  it('refuses a rate the scope has not run long enough to support', () => {
    const at = 1_000_000;
    expect(ratePerHour(66, at, at + 300, 5_000)).toBeNull();
    expect(ratePerHour(66, at, at + 4_999, 5_000)).toBeNull();
    expect(ratePerHour(66, at, at + 5_000, 5_000)).not.toBeNull();
  });

  it('reads a rate over the scope, from the first second it has', () => {
    const at = 1_000_000;
    expect(ratePerHour(5_000, at, at + 3_600_000)).toBeCloseTo(5_000);
    expect(ratePerHour(40, at, at + 3_600_000)).toBeCloseTo(40);
    // Forty seconds in, which is where the card was reported showing a dash.
    expect(ratePerHour(66, at, at + 40_000)).toBeCloseTo(5_940);
  });
});

/**
 * Every swing, landed or not — the denominator MegaMUD's own window used, with
 * Miss, Hit and Crit as three shares of it. A spell is deliberately outside it:
 * a spell that fails is refused in its own sentence and is never a miss.
 */
describe('the denominator', () => {
  it('counts melee, criticals, backstabs and misses, and not spells', () => {
    const tally: CombatTally = {
      ...NO_TALLY,
      dealt: {
        melee: { hits: 10, damage: 100, least: 5, most: 20 },
        critical: { hits: 2, damage: 80, least: 35, most: 45 },
        backstab: { hits: 1, damage: 37, least: 37, most: 37 },
        spell: { hits: 7, damage: 210, least: 20, most: 40 }
      },
      missed: 8
    };
    expect(swings(tally)).toBe(21);
    expect(damageDealt(tally)).toBe(427);
  });

  /*
   * And the other side of the fight. A swing that did nothing is one figure
   * and a swing the server said was dodged is another, but the share each
   * takes is of everything that came at this character — so the denominator
   * has to hold both.
   */
  it('adds a stated dodge to an unexplained turn for the incoming share', () => {
    const tally: CombatTally = { ...NO_TALLY, turned: 9, dodged: 4 };
    expect(turnedAside(tally)).toBe(13);
    expect(share(tally.dodged, turnedAside(tally) + tally.taken.hits)).toBeCloseTo(4 / 13);
  });
});

/* The fight still running is added at the point of reading, so a figure on
   screen during a long fight does not sit still for the length of it. */
describe('engaged time', () => {
  const now = 2_000_000;

  it('adds the fight that has not ended yet', () => {
    const tally: CombatTally = { ...NO_TALLY, engagedMs: 30_000, engagedSince: now - 10_000 };
    expect(engagedFor(tally, now)).toBe(40_000);
  });

  it('is only the settled fights when none is running', () => {
    expect(engagedFor({ ...NO_TALLY, engagedMs: 30_000 }, now)).toBe(30_000);
  });

  it('never reports more of the scope than the scope has existed for', () => {
    const tally: CombatTally = {
      ...NO_TALLY,
      since: now - 10_000,
      engagedMs: 60_000,
      engagedSince: null
    };
    expect(engagedShare(tally, now)).toBe(1);
  });

  it('divides damage by rounds rather than by blows', () => {
    const tally: CombatTally = {
      ...NO_TALLY,
      dealt: { ...NO_TALLY.dealt, melee: { hits: 4, damage: 200, least: 30, most: 70 } },
      engagedMs: 20_000
    };
    // Twenty seconds is four five-second rounds.
    expect(perRound(tally, now, 5000)).toBeCloseTo(50);
  });
});

/**
 * The Reset control: main keeps one monotonic total and the reader subtracts a
 * reading it took earlier, which is what makes the press instant and leaves the
 * untouched totals still there.
 */
describe('reading from a baseline', () => {
  const base: CombatTally = {
    ...NO_TALLY,
    since: 1_000,
    at: 5_000,
    dealt: {
      melee: { hits: 10, damage: 100, least: 5, most: 20 },
      critical: NO_TALLY.dealt.critical,
      backstab: NO_TALLY.dealt.backstab,
      spell: NO_TALLY.dealt.spell
    },
    missed: 4,
    taken: { hits: 6, damage: 48, least: 4, most: 12 },
    turned: 3,
    kills: 2,
    experience: 500,
    engagedMs: 20_000
  };

  const later: CombatTally = {
    ...base,
    at: 9_000,
    dealt: { ...base.dealt, melee: { hits: 14, damage: 180, least: 5, most: 44 } },
    missed: 5,
    kills: 3,
    experience: 800,
    engagedMs: 35_000
  };

  it('reports the difference, not the totals', () => {
    const shown = sinceBaseline(later, base);
    expect(shown.dealt.melee.hits).toBe(4);
    expect(shown.dealt.melee.damage).toBe(80);
    expect(shown.missed).toBe(1);
    expect(shown.kills).toBe(1);
    expect(shown.experience).toBe(300);
    expect(shown.engagedMs).toBe(15_000);
  });

  it('dates the scope from when the button was pressed', () => {
    expect(sinceBaseline(later, base).since).toBe(base.at);
  });

  /*
   * The extremes cannot be subtracted — a running total does not record the
   * smallest blow *since* a moment — so they are kept whole while anything has
   * landed since. That overstates the range and never the count or the mean,
   * which is the honest direction to be wrong in.
   */
  it('keeps the extremes whole while anything has landed, and drops them when nothing has', () => {
    expect(sinceBaseline(later, base).dealt.melee.most).toBe(44);
    expect(sinceBaseline(base, base).dealt.melee.most).toBeNull();
    expect(sinceBaseline(base, base).dealt.melee.least).toBeNull();
  });

  /* A fight that was already running when the button was pressed contributes
     only the part after it, or the first reading would report more engaged
     time than the scope has existed for. */
  it('clamps a fight that was already running to the reset', () => {
    const open = { ...later, engagedSince: 2_000 };
    expect(sinceBaseline(open, base).engagedSince).toBe(base.at);
  });

  it('is the totals themselves when nothing has been reset', () => {
    expect(sinceBaseline(later, null)).toBe(later);
  });

  /* `since` is the rates' denominator, so re-basing it is what makes Reset
     mean *how am I doing right now* without a second mechanism. */
  it('moves the scope the rates are read over to the reset', () => {
    expect(sinceBaseline(later, base).since).toBe(base.at);
  });
});

/* The baseline lives in `localStorage`, which is a boundary like any other. */
describe('reading a stored baseline back', () => {
  it('refuses anything that is not one', () => {
    expect(readTally(null)).toBeNull();
    expect(readTally('7')).toBeNull();
    expect(readTally(42)).toBeNull();
  });

  it('reads a whole one back', () => {
    const stored = JSON.parse(JSON.stringify({ ...NO_TALLY, at: 9, kills: 3, experience: 400 }));
    const found = readTally(stored);
    expect(found?.kills).toBe(3);
    expect(found?.experience).toBe(400);
    expect(found?.at).toBe(9);
  });

  /* A value written by an older build is missing fields rather than malformed,
     and the answer is the field's own absence — never a crash and never a
     number invented for it. */
  it('fills what a partial one does not say, without inventing an extreme', () => {
    const found = readTally({ kills: 2 });
    expect(found?.kills).toBe(2);
    expect(found?.experience).toBe(0);
    expect(found?.since).toBeNull();
    expect(found?.taken.least).toBeNull();
    expect(found?.dealt.melee.most).toBeNull();
  });

  /*
   * The fields added on 2026-09-02. A baseline written by the build before
   * them says nothing about any of them, and the answer is zero — which is
   * what makes the Reset button safe across an upgrade: the first reading
   * after it credits the whole session's dodges rather than crashing on an
   * absent field.
   */
  it('reads the backstab, dodge, sneak and coin figures, and defaults them to nothing', () => {
    const found = readTally({ dodged: 4, sneakTried: 9, sneakFailed: 2, coins: 317 });
    expect(found?.dodged).toBe(4);
    expect(found?.sneakTried).toBe(9);
    expect(found?.sneakFailed).toBe(2);
    expect(found?.coins).toBe(317);
    expect(found?.dealt.backstab).toEqual(NO_TALLY.dealt.backstab);

    const older = readTally({ kills: 1 });
    expect(older?.dodged).toBe(0);
    expect(older?.coins).toBe(0);
    expect(older?.dealt.backstab.hits).toBe(0);
  });

  /* A key from an older build is ignored rather than carried: the shape is
     read field by field, so nothing outside it can arrive. */
  it('ignores a key this build no longer keeps', () => {
    const read = readTally({ experience: 12, marks: [{ at: 1, experience: 2 }] });
    expect(read?.experience).toBe(12);
    expect(read).not.toHaveProperty('marks');
  });
});
