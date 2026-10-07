import { describe, expect, it, vi } from 'vitest';

import { Navigation, type NavigationParts } from '../navigation';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { roomId, type RoomId } from '../../../shared/world';

/*
 * The engine's sweep of what is within reach, kept for the character as it
 * stands (`withinNow`): the hunting survey asks the same sweeps on every ask.
 */
describe('the rooms within reach, kept', () => {
  function engine(): {
    navigation: Navigation;
    sweeps: ReturnType<typeof vi.fn>;
    reach: { key: string };
  } {
    const reach = { key: 'level 3' };
    const sweeps = vi.fn((from: RoomId, steps: number) => new Map<RoomId, number>([[from, steps]]));
    const world = { withinSteps: sweeps } as unknown as ReturnType<NavigationParts['world']>;
    const navigation = new Navigation({
      world: () => world,
      tracker: { current: EMPTY_CHARACTER },
      errands: {
        travellerNow: () => ({}),
        reachKey: () => reach.key,
        priceAt: () => null
      },
      odds: () => ({ mob: () => ({ kind: 'unread' }), lair: () => ({ kind: 'unread' }) })
    });
    return { navigation, sweeps, reach };
  }
  const state: CharacterState = EMPTY_CHARACTER;

  it('sweeps once for the same room, steps and reach', () => {
    const { navigation, sweeps } = engine();
    const first = navigation.withinNow(roomId(1, 1), 5, state);
    expect(navigation.withinNow(roomId(1, 1), 5, state)).toBe(first);
    expect(sweeps).toHaveBeenCalledTimes(1);
    navigation.withinNow(roomId(1, 1), 6, state);
    navigation.withinNow(roomId(1, 2), 5, state);
    expect(sweeps).toHaveBeenCalledTimes(3);
  });

  it('sweeps again once what decides a way has moved', () => {
    const { navigation, sweeps, reach } = engine();
    navigation.withinNow(roomId(1, 1), 5, state);
    reach.key = 'level 4';
    navigation.withinNow(roomId(1, 1), 5, state);
    expect(sweeps).toHaveBeenCalledTimes(2);
  });
});
