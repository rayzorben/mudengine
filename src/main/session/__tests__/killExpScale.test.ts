import { describe, expect, it } from 'vitest';

import { killExpScale } from '../Errands';
import type { WorldGraph } from '../../world/WorldGraph';

/** A realm stating each monster's experience, as the world database does. */
const world = (stated: Record<string, number>): Pick<WorldGraph, 'mob'> =>
  ({
    mob: (name: string) =>
      stated[name] === undefined ? undefined : { name, experience: stated[name] }
  }) as unknown as Pick<WorldGraph, 'mob'>;

/*
 * Todo 70: Paradigm paid 300 for a cave bear its database rates at 100, and
 * 9 for a giant rat rated 3. The realm's scale is the median of what solo
 * kills paid over what the database says.
 */
describe('what the realm pays against its database', () => {
  it('is the median of learned over stated', () => {
    const learned = new Map([
      ['cave bear', 300],
      ['giant rat', 9],
      ['kobold', 50]
    ]);
    expect(killExpScale(learned, world({ 'cave bear': 100, 'giant rat': 3, kobold: 10 }))).toBe(3);
  });

  it('is 1 before any kill the database can price', () => {
    expect(killExpScale(new Map(), world({}))).toBe(1);
    expect(killExpScale(new Map([['ghost', 40]]), world({}))).toBe(1);
  });
});
