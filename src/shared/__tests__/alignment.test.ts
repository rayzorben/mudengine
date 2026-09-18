import { describe, expect, it } from 'vitest';

import { ALIGNMENTS, alignmentRank, asAlignment, isHostile } from '../alignment';

/*
 * `ALIGNMENT_SCALE` exists because the router had to price
 * `Alignment: Saint to Seedy` (todo 00, 2026-09-06), and a range cannot be
 * compared without an order. It is a second list rather than a reading of
 * `ALIGNMENTS`, whose order is incidental and whose job is membership.
 */
describe('the standing scale', () => {
  /*
   * `GreaterMUD.Module/Player.cs`'s `Alignment` enum, in its own order — a
   * reading of the source rather than a capture.
   */
  it('runs in the server’s own order', () => {
    const ranked = ALIGNMENTS.filter((word) => alignmentRank(word) !== null)
      .slice()
      .sort((a, b) => alignmentRank(a)! - alignmentRank(b)!);
    expect([...new Set(ranked.map((word) => alignmentRank(word)))]).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7
    ]);
    expect(ranked.filter((word) => word !== 'Lawful')).toEqual([
      'Saint',
      'Good',
      'Neutral',
      'Seedy',
      'Outlaw',
      'Criminal',
      'Villain',
      'FIEND'
    ]);
  });

  /*
   * **`Lawful` ranks with `Saint`, because it is that rung under another
   * realm's name** (2026-09-17). It was unranked while `ALIGNMENT_RANGE` had
   * no band for it, on the grounds that a rank invented near `Good` would
   * **prune** a Lawful character from `Alignment: Neutral to Fiend` on an
   * order nobody had read. The capture that settled the band settled the rank
   * with it — MajorMUD prints `Lawful` where GreaterMUD prints `Saint`, eight
   * rungs each, and neither ladder has both — so the exclusion is now the
   * realm's own and not this client's invention. An alias, not a ninth rung:
   * the word survives `asAlignment` so a realm that writes it is answered in
   * its own spelling.
   */
  it('ranks Lawful with Saint and keeps the word', () => {
    expect(alignmentRank('Lawful')).toBe(alignmentRank('Saint'));
    expect(asAlignment('Lawful')).toBe('Lawful');
    expect(ALIGNMENTS).toContain('Lawful');
  });

  /*
   * The realm's exit instruction writes `Fiend` where the roster writes
   * `FIEND`. One word, two spellings, and the comparison has to survive both
   * or a gate reads as unreadable.
   */
  it('reads the realm’s spelling and the roster’s as one word', () => {
    expect(alignmentRank('Fiend')).toBe(alignmentRank('FIEND'));
    expect(alignmentRank('  saint ')).toBe(alignmentRank('Saint'));
  });

  it('says nothing about a word neither names', () => {
    expect(alignmentRank('Sinner')).toBeNull();
    expect(alignmentRank('')).toBeNull();
    expect(alignmentRank('   ')).toBeNull();
  });

  /* The ranks order the way the scale claims: better behaved is lower. */
  it('puts the hostile end above the harmless one', () => {
    expect(alignmentRank('Saint')!).toBeLessThan(alignmentRank('Neutral')!);
    expect(alignmentRank('Neutral')!).toBeLessThan(alignmentRank('Outlaw')!);
    expect(alignmentRank('Outlaw')!).toBeLessThan(alignmentRank('FIEND')!);
    // And every hostile word outranks every harmless one it can be compared
    // with, which is the claim `isHostile` makes without saying so.
    const ranked = ALIGNMENTS.filter((word) => alignmentRank(word) !== null);
    const hostile = ranked.filter((word) => isHostile(word));
    expect(hostile).toEqual(ranked.slice(ranked.length - hostile.length));
  });
});
