import { describe, expect, it } from 'vitest';

import { ALIGNMENTS, alignmentRank, isHostile } from '../alignment';

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
    expect(ALIGNMENTS.filter((word) => alignmentRank(word) !== null)).toEqual([
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
   * **`Lawful` has no rank, and that is the point.** `src/shared/mobs.ts`
   * settled it for `ALIGNMENT_RANGE` first: the word is in this client's union
   * and in the `who` pattern, `GetAlignmentTitle` does not produce it, so there
   * is no band to place it in. Ranked, it would sit somewhere near `Good` and a
   * character on a derivative realm whose roster row says `Lawful` would be
   * **pruned** from `Alignment: Neutral to Fiend` — a confident refusal built on
   * an order nobody has read. Unranked, that gate reads as unevaluable, which
   * the router discourages and never prunes.
   */
  it('refuses to rank a word the server’s enum does not have', () => {
    expect(alignmentRank('Lawful')).toBeNull();
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
