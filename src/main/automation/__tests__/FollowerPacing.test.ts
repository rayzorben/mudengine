import { describe, expect, it } from 'vitest';

import { FollowerPacing } from '../FollowerPacing';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, partyMember, type CharacterState } from '../../../shared/character';

const config: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  remotes: { ...DEFAULT_CONFIG.automation.remotes, enabled: true }
};

function state(following: string | null, held: 'yes' | 'no'): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    party: { ...base.party, following },
    afflictions: { ...base.afflictions, held }
  };
}

function pacing(): { told: string[]; pacing: FollowerPacing } {
  const told: string[] = [];
  const pacing = new FollowerPacing(config, {
    tell: (leader, name) => told.push(`${leader} @${name}`)
  });
  return { told, pacing };
}

/*
 * Brakkle, 2026-11-04: webbed, dropped from Rayzor's party while held, and
 * the hold ended before he was invited back. The `@ok` had no leader to go
 * to and was never sent, so Rayzor waited out its whole limit.
 */
describe('an @ok whose wait ended out of the party', () => {
  it('is sent to the leader on following again', () => {
    const { told, pacing: p } = pacing();
    p.onCharacter(state('Rayzor', 'yes'));
    expect(told).toEqual(['Rayzor @wait', 'Rayzor @held']);
    p.onCharacter(state(null, 'yes'));
    p.onCharacter(state(null, 'no'));
    expect(told).toHaveLength(2);
    p.onCharacter(state('Rayzor', 'no'));
    expect(told).toEqual(['Rayzor @wait', 'Rayzor @held', 'Rayzor @ok']);
    p.onCharacter(state('Rayzor', 'no'));
    expect(told).toHaveLength(3);
  });

  it('is not sent while a new hold stands, and is once it ends', () => {
    const { told, pacing: p } = pacing();
    p.onCharacter(state('Rayzor', 'yes'));
    p.onCharacter(state(null, 'no'));
    p.onCharacter(state(null, 'yes'));
    p.onCharacter(state('Rayzor', 'yes'));
    expect(told).toEqual(['Rayzor @wait', 'Rayzor @held']);
    // Positive control: the same character, freed while following, says `@ok`.
    p.onCharacter(state('Rayzor', 'no'));
    expect(told).toEqual(['Rayzor @wait', 'Rayzor @held', 'Rayzor @ok']);
  });
});

describe('an @ok while the leader rests', () => {
  const withLeaderResting = (held: 'yes' | 'no'): CharacterState => {
    const s = state('Bemir', held);
    return {
      ...s,
      party: {
        ...s.party,
        members: [partyMember('Bemir', { activity: { state: 'resting' } })]
      }
    };
  };

  it('is sent the moment the hold ends, as the leader rests', () => {
    const { told, pacing: p } = pacing();
    p.onCharacter(state('Bemir', 'yes'));
    expect(told).toEqual(['Bemir @wait', 'Bemir @held']);
    p.onCharacter(withLeaderResting('yes'));
    expect(told).toHaveLength(2);
    p.onCharacter(withLeaderResting('no'));
    expect(told).toEqual(['Bemir @wait', 'Bemir @held', 'Bemir @ok']);
  });

  it('is not sent for a low vital, which waits for the leader to get up', () => {
    const { told, pacing: p } = pacing();
    const vitals = (hp: number): CharacterState['vitals'] => ({
      ...EMPTY_CHARACTER.vitals,
      hp,
      hpMax: 100
    });
    p.onCharacter({ ...state('Bemir', 'no'), vitals: vitals(1) });
    expect(told).toEqual(['Bemir @wait']);
    p.onCharacter({ ...withLeaderResting('no'), vitals: vitals(100) });
    expect(told).toEqual(['Bemir @wait']);
    // Positive control: the leader up, the same character says `@ok`.
    p.onCharacter({ ...state('Bemir', 'no'), vitals: vitals(100) });
    expect(told).toEqual(['Bemir @wait', 'Bemir @ok']);
  });
});

describe('an @ok nobody was told to wait for', () => {
  it('is not sent to a leader followed after a rest alone', () => {
    const { told, pacing: p } = pacing();
    const resting = (following: string | null): CharacterState => ({
      ...state(following, 'no'),
      vitals: { ...EMPTY_CHARACTER.vitals, hp: 1, hpMax: 100 }
    });
    p.onCharacter(resting(null));
    p.onCharacter(state(null, 'no'));
    p.onCharacter(state('Rayzor', 'no'));
    expect(told).toEqual([]);
    // Positive control: held while following Rayzor, the same instance does tell him.
    p.onCharacter(state('Rayzor', 'yes'));
    expect(told).toEqual(['Rayzor @wait', 'Rayzor @held']);
  });

  it('goes only to the leader told the wait', () => {
    const { told, pacing: p } = pacing();
    p.onCharacter(state('Rayzor', 'yes'));
    p.onCharacter(state(null, 'no'));
    p.onCharacter(state('Soul', 'no'));
    expect(told).toEqual(['Rayzor @wait', 'Rayzor @held']);
    p.onCharacter(state('Rayzor', 'no'));
    expect(told).toEqual(['Rayzor @wait', 'Rayzor @held', 'Rayzor @ok']);
  });
});
