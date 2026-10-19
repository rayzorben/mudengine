import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { keepCurrent } from '../keepCurrent';

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
const block = {
  seq: 1,
  at: 5_000,
  type: 'mob-arrives-room',
  groups: {},
  text: ''
} as unknown as Block;
const inRoom = (occupants: RoomOccupant[]): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  room: { ...EMPTY_CHARACTER.room, occupants }
});

describe("a block's upkeep", () => {
  it('works the gauges out again when the room lists someone new', () => {
    const asked: number[] = [];
    const fight = {
      rejudge: (s: CharacterState, at: number) => {
        asked.push(at);
        return s;
      }
    };
    const before = inRoom([mob('orc')]);
    const after = inRoom([mob('orc'), mob('kobold')]);
    keepCurrent(before, after, block, false, fight);
    expect(asked).toEqual([5_000]);
    // The positive control above ran; the same list asks nothing.
    keepCurrent(after, after, block, false, fight);
    expect(asked).toEqual([5_000]);
  });
});
