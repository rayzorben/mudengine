import { describe, expect, it } from 'vitest';

import { NO_REFERRED_NAMES } from '@shared/abilities';
import { gearFiguresOf } from '@shared/gearWeighing';
import type { SlotFigures } from '@shared/slotGear';
import type { ComparedItem, WornBeside } from '@shared/wornBeside';
import { compareRows, replacedIndex, type CompareSide } from '../wornBeside';

const side = (item: ComparedItem, worth: number): CompareSide => {
  const figures: SlotFigures = {
    ac: item.armour?.ac ?? 0,
    dr: item.armour?.dr ?? 0,
    worth,
    damage: null,
    perRound: null,
    figures: gearFiguresOf(item)
  };
  return { item, figures };
};

// The two belts in the user's screenshot, 2026-11-27: the golden braided belt's
// crits were missing from the comparison.
const STORMMETAL: ComparedItem = {
  armour: { ac: 25, dr: 5, material: 'plate' },
  abilities: [
    [28, 1],
    [4, 4],
    [66, 10],
    [135, 50]
  ],
  encumbrance: 200
};
const GOLDEN: ComparedItem = {
  armour: { ac: 10 },
  abilities: [
    [4, 3],
    [88, 20],
    [58, 2]
  ],
  encumbrance: 22
};

const NAMES = { family: 'greatermud' as const, classNames: {}, referred: NO_REFERRED_NAMES };

describe('every stat of a worn piece against the item looked up', () => {
  const rows = compareRows(side(GOLDEN, 140), side(STORMMETAL, 70), { by: 'armour' }, NAMES);
  const row = (key: string) => rows.find((each) => each.key === key);

  it('lists every effect either states, crits included', () => {
    expect(row('effect-58')).toMatchObject({ label: 'Crits', worn: '2%', item: '0' });
    expect(row('effect-58')?.change).toEqual({ by: -2, tone: 'worse' });
    expect(row('effect-88')?.change).toEqual({ by: -20, tone: 'worse' });
    expect(row('effect-4')?.change).toEqual({ by: 1, tone: 'better' });
    expect(row('effect-66')).toMatchObject({ worn: '0', change: { by: 10, tone: 'better' } });
  });

  it('reads a higher level gate as worse, and being magical as neither', () => {
    expect(row('effect-135')?.change).toEqual({ by: 50, tone: 'worse' });
    expect(row('effect-28')?.change).toEqual({ by: 1, tone: null });
  });

  it('compares the realm columns: armour, material and weight', () => {
    expect(row('ac')).toMatchObject({ worn: '10', item: '25', change: { by: 15, tone: 'better' } });
    expect(row('dr')).toMatchObject({ worn: '0', item: '5' });
    expect(row('material')).toMatchObject({ worn: null, item: 'plate', change: null });
    expect(row('weight')?.change).toEqual({ by: 178, tone: 'worse' });
    expect(row('worth')?.change).toEqual({ by: -70, tone: 'worse' });
  });

  it('leaves out a stat neither states', () => {
    expect(row('speed')).toBeUndefined();
    expect(row('price')).toBeUndefined();
  });
});

describe('the piece the item replaces', () => {
  const beside = (replaces: string | null, worn: WornBeside['worn']): WornBeside =>
    ({ replaces, worn }) as WornBeside;
  const piece = {
    name: 'golden braided belt',
    id: 1,
    item: GOLDEN,
    figures: side(GOLDEN, 0).figures
  };

  it('is found by name, and is none with a place free or the pack unread', () => {
    expect(replacedIndex(beside('golden braided belt', [piece]))).toBe(0);
    expect(replacedIndex(beside(null, [piece]))).toBe(-1);
    expect(replacedIndex(beside('golden braided belt', null))).toBe(-1);
  });
});
