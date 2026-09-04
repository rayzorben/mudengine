import { describe, expect, it } from 'vitest';

import {
  compareCells,
  matches,
  narrowed,
  nextSort,
  readSort,
  sortRows,
  terms,
  writeSort,
  type CellValue
} from '../table';

describe('terms', () => {
  it('splits what somebody typed into the words they meant', () => {
    expect(terms('  silk   GLO ')).toEqual(['silk', 'glo']);
  });

  it('is empty for an empty query, which matches everything', () => {
    expect(terms('   ')).toEqual([]);
  });
});

describe('matches', () => {
  const row: CellValue[] = ['padded helm', 40, 'Head'];

  it('finds a partial word', () => {
    expect(matches('hel', row)).toBe(true);
  });

  it('takes every term, from anywhere in the row', () => {
    // The name is in one field and the slot in another: `pad head` is how
    // somebody narrows to the thing they are wearing.
    expect(matches('pad head', row)).toBe(true);
  });

  it('refuses a row that answers only half the query', () => {
    expect(matches('pad feet', row)).toBe(false);
  });

  it('ignores case, because the realm capitalises inconsistently', () => {
    expect(matches('HEAD', row)).toBe(true);
  });

  it('searches figures as well as words', () => {
    expect(matches('40', row)).toBe(true);
  });

  it('matches everything when nothing has been typed', () => {
    expect(matches('', row)).toBe(true);
    expect(matches('   ', [])).toBe(true);
  });

  it('skips a field the realm has no value for rather than matching on it', () => {
    expect(matches('null', ['torch', null])).toBe(false);
  });
});

describe('compareCells', () => {
  it('compares numbers numerically', () => {
    // The failure this exists to prevent: 100 sorting above 20 because `1`
    // sorts before `2`, in the column consulted for what to drop.
    expect(compareCells(100, 20)).toBeGreaterThan(0);
  });

  it('compares words case-insensitively, with embedded figures in order', () => {
    expect(compareCells('scroll 2', 'Scroll 10')).toBeLessThan(0);
  });
});

describe('sortRows', () => {
  interface Item {
    name: string;
    weight: number | null;
  }
  const items: Item[] = [
    { name: 'quarterstaff', weight: 100 },
    { name: 'a healing potion', weight: null },
    { name: 'padded boots', weight: 40 },
    { name: 'sandals', weight: 20 }
  ];
  const value = (item: Item, column: string): CellValue =>
    column === 'weight' ? item.weight : item.name;

  it('leaves the card its own order when nothing is chosen', () => {
    expect(sortRows(items, null, value).map((item) => item.name)).toEqual(
      items.map((item) => item.name)
    );
  });

  it('sorts ascending and descending', () => {
    expect(sortRows(items, { column: 'weight', direction: 'ascending' }, value)[0]?.name).toBe(
      'sandals'
    );
    expect(sortRows(items, { column: 'weight', direction: 'descending' }, value)[0]?.name).toBe(
      'quarterstaff'
    );
  });

  it('puts a value the realm does not have last, whichever way the column points', () => {
    for (const direction of ['ascending', 'descending'] as const) {
      const sorted = sortRows(items, { column: 'weight', direction }, value);
      expect(sorted[sorted.length - 1]?.name).toBe('a healing potion');
    }
  });

  it('keeps the card order between rows the column cannot separate', () => {
    const tied = [
      { name: 'b', weight: 5 },
      { name: 'a', weight: 5 }
    ];
    expect(
      sortRows(tied, { column: 'weight', direction: 'ascending' }, value).map((item) => item.name)
    ).toEqual(['b', 'a']);
  });

  it('does not disturb what it was given', () => {
    const before = [...items];
    sortRows(items, { column: 'weight', direction: 'descending' }, value);
    expect(items).toEqual(before);
  });
});

describe('nextSort', () => {
  it('goes up, then down, then back to the card own order', () => {
    const up = nextSort(null, 'weight');
    expect(up).toEqual({ column: 'weight', direction: 'ascending' });
    const down = nextSort(up, 'weight');
    expect(down).toEqual({ column: 'weight', direction: 'descending' });
    expect(nextSort(down, 'weight')).toBeNull();
  });

  it('starts a different column ascending rather than inheriting the other way', () => {
    expect(nextSort({ column: 'weight', direction: 'descending' }, 'name')).toEqual({
      column: 'name',
      direction: 'ascending'
    });
  });
});

describe('a remembered sort', () => {
  it('survives a round trip', () => {
    const sort = { column: 'weight', direction: 'descending' } as const;
    expect(readSort(writeSort(sort), ['name', 'weight'])).toEqual(sort);
    expect(readSort(writeSort(null), ['name', 'weight'])).toBeNull();
  });

  it('is dropped when the column it names is gone', () => {
    // A table pointed at a column an older build had is a table pointed at
    // nothing, which is the same failure the remembered filters avoid.
    expect(readSort('kind:up', ['name', 'weight'])).toBeNull();
    expect(readSort('weight:sideways', ['name', 'weight'])).toBeNull();
    expect(readSort('', ['name', 'weight'])).toBeNull();
  });
});

describe('narrowed', () => {
  it('says nothing while everything is shown', () => {
    expect(narrowed(40, 40)).toBeNull();
  });

  it('states both figures the moment anything is hidden', () => {
    expect(narrowed(3, 40)).toBe('3 of 40');
    // Including nothing at all: an empty table with a filter set has to say
    // why it is empty, or it is a card lying about what is carried.
    expect(narrowed(0, 40)).toBe('0 of 40');
  });
});
