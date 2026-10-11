import { describe, expect, it } from 'vitest';

import { asCashRunAsk } from '../cashRun';

const ASK = { loop: 'Crimson Fort Loop', coins: ['gold'], tokens: [3381], full: 'heavy' };

describe('the cash run dialog ask', () => {
  it('takes an ask that says whether to sell on the way', () => {
    expect(asCashRunAsk({ ...ASK, sell: true })).toEqual({ ...ASK, sell: true });
  });

  it('refuses an ask without a yes or no for selling', () => {
    expect(asCashRunAsk(ASK)).toBeNull();
    expect(asCashRunAsk({ ...ASK, sell: 'yes' })).toBeNull();
  });
});
