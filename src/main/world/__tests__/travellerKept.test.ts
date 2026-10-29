import { describe, expect, it } from 'vitest';

import { sameTraveller, TravellerKept } from '../travellerKept';

describe('travellers equal in value', () => {
  const danger = (): number => 0;

  it('are the same whatever object each route built', () => {
    const one = {
      level: 20,
      keys: [3, 4],
      opened: new Set(['1/2 n']),
      keepOut: { words: ['vortex'], allowed: [] },
      counters: { sums: { 204: 1 }, complete: true },
      danger
    };
    expect(sameTraveller(one, { ...one, keys: [3, 4], opened: new Set(['1/2 n']) })).toBe(true);
    expect(sameTraveller(one, { ...one, shunned: undefined })).toBe(true);
    expect(sameTraveller({ ...one, shunned: undefined }, one)).toBe(true);
  });

  it('differ by a level, a key, a word, a counter or a fresh closure', () => {
    const one = { level: 20, keys: [3], keepOut: { words: ['vortex'] }, danger };
    expect(sameTraveller(one, { ...one, level: 21 })).toBe(false);
    expect(sameTraveller(one, { ...one, keys: [3, 4] })).toBe(false);
    expect(sameTraveller(one, { ...one, keepOut: { words: ['plane'] } })).toBe(false);
    expect(sameTraveller(one, { ...one, danger: () => 0 })).toBe(false);
    expect(sameTraveller(one, { ...one, shunned: new Set(['1/1']) })).toBe(false);
    expect(
      sameTraveller({ counters: { sums: { 204: 1 } } }, { counters: { sums: { 204: 2 } } })
    ).toBe(false);
  });
});

describe('answers kept per traveller', () => {
  it('keeps the newest few and hands back the one asked for', () => {
    const kept = new TravellerKept<string, { level: number }, string>(
      () => 2,
      () => 0
    );
    kept.set('a', { level: 1 }, 'one');
    kept.set('a', { level: 2 }, 'two');
    expect(kept.get('a', { level: 1 })).toBe('one');
    kept.set('b', { level: 1 }, 'three');
    // `level: 2` was the oldest once `level: 1` was asked again.
    expect(kept.get('a', { level: 2 })).toBeUndefined();
    expect(kept.get('a', { level: 1 })).toBe('one');
    expect(kept.get('b', { level: 1 })).toBe('three');
  });

  it('drops every answer when the tuning behind them is replaced', () => {
    let generation = {};
    const kept = new TravellerKept<string, { level: number }, string>(
      () => 4,
      () => generation
    );
    kept.set('a', { level: 1 }, 'one');
    expect(kept.get('a', { level: 1 })).toBe('one');
    generation = {};
    expect(kept.get('a', { level: 1 })).toBeUndefined();
  });

  it('keeps the collections as they were, not as the caller goes on filling them', () => {
    const kept = new TravellerKept<string, { refused: Set<string> }, string>(
      () => 4,
      () => 0
    );
    const refused = new Set(['1/1 n']);
    kept.set('a', { refused }, 'one');
    refused.add('1/2 s');
    expect(kept.get('a', { refused })).toBeUndefined();
    expect(kept.get('a', { refused: new Set(['1/1 n']) })).toBe('one');
  });
});
