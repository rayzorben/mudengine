import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../dice';
import { rollShields, shieldPerBlow, shieldsOf } from '../damageShield';

/*
 * A monster's damage shield (todo 56): `ActionFigure.HitCheckShockShield`
 * rolls `rand(1, max(value, 3))` per `ShockShield` (72) row. Figures from
 * gmud.zip (`todo/56-damage-shields.mjs`).
 */
describe('a damage shield', () => {
  it('reads each ShockShield row, raising a value under 3 to 3', () => {
    // razor boar: 72 = 3, ShockMsg 137 beside it. A row of 0 still shocks for 1–3.
    expect(
      shieldsOf([
        [72, 3],
        [137, 3837],
        [34, 10]
      ])
    ).toEqual([3]);
    expect(shieldsOf([[72, 0]])).toEqual([3]);
    expect(shieldsOf([[34, 10]])).toEqual([]);
    expect(shieldsOf(undefined)).toEqual([]);
  });

  it('does the mean of 1 to its high end per landed blow, every shield counted', () => {
    expect(shieldPerBlow([3])).toBe(2);
    // green sphere, 72 = 200.
    expect(shieldPerBlow([200])).toBe(100.5);
    expect(shieldPerBlow([3, 10])).toBe(7.5);
    expect(shieldPerBlow([])).toBe(0);
  });

  it('rolls inside 1 to the high end', () => {
    const random = mulberry32(7);
    const rolls = Array.from({ length: 500 }, () => rollShields(random, [3]));
    expect(Math.min(...rolls)).toBe(1);
    expect(Math.max(...rolls)).toBe(3);
  });
});
