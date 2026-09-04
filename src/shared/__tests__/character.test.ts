import { describe, expect, it } from 'vitest';

import {
  EMPTY_CHARACTER,
  joinedTheParty,
  ratio,
  vitalLevel,
  type CharacterState,
  type PartyMember,
  type VitalThresholds
} from '../character';

const HALF_AND_QUARTER: VitalThresholds = { caution: 0.5, critical: 0.25 };

describe('ratio', () => {
  it('is null when either side is unknown', () => {
    expect(ratio(null, 100)).toBeNull();
    expect(ratio(50, null)).toBeNull();
  });

  it('refuses to divide by a zero or negative maximum', () => {
    expect(ratio(50, 0)).toBeNull();
    expect(ratio(50, -10)).toBeNull();
  });

  it('clamps overheal rather than reporting more than a full bar', () => {
    expect(ratio(120, 100)).toBe(1);
  });
});

describe('vitalLevel', () => {
  it('scales with the maximum rather than with a number of points', () => {
    // The same proportion at wildly different levels is the same level of
    // trouble. A fixed point threshold — `megamind-client`'s `health < 25` —
    // is "nearly dead" at level one and "a scratch" at level fifty.
    expect(vitalLevel(7, 30, HALF_AND_QUARTER)).toBe('critical');
    expect(vitalLevel(700, 3000, HALF_AND_QUARTER)).toBe('critical');
    expect(vitalLevel(25, 30, HALF_AND_QUARTER)).toBe('ok');
    expect(vitalLevel(2500, 3000, HALF_AND_QUARTER)).toBe('ok');
  });

  it('treats a threshold as inclusive, because that is how a player reads it', () => {
    expect(vitalLevel(25, 100, HALF_AND_QUARTER)).toBe('critical');
    expect(vitalLevel(50, 100, HALF_AND_QUARTER)).toBe('caution');
    expect(vitalLevel(51, 100, HALF_AND_QUARTER)).toBe('ok');
  });

  it('reports unknown, never critical, when the maximum has not been seen', () => {
    // The status line carries no maxima until the stat sheet has arrived. A bar
    // painted red because a number has not turned up yet is a lie, and it is
    // the specific lie that would make a player run from a fight they were winning.
    expect(vitalLevel(120, null, HALF_AND_QUARTER)).toBe('unknown');
    expect(vitalLevel(null, 300, HALF_AND_QUARTER)).toBe('unknown');
    expect(vitalLevel(null, null, HALF_AND_QUARTER)).toBe('unknown');
  });

  it('reports a class with no mana as unknown rather than empty', () => {
    expect(vitalLevel(null, null, HALF_AND_QUARTER)).toBe('unknown');
  });

  it('is critical at zero, which is the one time it certainly matters', () => {
    expect(vitalLevel(0, 300, HALF_AND_QUARTER)).toBe('critical');
  });

  it('takes the more urgent reading when thresholds are inverted', () => {
    // Config clamps this, but a caller passing literals should still not be
    // told a 10% bar is merely cautious.
    expect(vitalLevel(10, 100, { caution: 0.25, critical: 0.5 })).toBe('critical');
  });
});

describe('joinedTheParty', () => {
  const member = (name: string, invited = false): PartyMember => ({
    name,
    className: null,
    health: 1,
    mana: null,
    rank: null,
    activity: null,
    invited,
    vitals: null
  });

  const withParty = (...members: PartyMember[]): CharacterState => ({
    ...EMPTY_CHARACTER,
    party: { ...EMPTY_CHARACTER.party, members }
  });

  it('is true for somebody the listing names', () => {
    expect(joinedTheParty(withParty(member('Vaelor'), member('Soul')), 'Soul')).toBe(true);
  });

  it('ignores case and surrounding space, because the server is inconsistent about both', () => {
    expect(joinedTheParty(withParty(member('Soul')), '  soul ')).toBe(true);
  });

  /*
   * The safety property, and the whole reason the old `party` permission
   * ground was retired: an invitation is an offer nobody accepted, so if it
   * counted, `invite` would be the gesture by which anybody handed themselves
   * this character's party remotes.
   */
  it('is false for an outstanding invitation', () => {
    expect(joinedTheParty(withParty(member('Vaelor'), member('Rend', true)), 'Rend')).toBe(false);
  });

  it('is false with no party, for an unnamed asker, and for an empty name', () => {
    expect(joinedTheParty(EMPTY_CHARACTER, 'Rend')).toBe(false);
    expect(joinedTheParty(withParty(member('Soul')), null)).toBe(false);
    expect(joinedTheParty(withParty(member('Soul')), '   ')).toBe(false);
  });
});
