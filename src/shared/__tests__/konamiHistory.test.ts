import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../character';
import { changesOf } from '../konamiHistory';

const reading = (over: {
  level?: number;
  health?: number;
  cp?: number;
  worn?: string[];
  listed?: boolean;
}): CharacterState => {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    progress: {
      ...base.progress,
      level: over.level ?? 1,
      health: over.health ?? 50,
      cp: over.cp ?? 10
    },
    inventory: {
      ...base.inventory,
      listedAt: over.listed === false ? null : 1,
      items: (over.worn ?? []).map((name) => ({ name, equipped: true }) as never)
    }
  };
};

describe('what the history reads off two readings', () => {
  it('a level trained and the stat points spent', () => {
    expect(changesOf(reading({}), reading({ level: 2, health: 53, cp: 1 }))).toEqual([
      { kind: 'levelled', from: 1, to: 2 },
      { kind: 'stats', changes: [{ stat: 'health', from: 50, to: 53 }] }
    ]);
  });

  it('no points spent where the stat moved and the points did not (a ring, a curse)', () => {
    expect(changesOf(reading({}), reading({ health: 55 }))).toEqual([]);
  });

  it('what was put on and taken off, only where both listings were read', () => {
    expect(changesOf(reading({ worn: ['club'] }), reading({ worn: ['quarterstaff'] }))).toEqual([
      { kind: 'wore', item: 'quarterstaff' },
      { kind: 'removed', item: 'club' }
    ]);
    expect(changesOf(reading({ worn: ['club'] }), reading({ listed: false }))).toEqual([]);
    expect(
      changesOf(reading({ worn: ['gold ring'] }), reading({ worn: ['gold ring', 'gold ring'] }))
    ).toEqual([{ kind: 'wore', item: 'gold ring' }]);
  });
});
