import { describe, expect, it } from 'vitest';

import { restSpellWorth, type RestSpellFigures } from '../restspell';

const figures = (over: Partial<RestSpellFigures> = {}): RestSpellFigures => ({
  need: 60,
  restTick: 3,
  restTickWith: 6,
  lastsSeconds: 300,
  restTickSeconds: 15,
  passiveTickSeconds: 30,
  cost: 8,
  manaTick: 4,
  ...over
});

describe('whether a regeneration spell pays for itself before a rest', () => {
  it('casts when the rest time saved is more than the mana takes to come back', () => {
    // 20 rest ticks bare, 10 with it up: 150 s saved against two passive ticks.
    expect(restSpellWorth(figures())).toEqual({ kind: 'cast', savedSeconds: 150 });
  });

  it('counts only the ticks the spell is up', () => {
    // Up for two ticks (12 hit points), the other 48 at 3 a tick: 18 ticks, two saved.
    expect(restSpellWorth(figures({ lastsSeconds: 30, manaTick: null }))).toEqual({
      kind: 'cast',
      savedSeconds: 30
    });
  });

  it('refuses a spell that does not shorten the rest', () => {
    expect(restSpellWorth(figures({ restTickWith: 3 })).kind).toBe('saves-nothing');
    expect(restSpellWorth(figures({ need: 0 })).kind).toBe('saves-nothing');
  });

  it('refuses a spell whose mana takes longer to come back than the rest time it saves', () => {
    expect(restSpellWorth(figures({ cost: 100, manaTick: 2 }))).toEqual({
      kind: 'costs-more',
      savedSeconds: 150,
      paybackSeconds: 1500
    });
  });

  it('casts the named spell unweighed where the regeneration cannot be figured', () => {
    expect(restSpellWorth(figures({ restTick: null }))).toEqual({
      kind: 'cast',
      savedSeconds: null
    });
    expect(restSpellWorth(figures({ manaTick: null }))).toEqual({
      kind: 'cast',
      savedSeconds: 150
    });
  });
});
