import { describe, expect, it } from 'vitest';

import { normalizeSupplies } from '../packConfig';
import { withSupply } from '../supplies';

// Todo 20261024-1810-01: a row collected only where it is found, and one done once found.
describe('a supplies row that is only collected', () => {
  it('reads buy and done once found, each off by its default', () => {
    const [plain, collected] = normalizeSupplies({
      items: [
        { name: 'torch', min: 3, max: 7 },
        { name: 'black star key', min: 4, max: 0, buy: false, doneOnFound: true }
      ]
    }).items;
    expect(plain).toMatchObject({ buy: true, doneOnFound: false, min: 3, max: 7 });
    // No minimum, and at least one collected.
    expect(collected).toMatchObject({ buy: false, doneOnFound: true, min: 0, max: 1 });
  });

  it('falls back to the default for a switch that is not a boolean', () => {
    const [row] = normalizeSupplies({
      items: [{ name: 'torch', min: 1, max: 2, buy: 'no', doneOnFound: 3 }]
    }).items;
    expect(row).toMatchObject({ buy: true, doneOnFound: false });
  });

  it('is kept on the list with no minimum and no shop', () => {
    const row = {
      name: 'skull',
      min: 0,
      max: 0,
      shop: '',
      at: null,
      buy: false,
      doneOnFound: false
    };
    expect(withSupply([], 'skull', row)).toEqual([{ ...row, max: 1 }]);
    expect(withSupply([], 'skull', { ...row, buy: true })).toEqual([]);
  });
});
