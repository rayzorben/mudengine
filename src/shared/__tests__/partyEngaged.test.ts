import { describe, expect, it } from 'vitest';

import { freshSighting, partyFightHere } from '../partyEngaged';
import { EMPTY_CHARACTER, type CharacterState, type Party, type RoomOccupant } from '../character';
import { classifyOccupant } from '../mobs';

const mobNamed = (name: string): RoomOccupant =>
  classifyOccupant(name, {
    players: new Set<string>(),
    mob: () => ({ disposition: 'hostile', uncertain: false, costly: 'never' })
  });

const FRESH = 60_000;
const NOW = 1_000_000;
const killa = {
  name: 'Killa',
  className: null,
  health: 1,
  mana: null,
  rank: null,
  activity: null,
  invited: false,
  vitals: null,
  sheet: null
};

function standing(party: Partial<Party>, occupants = ['small blood skeleton']): CharacterState {
  const state = structuredClone(EMPTY_CHARACTER);
  return {
    ...state,
    name: 'Festus',
    room: { ...state.room, occupants: occupants.map(mobNamed) },
    party: { following: null, members: [killa], engaged: {}, threatened: {}, ...party }
  };
}

// Todo 20261023-1951-01: the leader's walk and the follower's assist read one rule.
describe('the party fighting here', () => {
  const swinging = { Killa: { kind: 'mob' as const, target: 'small blood skeleton', at: NOW } };

  it('is a fresh blow at a monster still listed, leading', () => {
    expect(partyFightHere(standing({ engaged: swinging }), NOW, FRESH, false)).toBe(true);
    expect(partyFightHere(standing({ engaged: swinging }, []), NOW, FRESH, false)).toBe(false);
    expect(partyFightHere(standing({ engaged: swinging }), NOW + FRESH + 1, FRESH, false)).toBe(
      false
    );
    expect(
      partyFightHere(standing({ engaged: swinging, following: 'Killa' }), NOW, FRESH, false)
    ).toBe(false);
    expect(partyFightHere(standing({ engaged: swinging, members: [] }), NOW, FRESH, false)).toBe(
      false
    );
  });

  it('counts a whole-room attack while any monster is listed', () => {
    const room = { Killa: { kind: 'room' as const, at: NOW } };
    expect(partyFightHere(standing({ engaged: room }), NOW, FRESH, false)).toBe(true);
    expect(partyFightHere(standing({ engaged: room }, []), NOW, FRESH, false)).toBe(false);
  });

  it('counts a member only being hit under Defend Party', () => {
    const hit = { Killa: { target: 'small blood skeleton', at: NOW } };
    expect(partyFightHere(standing({ threatened: hit }), NOW, FRESH, false)).toBe(false);
    expect(partyFightHere(standing({ threatened: hit }), NOW, FRESH, true)).toBe(true);
  });

  it('points a sighting at the listed monster, or at nothing once stale', () => {
    const state = standing({});
    const seen = { kind: 'mob' as const, target: 'small blood skeleton', at: NOW };
    expect(freshSighting(state, seen, NOW, FRESH)).toMatchObject({ name: 'small blood skeleton' });
    expect(freshSighting(state, seen, NOW + FRESH + 1, FRESH)).toBeNull();
    expect(freshSighting(state, undefined, NOW, FRESH)).toBeNull();
  });
});
