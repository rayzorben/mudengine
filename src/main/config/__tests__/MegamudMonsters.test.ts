import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { MegamudMonsters } from '../MegamudMonsters';
import { mobRuleFor, peaceOf } from '../../../shared/mobRules';

/* Todo 817: the shipped table, written once by `npm run build:megamud`, read as it ships. */
describe("MegaMUD's monster table", () => {
  const rows = new MegamudMonsters(
    path.resolve(__dirname, '../../../../resources/megamud/monsters.yaml')
  ).all();

  it('reads every row the extraction wrote', () => {
    expect(rows).toHaveLength(693);
  });

  it("states MegaMUD's Avoid, Friend and boss priority in this client's words", () => {
    expect(mobRuleFor(rows, 'Aeriana the Pure')).toEqual({
      mob: 'aeriana the pure',
      treat: 'never'
    });
    expect(mobRuleFor(rows, 'adult red dragon')?.treat).toBe('high');
  });

  /* Review: a Paramud table on every realm must not make a monster no threat where the realm says it attacks. */
  it('carries no claim that a monster does not attack first', () => {
    expect(rows.every((row) => peaceOf(row) === null)).toBe(true);
  });

  it('leaves out a name whose MegaMUD records disagree', () => {
    expect(mobRuleFor(rows, 'cloaked figure')).toBeUndefined();
  });
});
