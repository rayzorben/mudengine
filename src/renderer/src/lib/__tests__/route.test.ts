import { describe, expect, it } from 'vitest';

import { commandsOf, keptOutRooms, runsOf, stepDanger, stepSignature } from '../route';
import type { RouteStep } from '@shared/world';

const step = (name: string, over: Partial<RouteStep> = {}): RouteStep => ({
  from: '1/1',
  to: '1/2',
  direction: 's',
  command: 's',
  name,
  requirement: null,
  dark: false,
  ...over
});

/*
 * *Slum Street, Slum Street, Slum Street* is one row saying ×3 (todo 01,
 * 2026-09-10) — and a room with a chip of its own keeps its own line, because
 * a chip folded into a neighbour's row is one the reader never sees.
 */
describe('folding a route list', () => {
  it('runs consecutive rooms that read the same together', () => {
    const steps = [
      step('Slum Entrance'),
      step('Slum Street'),
      step('Slum Street'),
      step('Slum Street'),
      step('Slum Street, Crossroads')
    ];
    expect(runsOf(steps.map(stepSignature))).toEqual([
      { start: 0, count: 1 },
      { start: 1, count: 3 },
      { start: 4, count: 1 }
    ]);
  });

  it('keeps a room wearing a chip on its own row', () => {
    const steps = [
      step('Slum Street'),
      step('Slum Street', { requirement: { kind: 'trap', raw: 'Trap, 36 damage', damage: 36 } }),
      step('Slum Street')
    ];
    expect(runsOf(steps.map(stepSignature)).map((run) => run.count)).toEqual([1, 1, 1]);
  });

  it('folds rooms whose chips would have read identically, and only those', () => {
    expect(stepSignature(step('River', { hazard: 0.0911 }))).toBe(
      stepSignature(step('River', { hazard: 0.0949 }))
    );
    expect(stepSignature(step('River', { hazard: 0.09 }))).not.toBe(
      stepSignature(step('River', { hazard: 0.11 }))
    );
    expect(stepSignature(step('Wood', { hazard: 0.02, hazardKind: 'unread' }))).not.toBe(
      stepSignature(step('Wood', { hazard: 0.02 }))
    );
    expect(stepSignature(step('Lair', { danger: 1.2, deadly: true }))).not.toBe(
      stepSignature(step('Lair', { danger: 0.3 }))
    );
  });

  it('does not fold the same name across a different room in between', () => {
    const steps = [step('Bend'), step('Street'), step('Bend')];
    expect(runsOf(steps.map(stepSignature))).toHaveLength(3);
  });

  it('says the commands of a run compactly', () => {
    expect(commandsOf([step('a'), step('a'), step('a')])).toBe('s ×3');
    expect(commandsOf([step('a', { command: 'n' }), step('a'), step('a', { command: 'e' })])).toBe(
      'n s e'
    );
    expect(commandsOf([step('a')])).toBe('s');
  });

  /* 2026-10-06: a lair and a room with no lair that monsters walk into say different chips at the same share. */
  it('keeps a lair and a room monsters walk into apart at the same share', () => {
    const lair = step('Main Road', { danger: 0.1, lair: true });
    const room = step('Main Road', { danger: 0.1 });
    expect(stepSignature(lair)).not.toBe(stepSignature(room));
    expect(stepDanger(lair)).toEqual({ kind: 'lair', percent: 10 });
    expect(stepDanger(room)).toEqual({ kind: 'road', percent: 10 });
  });
});

/* Todo 23: the card names where a way crosses a kept-out word, so another vortex is in view. */
describe('where a way crosses what the player keeps out of', () => {
  it('names the room each crossing leaves, once, and the start as unnamed', () => {
    const steps = [
      step('Main Road'),
      step('Dragon’s Teeth Hills'),
      step('Black Wasteland', { keptOut: 'vortex' }),
      step('Black Wasteland'),
      step('Hazy Swamp', { keptOut: 'vortex' })
    ];
    expect(keptOutRooms(steps)).toEqual(['Dragon’s Teeth Hills', 'Black Wasteland']);
    expect(keptOutRooms([step('Black Wasteland', { keptOut: 'vortex' })])).toEqual([null]);
    expect(keptOutRooms([step('Main Road')])).toEqual([]);
    // A word a room's name says flags every step inside it; only the way in is named.
    const plane = [
      step('Black Wasteland'),
      step('Negative Power Plane', { keptOut: 'Negative Power Plane' }),
      step('Negative Power Plane', { keptOut: 'Negative Power Plane' })
    ];
    expect(keptOutRooms(plane)).toEqual(['Black Wasteland']);
  });
});
