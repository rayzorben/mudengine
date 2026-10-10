import { describe, expect, it } from 'vitest';

import { matchVisits, rememberVisit, type VisitedDestination } from '../destinations';

const row = (id: string, name: string, at: number, visits = 1): VisitedDestination => ({
  id,
  name,
  at,
  visits
});

describe('rememberVisit', () => {
  it('puts the newest visit first', () => {
    const list = rememberVisit([row('1/2', 'Bank of Godfrey', 100)], {
      id: '1/9',
      name: 'Forest Cavern',
      at: 200
    });
    expect(list.map((entry) => entry.name)).toEqual(['Forest Cavern', 'Bank of Godfrey']);
  });

  /*
   * The whole point of the list: a place walked to twice is one row that moved,
   * not two rows. A list that grew per walk would be five places repeated, and
   * the cap would then evict everything that made it worth searching.
   */
  it('moves a repeat visit rather than adding a second row', () => {
    const before = [row('1/2', 'Bank of Godfrey', 100), row('1/9', 'Forest Cavern', 200)];
    const after = rememberVisit(before, { id: '1/2', name: 'Bank of Godfrey', at: 300 });
    expect(after).toHaveLength(2);
    expect(after[0]!.id).toBe('1/2');
    expect(after[0]!.visits).toBe(2);
  });

  /*
   * A stamp earlier than one already held must not claim the top. Two windows
   * on one realm, or a clock that moved, and an unshifted list would say the
   * older walk was the most recent.
   */
  it('orders by the stamp, not by the order of arrival', () => {
    const after = rememberVisit([row('1/9', 'Forest Cavern', 500)], {
      id: '1/2',
      name: 'Bank of Godfrey',
      at: 100
    });
    expect(after.map((entry) => entry.name)).toEqual(['Forest Cavern', 'Bank of Godfrey']);
  });

  /* A room walked to once, long ago, still outranks its namesakes nobody visited. */
  it('keeps every room it was given', () => {
    let list: VisitedDestination[] = [];
    for (let n = 0; n < 600; n += 1) {
      list = rememberVisit(list, { id: `1/${n}`, name: `Room ${n}`, at: n });
    }
    expect(list).toHaveLength(600);
    expect(list.at(-1)!.id).toBe('1/0');
  });

  /*
   * A row with no id can never be walked back to and a nameless one can never
   * be matched, so neither is a destination. Recording one would put a row in
   * the list that no query reaches and no click can use.
   */
  it('refuses a visit missing either half', () => {
    const before = [row('1/2', 'Bank of Godfrey', 100)];
    expect(rememberVisit(before, { id: '', name: 'Nowhere', at: 200 })).toEqual(before);
    expect(rememberVisit(before, { id: '1/3', name: '   ', at: 200 })).toEqual(before);
  });
});

describe('matchVisits', () => {
  const list = [
    row('1/9', 'Forest Cavern', 300),
    row('1/2', 'Bank of Godfrey', 200),
    row('1/7', 'Darkwood Forest', 100)
  ];

  it('matches anywhere in the name, newest first', () => {
    expect(matchVisits(list, 'forest', 5).map((entry) => entry.name)).toEqual([
      'Forest Cavern',
      'Darkwood Forest'
    ]);
  });

  /* The card tables' own rule: every term, from anywhere in the row. */
  it('requires every term of a two-word query', () => {
    expect(matchVisits(list, 'bank god', 5).map((entry) => entry.name)).toEqual([
      'Bank of Godfrey'
    ]);
    expect(matchVisits(list, 'bank forest', 5)).toEqual([]);
  });

  it('takes no more than it is asked for', () => {
    expect(matchVisits(list, 'forest', 1).map((entry) => entry.name)).toEqual(['Forest Cavern']);
  });

  /* Before anything is typed the route panel offers the latest few (user, 2026-10-10). */
  it('answers the latest for an empty query', () => {
    expect(matchVisits(list, '   ', 2).map((entry) => entry.name)).toEqual([
      'Forest Cavern',
      'Bank of Godfrey'
    ]);
  });
});
