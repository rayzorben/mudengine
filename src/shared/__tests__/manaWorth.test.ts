import { describe, expect, it } from 'vitest';

import { saveTheMana, type KillPrice } from '../manaWorth';

const rat: KillPrice = { name: 'rat', experience: 5, mana: 20 };
const orc: KillPrice = { name: 'orc', experience: 500, mana: 20 };
const ogre: KillPrice = { name: 'ogre', experience: 900, mana: 20 };

describe('whether a kill is worth the mana next to another in the room', () => {
  it('holds when the pool pays for one of the two and the other is worth more, naming the best', () => {
    expect(saveTheMana(30, rat, [orc, ogre])).toEqual({ here: rat, next: ogre, pool: 30 });
  });

  it('does not where the pool pays for both (the control)', () => {
    expect(saveTheMana(40, rat, [orc])).toBeNull();
  });

  it('does not where the other is worth less, or costs more than the pool', () => {
    expect(saveTheMana(30, orc, [rat])).toBeNull();
    expect(saveTheMana(30, rat, [{ ...orc, mana: 31 }])).toBeNull();
  });

  it('answers nothing for an unknown pool or kill', () => {
    expect(saveTheMana(null, rat, [orc])).toBeNull();
    expect(saveTheMana(30, null, [orc])).toBeNull();
  });
});
