import { describe, expect, it, vi } from 'vitest';

import { mobFinderPlanner, type HostTripParts } from '../hostTrips';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';

/** The realm's gravedigger, and the room's occupants as the tracker lists them. */
const occupant = (name: string, mob?: string): RoomOccupant => ({
  name,
  kind: 'mob',
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false,
  ...(mob === undefined ? {} : { mob: { name: mob, rawName: name } as RoomOccupant['mob'] })
});

const inRoom = (occupants: RoomOccupant[]): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  phase: 'in-game',
  room: { ...structuredClone(EMPTY_CHARACTER.room), occupants }
});

function parts() {
  const stop = vi.fn();
  const switchedOnFor = vi.fn((start: () => string | null) => start());
  const world = {
    byId: (room: string) => ({ name: `the ${room}` }),
    // The realm's fold for a printed name: `a gravedigger` is the gravedigger.
    mob: (name: string) => (name.includes('gravedigger') ? { name: 'gravedigger' } : undefined)
  };
  const modules = () => ({
    tracker: { current: inRoom([]), pendingMoves: 0 },
    walker: { stop, walking: false, progress: { pace: 'walking' }, start: () => null },
    world,
    travel: { switchedOnFor, escaping: false },
    combat: { willFight: true },
    errands: { travellerNow: () => ({}) },
    signs: { monsterSwung: () => false, quarry: () => false },
    loops: { progress: { status: 'idle' }, noteErrand: vi.fn() }
  });
  const planner = mobFinderPlanner({
    modules,
    busy: () => false,
    release: vi.fn()
  } as unknown as HostTripParts);
  return { planner, stop, switchedOnFor };
}

describe('the find’s planner', () => {
  it('sees the monster by the realm’s name on the occupant, or asks the realm by the printed one', () => {
    const { planner } = parts();
    expect(planner.present('gravedigger', inRoom([occupant('gravedigger', 'gravedigger')]))).toBe(
      true
    );
    // The room did not hydrate it (a name several rows share): the printed name is asked of the realm.
    expect(planner.present('gravedigger', inRoom([occupant('a gravedigger')]))).toBe(true);
    expect(planner.present('gravedigger', inRoom([occupant('giant rat', 'giant rat')]))).toBe(
      false
    );
    expect(planner.present('gravedigger', inRoom([]))).toBe(false);
  });

  it('stops the walker, names rooms, and turns the switch on for the walk', () => {
    const { planner, stop, switchedOnFor } = parts();
    planner.stopWalk('gravedigger is here');
    expect(stop).toHaveBeenCalledWith('gravedigger is here');
    expect(planner.nameOf('1/2')).toBe('the 1/2');
    expect(planner.switchedOnFor(() => 'refused')).toBe('refused');
    expect(switchedOnFor).toHaveBeenCalledTimes(1);
    expect(planner.fightsBack()).toBe(true);
    expect(planner.escaping()).toBe(false);
  });
});
