import { describe, expect, it } from 'vitest';

import { HAZARD_ABILITY } from '../../../shared/abilities';
import { scriptLines } from '../navigation/scriptWays';
import { readLines } from '../navigation/textblock';

const blocks = (rows: Record<number, string>) =>
  new Map(
    Object.entries(rows).map(([id, action]) => [
      Number(id),
      { lines: readLines(action), linkTo: null }
    ])
  );

/* Spell 1 runs block 10; spell 2 teleports by its own column; spell 3 runs block 30. */
const ROWS: Record<number, Array<[number, number]>> = {
  1: [[HAZARD_ABILITY.textBlock, 10]],
  2: [[HAZARD_ABILITY.teleportRoom, 7]],
  3: [[HAZARD_ABILITY.textBlock, 30]],
  4: [
    [HAZARD_ABILITY.textBlock, 40],
    [HAZARD_ABILITY.textBlock, 41]
  ]
};
const abilities = (spell: number) => ROWS[spell];

describe('a spell script as its lines in order', () => {
  /* The pyramid's fourth-floor arch, `pyramid 4 arch pass` over `arch fail`. */
  it('reads the arch as a free line for rank 9 ahead of two that move', () => {
    const arch = blocks({
      10: 'checkability 134 9:addexp 0\ntestability 134 8:cast 2\nfailability 134:cast 2'
    });
    expect(scriptLines(1, abilities, arch)).toEqual([
      { gates: [{ kind: 'ability', id: 134, atLeast: 9 }], moves: false },
      { gates: [{ kind: 'ability', id: 134, atMost: 8 }], moves: true },
      { gates: [{ kind: 'ability', id: 134, absent: true }], moves: true }
    ]);
  });

  /* Only the gates ahead of the move decide whether it happens. */
  it('keeps the gates ahead of the first moving step', () => {
    expect(scriptLines(1, abilities, blocks({ 10: 'maxlevel 5:teleport 9 9:minlevel 2' }))).toEqual(
      [{ gates: [{ kind: 'level', max: 5 }], moves: true }]
    );
    expect(scriptLines(1, abilities, blocks({ 10: 'teleport 5 5\naddexp 0' }))).toEqual([
      { gates: [], moves: true },
      { gates: [], moves: false }
    ]);
  });

  /* The bridge trigger: a roll of teleports. */
  it('follows a roll and a cast into what moves', () => {
    const bridge = blocks({ 10: 'random 11', 11: '50:teleport 1 16\n100:teleport 2 16' });
    expect(scriptLines(1, abilities, bridge)).toEqual([{ gates: [], moves: true }]);
    expect(scriptLines(1, abilities, blocks({ 10: 'cast 3', 30: 'teleport 5 5' }))).toEqual([
      { gates: [], moves: true }
    ]);
  });

  /* A chain the realm does not hold is unread, never still. */
  it('reads a block it cannot find as unread, and says nothing of a script that moves nobody', () => {
    expect(scriptLines(1, abilities, blocks({ 10: 'random 99' }))).toEqual([
      { gates: [], moves: 'unread' }
    ]);
    expect(scriptLines(1, abilities, blocks({ 10: 'message 4:addexp 0' }))).toBeNull();
  });

  /* Two scripts run one after the other (`Spell.cs:1600`): not one ordered list. */
  it('reads a spell with two scripts, one of which moves, as unread', () => {
    const two = blocks({ 40: 'addexp 0', 41: 'teleport 1 1' });
    expect(scriptLines(4, abilities, two)).toEqual([{ gates: [], moves: 'unread' }]);
    expect(scriptLines(4, abilities, blocks({ 40: 'addexp 0', 41: 'message 3' }))).toBeNull();
  });
});
