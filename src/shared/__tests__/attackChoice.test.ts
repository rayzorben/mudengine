import { describe, expect, it } from 'vitest';

import { chooseAttack } from '../attackChoice';
import type { AttackOption } from '../attackOptions';

const option = (verb: string, value: number | null): AttackOption => ({
  verb,
  kind: verb === 'a' ? 'attack' : verb === 'pu' ? 'punch' : 'jumpkick',
  perRound: value === null ? null : { value, from: 'bound' }
});

describe('chooseAttack', () => {
  it('keeps a typed verb whatever the figures say', () => {
    expect(chooseAttack(' kic ', [option('a', 10), option('pu', 30)])).toEqual({
      verb: 'kic',
      why: 'typed',
      perRound: null
    });
  });

  it('takes the round that lands the most', () => {
    expect(chooseAttack('', [option('a', 10), option('pu', 35), option('ju', 20)])).toEqual({
      verb: 'pu',
      why: 'best',
      perRound: 35
    });
  });

  it('keeps the plain attack on a draw and skips an unpriced round', () => {
    expect(chooseAttack('', [option('a', 20), option('pu', 20), option('ju', null)]).verb).toBe(
      'a'
    );
  });

  it('is the plain attack when nothing is priced', () => {
    expect(chooseAttack('', [option('a', null), option('pu', null)])).toEqual({
      verb: 'a',
      why: 'unpriced',
      perRound: null
    });
  });
});
