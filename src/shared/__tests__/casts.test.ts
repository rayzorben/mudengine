import { describe, expect, it } from 'vitest';

import { castEffect } from '../casts';

/* The spellings are the captures': 003, 048, 004, and 060 for the bare cast. */
describe("a cast's effect", () => {
  it('reads a heal from either word round its amount', () => {
    expect(castEffect({ kind: 'for', amount: '20', effect: 'healing' })).toBe('heal');
    expect(castEffect({ kind: 'healing', amount: '16', effect: 'damage' })).toBe('heal');
    expect(castEffect({ kind: 'regenerating', amount: '19', effect: 'damage' })).toBe('heal');
  });

  it('reads damage only where both words say so', () => {
    expect(castEffect({ kind: 'for', amount: '6', effect: 'damage' })).toBe('harm');
  });

  it('reads a cast with no amount as a heal only where the realm row heals', () => {
    expect(
      castEffect({ caster: 'Eagle', spell: 'greater healing', target: 'you', heals: 'yes' })
    ).toBe('heal');
    expect(castEffect({ caster: 'Eagle', spell: 'bless', target: 'you' })).toBeNull();
  });
});
