import { describe, expect, it } from 'vitest';

import { faceIndex, keptPick } from '../faces';

describe('faceIndex', () => {
  it('keeps the picked face when a face appears before it', () => {
    // FINDS picked in a plain room, then the character walks into a lair.
    expect(faceIndex(['room', 'finds'], undefined, 'finds')).toBe(1);
    expect(faceIndex(['room', 'lair', 'finds'], undefined, 'finds')).toBe(2);
  });

  it('shows the first face when the picked one has gone', () => {
    expect(faceIndex(['room', 'finds'], undefined, 'lair')).toBe(0);
    expect(faceIndex([], undefined, 'lair')).toBe(0);
  });

  it('shows the first face with nothing picked', () => {
    expect(faceIndex(['room', 'lair', 'finds'], undefined, null)).toBe(0);
  });

  it('forgets a pick whose face went, so it does not come back unasked', () => {
    // LAIR picked in a lair, then a plain room, then another lair.
    expect(keptPick(['room', 'lair'], 'lair')).toBe('lair');
    const left = keptPick(['room'], 'lair');
    expect(left).toBeNull();
    expect(faceIndex(['room', 'lair'], undefined, left)).toBe(0);
  });

  it("lets the card's own choice win over the pick while that face exists", () => {
    expect(faceIndex(['route', 'loop'], 'loop', 'route')).toBe(1);
    expect(faceIndex(['idle', 'route'], 'loop', 'route')).toBe(1);
  });
});
