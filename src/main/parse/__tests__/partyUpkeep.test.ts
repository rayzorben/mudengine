import { describe, expect, it } from 'vitest';

import {
  EMPTY_CHARACTER,
  NO_PARTY,
  type CharacterState,
  type PartyFight,
  type RoomOccupant
} from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { keepPartyCurrent } from '../partyUpkeep';
import { member } from '../presence';

/*
 * Todo 06: the Party card still said Durnan was resting and fighting a fierce
 * decayed guard after the guard fell and Durnan had cast, swung and walked on.
 */

const block = (type: string, groups: Record<string, string> = {}): Block =>
  ({ type, groups, at: 10, seq: 1, terminator: 'newline' }) as unknown as Block;

const mob = (name: string): RoomOccupant => ({
  name,
  kind: 'mob',
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false
});

const upkeep = (
  before: CharacterState,
  after: CharacterState,
  b: Block,
  moved = false
): CharacterState => keepPartyCurrent(before, after, b, moved);

const guard: PartyFight = { kind: 'mob', target: 'fierce decayed guard', at: 5 };

/** Festus, following a resting Durnan who is fighting a guard in this room. */
const fighting = (occupants: RoomOccupant[]): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  name: 'Festus',
  room: { ...EMPTY_CHARACTER.room, occupants },
  party: {
    ...NO_PARTY,
    following: 'Durnan',
    members: [member('Durnan', { activity: { state: 'resting' } }), member('Festus')],
    engaged: { Durnan: guard },
    threatened: { Durnan: { target: 'fierce decayed guard', at: 5 } }
  }
});

const withRoom = (s: CharacterState, occupants: RoomOccupant[]): CharacterState => ({
  ...s,
  room: { ...s.room, occupants }
});

describe('a member’s fight', () => {
  it('ends when its monster leaves the room’s listing', () => {
    const before = fighting([mob('fierce decayed guard')]);
    // Positive control: the same block with the guard still listed keeps it.
    const kept = upkeep(
      before,
      withRoom(before, [mob('fierce decayed guard')]),
      block('room-exits')
    );
    expect(kept.party.engaged['Durnan']).toEqual(guard);

    const after = upkeep(before, withRoom(before, []), block('user-gain-experience'));
    expect(after.party.engaged).toEqual({});
    expect(after.party.threatened).toEqual({});
  });

  it('is kept while another monster of the same name is listed', () => {
    const before = fighting([mob('fierce decayed guard'), mob('fierce decayed guard')]);
    const after = upkeep(
      before,
      withRoom(before, [mob('fierce decayed guard')]),
      block('mob-dies')
    );
    expect(after.party.engaged['Durnan']).toEqual(guard);
  });

  it('over the whole room lasts while any monster is listed', () => {
    const before: CharacterState = {
      ...fighting([mob('giant rat')]),
      party: { ...fighting([]).party, engaged: { Durnan: { kind: 'room', at: 5 } } }
    };
    expect(
      upkeep(before, withRoom(before, [mob('kobold')]), block('room-exits')).party.engaged
    ).toEqual({
      Durnan: { kind: 'room', at: 5 }
    });
    expect(upkeep(before, withRoom(before, []), block('room-exits')).party.engaged).toEqual({});
  });

  it('on a monster the room never named is kept until the character moves', () => {
    const before = fighting([]);
    const walkedIn = withRoom(before, [{ ...mob('Rend'), kind: 'player' }]);
    expect(upkeep(before, walkedIn, block('player-attacks')).party.engaged['Durnan']).toEqual(
      guard
    );
    expect(upkeep(before, walkedIn, block('room-exits'), true).party.engaged).toEqual({});
  });

  it('ends on a move even where the new room has a monster of the same name', () => {
    const before = fighting([mob('fierce decayed guard')]);
    const next = withRoom(before, [mob('fierce decayed guard')]);
    // Positive control: the same room re-read keeps it.
    expect(upkeep(before, next, block('room-exits')).party.engaged['Durnan']).toEqual(guard);
    const moved = upkeep(before, next, block('room-exits'), true);
    expect(moved.party.engaged).toEqual({});
    expect(moved.party.threatened).toEqual({});
  });

  it('leaves the state alone when nothing changed', () => {
    const before = fighting([mob('fierce decayed guard')]);
    expect(upkeep(before, before, block('status-line'))).toBe(before);
  });
});

describe('a member seen acting is no longer resting', () => {
  const activity = (s: CharacterState): unknown =>
    s.party.members.find((entry) => entry.name === 'Durnan')?.activity;

  it('when a new swing of theirs is filed', () => {
    const before = fighting([mob('fierce decayed guard')]);
    // Positive control: a block that files nothing leaves the flag.
    expect(activity(upkeep(before, before, block('status-line')))).toEqual({
      state: 'resting'
    });
    const swung = {
      ...before,
      party: { ...before.party, engaged: { Durnan: { ...guard, at: 9 } } }
    };
    expect(activity(upkeep(before, swung, block('player-attacks')))).toBeNull();
  });

  it('when something new swings at them', () => {
    const before = fighting([mob('fierce decayed guard')]);
    const hit = {
      ...before,
      party: { ...before.party, threatened: { Durnan: { target: 'fierce decayed guard', at: 9 } } }
    };
    expect(activity(upkeep(before, hit, block('user-hits')))).toBeNull();
  });

  it('when they cast or walk out', () => {
    const before = fighting([mob('fierce decayed guard')]);
    expect(activity(upkeep(before, before, block('spell-cast', { caster: 'Durnan' })))).toBeNull();
    expect(
      activity(upkeep(before, before, block('player-leaves-room', { player: 'Durnan' })))
    ).toBeNull();
    expect(activity(upkeep(before, before, block('spell-cast', { caster: 'You' })))).toEqual({
      state: 'resting'
    });
  });
});
