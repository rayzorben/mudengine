import { describe, expect, it } from 'vitest';

import {
  candidatesHere,
  candidatesOf,
  handsFor,
  jobCommand,
  jobOdds,
  partyTraps,
  unknownPickers,
  walkersThrough,
  type Candidate
} from '../barrierHands';
import { EMPTY_CHARACTER, type CharacterState, type PartyMember } from '../character';
import type { Requirement } from '../world';

const lock = (over: Partial<Requirement>): Requirement => ({ kind: 'door', raw: '', ...over });

const hand = (
  name: string,
  over: Partial<Candidate['sheet']>,
  hp: number | null = 500
): Candidate => ({
  name,
  self: false,
  sheet: { strength: null, traps: null, picklocks: null, ...over },
  hp
});

/* Todo 86: who in the party goes at a trap or a locked door. */
describe('the odds of one try', () => {
  it('reads Traps as the disarm percentage (`TrapExit.TryDisarm`)', () => {
    expect(jobOdds('disarm', { strength: null, traps: 75, picklocks: null }, null)).toBe(0.75);
    expect(jobOdds('disarm', { strength: null, traps: null, picklocks: null }, null)).toBeNull();
  });

  it('rolls a pick as `Picklocks − figure ≥ rand(0,100)`, and never on 0 Picklocks', () => {
    expect(
      jobOdds('pick', { strength: null, traps: null, picklocks: 80 }, lock({ pickDifficulty: 30 }))
    ).toBeCloseTo(51 / 101);
    expect(
      jobOdds('pick', { strength: null, traps: null, picklocks: 0 }, lock({ pickDifficulty: 0 }))
    ).toBe(0);
    // `[or 157 picklocks]` says nothing about strength: that channel is shut.
    expect(
      jobOdds(
        'bash',
        { strength: 200, traps: null, picklocks: null },
        lock({ pickDifficulty: 157 })
      )
    ).toBe(0);
  });

  it('takes a door with no figure as a plain door', () => {
    expect(jobOdds('bash', { strength: 50, traps: null, picklocks: null }, null)).toBeCloseTo(
      51 / 101
    );
  });
});

describe('who goes', () => {
  it('ranks the best odds first, this character ahead of a member at the same odds', () => {
    const me: Candidate = { ...hand('Vaelor', { traps: 40 }), self: true };
    const hands = handsFor('disarm', null, 100, [
      me,
      hand('Rand', { traps: 70 }),
      hand('Soul', { traps: 40 })
    ]);
    expect(hands.map((entry) => entry.name)).toEqual(['Rand', 'Vaelor', 'Soul']);
  });

  it('asks nobody a failed disarm would kill, or whose hit points are unknown', () => {
    const hands = handsFor('disarm', null, 400, [
      hand('Rand', { traps: 90 }, 300),
      hand('Soul', { traps: 90 }, null),
      hand('Yang', { traps: 50 }, 600)
    ]);
    expect(hands.map((entry) => entry.name)).toEqual(['Yang']);
  });

  it('leaves out a member whose figure is unknown, as a MegaMUD member is', () => {
    expect(handsFor('pick', lock({ pickDifficulty: 10 }), null, [hand('Rand', {})])).toEqual([]);
  });

  it('reads a member’s sheet and absolute hit points off the party record', () => {
    const member: PartyMember = {
      name: 'Rand',
      className: 'Thief',
      health: 1,
      mana: null,
      rank: null,
      activity: null,
      invited: false,
      vitals: { hp: 220, hpMax: 220, mana: null, manaMax: null },
      sheet: { strength: 60, level: 12, traps: 55, picklocks: 70 }
    };
    const state: CharacterState = {
      ...structuredClone(EMPTY_CHARACTER),
      name: 'Vaelor',
      party: { ...EMPTY_CHARACTER.party, members: [member] }
    };
    expect(candidatesOf(state)[1]).toEqual({
      name: 'Rand',
      self: false,
      sheet: { strength: 60, traps: 55, picklocks: 70 },
      hp: 220
    });
  });
});

describe('the party a leader sends from', () => {
  const rand: PartyMember = {
    name: 'Rand',
    className: 'Thief',
    health: 1,
    mana: null,
    rank: null,
    activity: null,
    invited: false,
    vitals: null,
    sheet: { strength: 60, level: 12, traps: 70, picklocks: 70 }
  };
  const soul: PartyMember = { ...rand, name: 'Soul', sheet: null };
  const leading = (following: string | null = null): CharacterState => {
    const state = structuredClone(EMPTY_CHARACTER);
    state.name = 'Vaelor';
    state.progress = { ...state.progress, traps: 30 };
    state.room = { ...state.room, occupants: [{ name: 'Rand' } as never] };
    state.party = { ...state.party, following, members: [rand, soul] };
    return state;
  };

  it('sends only the members standing here', () => {
    expect(candidatesHere(leading()).map((entry) => entry.name)).toEqual(['Vaelor', 'Rand']);
  });

  it('counts the party walking a trap, leading, and the best Traps among it', () => {
    expect(walkersThrough(leading())).toBe(3);
    expect(partyTraps(leading())).toBe(70);
    expect(walkersThrough(leading('Rand'))).toBe(1);
    expect(partyTraps(leading('Rand'))).toBe(30);
  });

  it('offers a member with no sheet for a pick after the known', () => {
    expect(unknownPickers(candidatesOf(leading()))).toEqual(['Soul']);
  });

  /* `Door.TryPickLock` needs the sum over 0 before it rolls. */
  it('gives a pick at exactly the figure no chance, and a key-only door none', () => {
    const sheet = { strength: 90, traps: null, picklocks: 30 };
    expect(jobOdds('pick', sheet, lock({ pickDifficulty: 30 }))).toBe(0);
    expect(jobOdds('pick', sheet, lock({ keyId: 7 }))).toBe(0);
    expect(jobOdds('bash', sheet, lock({ keyId: 7 }))).toBe(0);
  });

  it('spells each job as the server reads it', () => {
    expect(jobCommand('disarm', 'ne')).toBe('disarm trap ne');
    expect(jobCommand('pick', 'ne')).toBe('pi ne');
    expect(jobCommand('bash', 'ne')).toBe('bas ne');
  });
});
