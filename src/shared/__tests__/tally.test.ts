import { describe, expect, it } from 'vitest';

import {
  BLOW_KINDS,
  experienceAt,
  rateSeries,
  withSample,
  blowKind,
  damageDealt,
  engagedFor,
  engagedShare,
  isCombatTally,
  mean,
  NO_TALLY,
  onlineFor,
  perRound,
  ratePerHour,
  settleClocks,
  share,
  sinceBaseline,
  swings,
  turnedAside,
  withArrival,
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
    expect(ratePerHour(0, 0)).toBeNull();
    expect(perRound(NO_TALLY, Date.now(), 5000)).toBeNull();
    expect(engagedShare(NO_TALLY, Date.now())).toBeNull();
  });

  /* A scope that has measured no time is the one case with no answer: an
     hourly figure extrapolated from nothing is a made-up number, not a
     small error. */
  it('needs the scope to have measured some time', () => {
    expect(ratePerHour(5_000, 0)).toBeNull();
    expect(ratePerHour(5_000, -1)).toBeNull();
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
    expect(ratePerHour(66, 300, 5_000)).toBeNull();
    expect(ratePerHour(66, 4_999, 5_000)).toBeNull();
    expect(ratePerHour(66, 5_000, 5_000)).not.toBeNull();
  });

  it('reads a rate over the scope, from the first second it has', () => {
    expect(ratePerHour(5_000, 3_600_000)).toBeCloseTo(5_000);
    expect(ratePerHour(40, 3_600_000)).toBeCloseTo(40);
    // Forty seconds in, which is where the card was reported showing a dash.
    expect(ratePerHour(66, 40_000)).toBeCloseTo(5_940);
  });

  /*
   * The denominator is time *in the realm*, not wall-clock time since the
   * scope began (todo 06, 2026-09-17): the tally outlives the socket and the
   * launch, and a night spent disconnected is not an hour the character
   * earned nothing in.
   */
  it('is read over the time in the realm, so a night offline does not dilute it', () => {
    const now = 10_000_000;
    const tally: CombatTally = {
      ...NO_TALLY,
      since: now - 8 * 3_600_000,
      experience: 12_000,
      onlineMs: 3_600_000,
      onlineSince: now - 1_800_000
    };
    expect(onlineFor(tally, now)).toBe(5_400_000);
    expect(ratePerHour(tally.experience, onlineFor(tally, now))).toBeCloseTo(8_000);
  });
});

/**
 * The two halves of the kind union, held to each other.
 *
 * `Record<BlowKind, BlowTally>` compile-enforces `NO_TALLY.dealt`,
 * `sinceBaseline` and the card's `KIND_LABEL`, so those three cannot drift.
 * `BLOW_KINDS` is a plain array and **can**: a kind added to the type and
 * forgotten here type-checks, and then vanishes from `damageDealt`,
 * `hitsDealt` and the Combat Stats card's rows without a word. That is the
 * `GUARD_FIELDS`/`readField` failure exactly — a field in one half and not
 * the other, loading fine and silently never firing — and this is the same
 * regression test `guard-fields.test.ts` is.
 */
describe('the kinds a blow can be', () => {
  it('lists every kind the tally keeps a total for, and no others', () => {
    expect([...BLOW_KINDS].sort()).toEqual(Object.keys(NO_TALLY.dealt).sort());
  });

  /*
   * And every one of them reaches the totals. `damageDealt` reduces over the
   * list, so a kind absent from it contributes nothing however much of it
   * landed.
   */
  it('counts every kind toward the damage dealt', () => {
    for (const kind of BLOW_KINDS) {
      const one: CombatTally = {
        ...NO_TALLY,
        dealt: { ...NO_TALLY.dealt, [kind]: { hits: 1, damage: 7, least: 7, most: 7 } }
      };
      expect(damageDealt(one), `${kind} should reach damageDealt`).toBe(7);
    }
  });
});

/**
 * Every swing, landed or not — the denominator MegaMUD's own window used, with
 * Miss, Hit and Crit as three shares of it. A spell is deliberately outside it:
 * a spell that fails is refused in its own sentence and is never a miss. And a
 * weapon's proc is outside it from the other side — it lands *off* a swing
 * already in the denominator, so counting it would put one round in twice.
 */
