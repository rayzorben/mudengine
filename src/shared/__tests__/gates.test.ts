import { describe, expect, it } from 'vitest';

import {
  judge,
  judgeAll,
  rollChance,
  rollPercent,
  type Gate,
  type GateFacts,
  type GateKind
} from '../gates';

/**
 * One gate of each kind, with a character it passes, one it shuts and what
 * nobody having said reads as. Keyed by `GateKind`, so a kind added to the
 * union without a row here does not type-check.
 */
const CASES: Record<
  GateKind,
  { gate: Gate; passes: GateFacts; shut: GateFacts; shutAs: unknown; unread: GateFacts }
> = {
  level: {
    gate: { kind: 'level', min: 20, max: 40 },
    passes: { level: 30 },
    shut: { level: 10 },
    shutAs: { needs: { kind: 'level', min: 20 } },
    unread: {}
  },
  class: {
    gate: { kind: 'class', id: 15, is: true },
    passes: { classId: 15 },
    shut: { classId: 3 },
    shutAs: 'fail',
    unread: { classId: null }
  },
  race: {
    gate: { kind: 'race', id: 12, is: false },
    passes: { raceId: 3 },
    shut: { raceId: 12 },
    shutAs: 'fail',
    unread: {}
  },
  standing: {
    gate: { kind: 'standing', low: 'Saint', high: 'Seedy' },
    passes: { alignment: 'Lawful' },
    shut: { alignment: 'FIEND' },
    shutAs: 'fail',
    unread: {}
  },
  alignment: {
    gate: { kind: 'alignment', atMost: -51 },
    passes: { evil: -100 },
    shut: { evil: 0 },
    shutAs: 'fail',
    unread: {}
  },
  carry: {
    gate: { kind: 'carry', item: 344 },
    passes: { keys: [344], packKnown: true },
    shut: { keys: [], packKnown: true },
    shutAs: { needs: { kind: 'item', item: 344 } },
    unread: { keys: [] }
  },
  lack: {
    gate: { kind: 'lack', item: 690 },
    passes: { keys: [], packKnown: true },
    shut: { keys: [690], packKnown: true },
    shutAs: { needs: { kind: 'drop', item: 690 } },
    unread: {}
  },
  floor: {
    gate: { kind: 'floor', item: 993, lying: true },
    passes: {},
    shut: {},
    shutAs: { needs: { kind: 'floor', item: 993, lying: true } },
    unread: {}
  },
  ability: {
    gate: { kind: 'ability', id: 134, atLeast: 9 },
    passes: { counters: { sums: { 134: 9 }, complete: true } },
    shut: { counters: { sums: {}, complete: true } },
    shutAs: { needs: { kind: 'ability', gate: { kind: 'ability', id: 134, atLeast: 9 } } },
    unread: { counters: { sums: {}, complete: false } }
  },
  'spell-off': {
    gate: { kind: 'spell-off', spell: 711 },
    passes: { spellsUp: [] },
    shut: { spellsUp: [711] },
    shutAs: { needs: { kind: 'spell-off', spell: 711 } },
    unread: {}
  },
  lives: {
    gate: { kind: 'lives', below: 9 },
    passes: { lives: 3 },
    shut: { lives: 9 },
    shutAs: 'fail',
    unread: {}
  },
  copper: {
    gate: { kind: 'copper', copper: 500 },
    passes: { wealth: 500 },
    shut: { wealth: 499 },
    shutAs: { needs: { kind: 'copper', copper: 500 } },
    unread: { wealth: null }
  },
  // Only `current_hp` is compared unclamped, so only it can pass every time.
  roll: {
    gate: { kind: 'roll', stat: 'current_hp', value: 50 },
    passes: { stats: { current_hp: 200 } },
    shut: { stats: { current_hp: 60 } },
    shutAs: { needs: { kind: 'luck', chance: 0.1 } },
    unread: { stats: {} }
  },
  'empty-room': {
    gate: { kind: 'empty-room' },
    passes: {},
    shut: {},
    shutAs: { needs: { kind: 'clear-room' } },
    unread: {}
  },
  'monster-here': {
    gate: { kind: 'monster-here', monster: 86 },
    passes: {},
    shut: {},
    shutAs: { needs: { kind: 'monster', monster: 86 } },
    unread: {}
  },
  occupied: {
    gate: { kind: 'occupied' },
    passes: {},
    shut: {},
    shutAs: { needs: { kind: 'occupied' } },
    unread: {}
  }
};

/* What lies in, or stands in, a room the character is not in is never read. */
const ROOM_FACTS: ReadonlySet<GateKind> = new Set([
  'floor',
  'empty-room',
  'monster-here',
  'occupied'
]);

describe('the one judge', () => {
  it.each(Object.entries(CASES))(
    'answers a %s gate',
    (kind, { gate, passes, shut, shutAs, unread }) => {
      expect(judge(gate, shut)).toEqual(shutAs);
      if (ROOM_FACTS.has(kind as GateKind)) return;
      expect(judge(gate, passes)).toBe('pass');
      expect(judge(gate, unread)).toBe('unknown');
    }
  );

  /* A level past the gate's top is a fact no training changes. */
  it('fails a level above the top and needs one below the bottom', () => {
    expect(judge({ kind: 'level', max: 19 }, { level: 20 })).toBe('fail');
    expect(judge({ kind: 'level', min: 20 }, { level: 10 })).toEqual({
      needs: { kind: 'level', min: 20 }
    });
  });

  /* `testskill`'s chance is clamped 2–98 (`TextBlockPart.cs:1222`), except on current_hp. */
  it('clamps a roll the way the server does', () => {
    const roll = (stat: 'intellect' | 'current_hp', value: number, held: number) =>
      rollChance({ kind: 'roll', stat, value }, { stats: { [stat]: held } });
    expect(roll('intellect', 30, 10)).toBe(0.02);
    expect(roll('intellect', 0, 500)).toBe(0.98);
    expect(roll('current_hp', 50, 40)).toBe(0);
  });

  it("gives a roll's odds in percent off the sheet, and none for an unread stat", () => {
    expect(rollPercent('intellect', 45, 30)).toBe(15);
    expect(rollPercent('intellect', 30, 30)).toBe(2);
    expect(rollPercent('intellect', 200, 30)).toBe(98);
    expect(rollPercent('intellect', null, 30)).toBeNull();
  });

  it('carries a key it holds before the pack is listed', () => {
    expect(judge({ kind: 'carry', item: 1 }, { keys: [1] })).toBe('pass');
  });

  it('judges a way by all its gates: a failure first, then a need, then unread', () => {
    const level: Gate = { kind: 'level', min: 20 };
    const cls: Gate = { kind: 'class', id: 1, is: true };
    const key: Gate = { kind: 'carry', item: 9 };
    expect(judgeAll([level, cls], { level: 10, classId: 2 })).toBe('fail');
    expect(judgeAll([key, level], { level: 10, packKnown: true, keys: [] })).toEqual({
      needs: { kind: 'item', item: 9 }
    });
    expect(judgeAll([level, cls], { level: 30 })).toBe('unknown');
    expect(judgeAll([], {})).toBe('pass');
  });
});
