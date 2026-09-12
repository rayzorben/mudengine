import { describe, expect, it } from 'vitest';

import { entityNumber, entityRows } from '../entities';

/*
 * The realm's own row number for a thing, and the one question it raises: a
 * name is not a row. 229 of the shipped realm's 1,514 monster names hold more
 * than one `Monsters` row (up to eight) and 20 of its 1,918 item names hold
 * more than one `Items` row, so *which number is this* has three answers and
 * one of them is "the realm does not say".
 */
describe('the realm’s number for a thing', () => {
  it('is the row a room settled the name to, above everything', () => {
    // The fold's list is what `row` was chosen out of, so it is never the
    // answer where a room has named one.
    expect(entityNumber({ ids: [224, 2204], row: { id: 224 } })).toBe(224);
    expect(entityRows({ ids: [224, 2204], row: { id: 224 } })).toBeNull();
  });

  it('is the one row where the realm places the name once', () => {
    expect(entityNumber({ ids: [2847] })).toBe(2847);
    expect(entityRows({ ids: [2847] })).toBeNull();
  });

  /*
   * The refuse-rather-than-guess rule applied to a figure. `iron key` is
   * three rows, and printing one of their numbers would be the same coin toss
   * `WorldGraph.oneRowNamed` declines to make about a keyed door.
   */
  it('refuses to pick one of several, and says how many there are', () => {
    expect(entityNumber({ ids: [1141, 2175, 2176] })).toBeNull();
    expect(entityRows({ ids: [1141, 2175, 2176] })).toBe(3);
  });

  /*
   * `id` is for the shapes looked up *as a row* rather than as a name — a
   * spell, a race, a class, a room's resident, and each `WorldItem` a
   * reference lookup returns. It is read last, because `ItemEntity` carries
   * both and its `id` is the first of the name's rows.
   */
  it('takes a bare id only where there is no list to read', () => {
    expect(entityNumber({ id: 5825 })).toBe(5825);
    expect(entityNumber({ id: 1141, ids: [1141, 2175] })).toBeNull();
    expect(entityRows({ id: 1141, ids: [1141, 2175] })).toBe(2);
  });

  /* A name the realm has never heard of, which on a derivative is ordinary. */
  it('is nothing at all for a name the realm cannot place', () => {
    expect(entityNumber({})).toBeNull();
    expect(entityRows({})).toBeNull();
    // An empty list is the same absence: the realm knows the name and places
    // it nowhere, which is not a row number either.
    expect(entityNumber({ ids: [] })).toBeNull();
    expect(entityRows({ ids: [] })).toBeNull();
  });

  /* The two are exclusive, so a caller draws one or the other and never both. */
  it('answers exactly one of the two questions', () => {
    for (const of of [
      {},
      { id: 7 },
      { ids: [] },
      { ids: [7] },
      { ids: [7, 8] },
      { ids: [7, 8], row: { id: 8 } }
    ]) {
      const both = entityNumber(of) !== null && entityRows(of) !== null;
      expect(both, JSON.stringify(of)).toBe(false);
    }
  });
});