describe('the denominator', () => {
  it('counts melee, criticals, backstabs and misses, and not spells or procs', () => {
    const tally: CombatTally = {
      ...NO_TALLY,
      dealt: {
        melee: { hits: 10, damage: 100, least: 5, most: 20 },
        critical: { hits: 2, damage: 80, least: 35, most: 45 },
        backstab: { hits: 1, damage: 37, least: 37, most: 37 },
        spell: { hits: 7, damage: 210, least: 20, most: 40 },
        proc: { hits: 5, damage: 15, least: 1, most: 3 }
      },
      missed: 8
    };
    expect(swings(tally)).toBe(21);
    // Damage, though, is damage: a proc's points came off the monster like
    // every other point this character dealt.
    expect(damageDealt(tally)).toBe(442);
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
      engagedSince: null,
      onlineMs: 10_000
    };
    expect(engagedShare(tally, now)).toBe(1);
  });

  it('is a share of the time in the realm, not of the wall clock', () => {
    const tally: CombatTally = {
      ...NO_TALLY,
      since: now - 100_000,
      engagedMs: 5_000,
      onlineMs: 20_000
    };
    expect(engagedShare(tally, now)).toBeCloseTo(0.25);
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
      spell: NO_TALLY.dealt.spell,
      proc: NO_TALLY.dealt.proc
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

  /* And once that fight has ended, its whole length is in the settled total
     while only the part after the reset was this scope's. */
  it('takes the part of a fight before the reset off the settled total once it ends', () => {
    const fighting = { ...base, engagedMs: 0, engagedSince: 1_000 };
    // The fight ran 1,000 → 11,000; the button was pressed at 5,000.
    const ended = { ...later, engagedMs: 10_000, engagedSince: null };
    expect(sinceBaseline(ended, fighting).engagedMs).toBe(6_000);
    expect(sinceBaseline(ended, fighting).engagedSince).toBeNull();
  });

  it('cuts the stretches away at the reset', () => {
    const away = {
      ...later,
      away: [
        { from: 1_000, to: 7_000 },
        { from: 100, to: 200 }
      ]
    };
    expect(sinceBaseline(away, base).away).toEqual([{ from: 5_000, to: 7_000 }]);
  });

  it('reads the time in the realm from the reset the same way', () => {
    const online = { ...base, onlineMs: 0, onlineSince: 1_000 };
    // Still the same visit: nothing settled, the open part clamped to the reset.
    const stillHere = { ...later, onlineMs: 0, onlineSince: 1_000 };
    expect(sinceBaseline(stillHere, online).onlineMs).toBe(0);
    expect(sinceBaseline(stillHere, online).onlineSince).toBe(base.at);
    // A visit ended and another begun: the first's part before the reset is
    // not this scope's, and the second counts from where it began.
    const returned = { ...later, onlineMs: 10_000, onlineSince: 20_000 };
    expect(sinceBaseline(returned, online).onlineMs).toBe(6_000);
    expect(sinceBaseline(returned, online).onlineSince).toBe(20_000);
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

/*
 * A tally that outlives the socket (todo 06, 2026-09-17): the moment the
 * socket dies, and the moment a record was written by a launch that ended
 * without one, are moments nothing on the wire describes.
 */
describe('settling the clocks', () => {
  it('closes both open intervals at the moment given', () => {
    const tally: CombatTally = {
      ...NO_TALLY,
      engagedMs: 1_000,
      engagedSince: 5_000,
      onlineMs: 10_000,
      onlineSince: 2_000
    };
    expect(settleClocks(tally, 8_000)).toEqual({
      ...tally,
      engagedMs: 4_000,
      engagedSince: null,
      onlineMs: 16_000,
      onlineSince: null,
      leftAt: 8_000
    });
  });

  it('is the same tally when nothing was open', () => {
    expect(settleClocks(NO_TALLY, 8_000)).toBe(NO_TALLY);
  });

  it('marks when the character left, and arriving closes the stretch away', () => {
    const left = settleClocks({ ...NO_TALLY, onlineSince: 2_000 }, 8_000);
    expect(left.leftAt).toBe(8_000);
    const back = withArrival(left, 20_000, 3_600_000);
    expect(back.away).toEqual([{ from: 8_000, to: 20_000 }]);
    expect(back.leftAt).toBeNull();
  });

  it('keeps only the stretches away that reach into the window', () => {
    const tally: CombatTally = { ...NO_TALLY, away: [{ from: 0, to: 1_000 }], leftAt: 50_000 };
    expect(withArrival(tally, 60_000, 20_000).away).toEqual([{ from: 50_000, to: 60_000 }]);
  });

  it('never counts a clock backwards', () => {
    const tally: CombatTally = { ...NO_TALLY, onlineSince: 9_000 };
    expect(settleClocks(tally, 8_000).onlineMs).toBe(0);
  });
});

/* Read back from disk, where anything may have edited it: parsed, not trusted. */
describe('a tally read back', () => {
  it('accepts what the client wrote', () => {
    expect(isCombatTally(NO_TALLY)).toBe(true);
    expect(isCombatTally(JSON.parse(JSON.stringify(NO_TALLY)))).toBe(true);
  });

  it('refuses a shape from another build or another hand', () => {
    expect(isCombatTally(null)).toBe(false);
    expect(isCombatTally({ ...NO_TALLY, away: [{ from: 1 }] })).toBe(false);
    expect(isCombatTally({ ...NO_TALLY, leftAt: 'yesterday' })).toBe(false);
    expect(isCombatTally({ ...NO_TALLY, onlineMs: undefined })).toBe(false);
    expect(isCombatTally({ ...NO_TALLY, kills: 'many' })).toBe(false);
    expect(isCombatTally({ ...NO_TALLY, samples: [{ at: 1 }] })).toBe(false);
    expect(isCombatTally({ ...NO_TALLY, dealt: { ...NO_TALLY.dealt, proc: undefined } })).toBe(
      false
    );
    expect(isCombatTally({ ...NO_TALLY, taken: { hits: 1, damage: 4, least: 'x', most: 4 } })).toBe(
      false
    );
  });
});

/*
 * Experience sampled for the Combat Stats card's rate graph (todo 08,
 * 2026-09-17): one point per slot, the newest kept current, a cap on how
 * many, and a rate per bin read off them.
 */
describe('experience sampled for the rate graph', () => {
  const at = (experience: number, ms: number) => ({ at: ms, experience });

  /* The rule the rates keep through `onlineMs`, applied to the series: a
     night offline is blank, not an hour at nothing (todo 06). */
  it('leaves a bin spent away blank, and reads one partly away over its present part', () => {
    const hour = 3_600_000;
    const samples = [at(0, 0), at(8_000, hour), at(8_000, 3 * hour), at(12_000, 4 * hour)];
    // Away for the whole of the second and third hours, back for the fourth.
    const away = [{ from: hour, to: 3 * hour }];
    expect(rateSeries(samples, 0, 4 * hour, 4, away)).toEqual([8_000, null, null, 4_000]);
    // Away for the first half of a bin: the 4,000 made in it were made in its
    // present half, so it reads as 8,000 an hour rather than 4,000.
    const half = [{ from: 3 * hour, to: 3.5 * hour }];
    expect(rateSeries(samples, 3 * hour, 4 * hour, 1, half)).toEqual([8_000]);
  });

  it('keeps one point per slot, the newest current, and drops the oldest past the cap', () => {
    let tally = { ...NO_TALLY, experience: 10 };
    tally = withSample(tally, 1000, 60_000, 3);
    tally = withSample({ ...tally, experience: 25 }, 30_000, 60_000, 3);
    expect(tally.samples).toEqual([at(25, 1000)]);
    tally = withSample({ ...tally, experience: 40 }, 61_000, 60_000, 3);
    tally = withSample({ ...tally, experience: 55 }, 122_000, 60_000, 3);
    tally = withSample({ ...tally, experience: 70 }, 183_000, 60_000, 3);
    expect(tally.samples).toEqual([at(40, 61_000), at(55, 122_000), at(70, 183_000)]);
  });

  it('reads a rate per bin off the samples, and nothing before the first', () => {
    const samples = [at(0, 0), at(3600, 3_600_000), at(3600, 7_200_000)];
    expect(rateSeries(samples, -3_600_000, 7_200_000, 3)).toEqual([null, 3600, 0]);
    expect(experienceAt(samples, -1)).toBeNull();
    expect(experienceAt(samples, 5_000_000)).toBe(3600);
    expect(rateSeries(samples, 10, 10, 4)).toEqual([null, null, null, null]);
  });

  it('carries the samples through a baseline, relative to it', () => {
    const now = {
      ...NO_TALLY,
      since: 0,
      at: 200,
      experience: 50,
      samples: [at(20, 50), at(50, 150)]
    };
    const baseline = { ...now, at: 100, experience: 20, samples: [at(20, 50)] };
    expect(sinceBaseline(now, baseline).samples).toEqual([at(0, 100), at(30, 150)]);
  });
});
