import { describe, expect, it } from 'vitest';

import { FightHeal } from '../FightHeal';
import { EMPTY_CHARACTER } from '../../../shared/character';
import { blockOf } from '../../../shared/__tests__/blocks';

/** A fight's rounds, `every` ms apart, the monster hitting for `damage` in each; returns the time after. */
function rounds(heal: FightHeal, start: number, count: number, every: number, damage = 10): number {
  for (let round = 0; round < count; round += 1) {
    const at = start + round * every;
    heal.onBlock(blockOf('mob-hits', '', { damage: String(damage) }, at));
    heal.onBlock(blockOf('user-misses', '', {}, at + 80));
  }
  return start + count * every;
}

const out = { ...EMPTY_CHARACTER, inCombat: false };

/* orohost runs at 5 (`GameSpeed`): a round a second, read as one round a fight at the server's own quiet. */
describe('what a heal in a fight has to beat, on a realm that runs faster', () => {
  it('measures each round, fight after fight', () => {
    const heal = new FightHeal(
      () => null,
      () => 5
    );
    let at = rounds(heal, 1_000_000, 4, 1000);
    expect(heal.floor('self', 40, out)).toEqual({ basis: 'measured', floor: 10 });
    // The next fight is measured from its own blows, at the same speed.
    heal.onCharacter(out);
    at = rounds(heal, at + 20_000, 3, 1000, 6);
    expect(heal.floor('self', 40, out)).toEqual({ basis: 'measured', floor: 6 });
  });

  it('reads the same blows as one round at the server’s own speed', () => {
    const heal = new FightHeal(() => null);
    rounds(heal, 1_000_000, 4, 1000);
    expect(heal.floor('self', 40, out)).toEqual({ basis: 'round', floor: 40 });
  });
});
