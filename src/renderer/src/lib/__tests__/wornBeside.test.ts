import { describe, expect, it } from 'vitest';

import { gearFiguresOf } from '@shared/gearWeighing';
import type { SlotFigures } from '@shared/slotGear';
import type { WornBeside } from '@shared/wornBeside';
import { besideRows, changeOf, replacedIndex } from '../wornBeside';

const figures = (ac: number, dr: number, worth: number): SlotFigures => ({
  ac,
  dr,
  worth,
  damage: null,
  perRound: null,
  figures: gearFiguresOf({ armour: { ac, dr } })
});

const BESIDE: WornBeside = {
  slot: 'Torso',
  ranking: { by: 'armour' },
  item: {
    ...figures(230, 85, 300),
    id: 521,
    name: 'silvery plate corselet',
    minLevel: null,
    weight: 1200,
    weaponClass: null,
    speed: null
  },
  worn: [
    { name: 'spiked plate corselet', figures: figures(200, 85, 260), weight: 1000, speed: null }
  ],
  replaces: 'spiked plate corselet',
  verdict: 'better',
  handsFree: null,
  unread: false
};

describe('the rows an item is compared on', () => {
  it('lists the figures either side gives, armour first, and leaves out the rest', () => {
    const rows = besideRows(BESIDE, 'greatermud');
    expect(rows.map((row) => row.key)).toEqual(['worth', 'ac', 'damageResist', 'weight']);
    const ac = rows.find((row) => row.key === 'ac')!;
    expect([ac.text(0), ac.text(1)]).toEqual(['230', '200']);
  });

  it('marks a gain better and more weight worse, against the piece it replaces', () => {
    const rows = besideRows(BESIDE, 'greatermud');
    const against = replacedIndex(BESIDE);
    expect(against).toBe(0);
    const of = (key: string) =>
      changeOf(
        rows.find((row) => row.key === key)!,
        against
      );
    expect(of('ac')).toEqual({ by: 30, tone: 'better' });
    expect(of('damageResist')).toEqual({ by: 0, tone: 'same' });
    expect(of('weight')).toEqual({ by: 200, tone: 'worse' });
  });

  it('compares against nothing where it replaces nothing', () => {
    expect(replacedIndex({ ...BESIDE, replaces: null, verdict: null })).toBe(-1);
    expect(replacedIndex({ ...BESIDE, worn: null })).toBe(-1);
  });
});
