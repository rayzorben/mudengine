import { describe, expect, it } from 'vitest';

import { PaidLevels } from '../PaidLevels';
import type { ExperienceProgress, ExperienceTable } from '../../../shared/experience';

/* rayzor, 2026-11-27: `Exp: 86145857 Level: 28 Exp needed for next level: 0 (86141218)`. */
const onlyNext: ExperienceTable = {
  rows: [{ level: 29, experience: 86_141_218, source: 'realm' }]
};
const withAfter: ExperienceTable = {
  rows: [...onlyNext.rows, { level: 30, experience: 99_062_400, source: 'realm' }]
};
const at = (exp: number, expNeeded: number | null, expTable: ExperienceTable | null) =>
  ({ level: 28, exp, expNeeded, expTable }) satisfies ExperienceProgress;

describe('the exp table owed once the next level is paid for', () => {
  it('is not owed while the next level still needs exp', () => {
    expect(new PaidLevels().owes(at(85_408_757, 732_461, onlyNext))).toBe(false);
  });

  it('is owed once, when exp passes the only level the table prices', () => {
    const paid = new PaidLevels();
    expect(paid.owes(at(86_145_857, 0, onlyNext))).toBe(true);
    expect(paid.owes(at(86_180_057, 0, onlyNext))).toBe(false);
  });

  it('is owed with no table at all once exp says nothing is needed', () => {
    expect(new PaidLevels().owes(at(86_145_857, 0, null))).toBe(true);
  });

  it('is not owed while the table prices the level after', () => {
    expect(new PaidLevels().owes(at(86_145_857, 0, withAfter))).toBe(false);
  });

  it('is not owed before exp and level are known', () => {
    const paid = new PaidLevels();
    expect(paid.owes({ level: null, exp: 86_145_857, expNeeded: 0, expTable: null })).toBe(false);
    expect(paid.owes({ level: 28, exp: null, expNeeded: 0, expTable: null })).toBe(false);
  });

  it('is owed again at the next level, and again after a reset', () => {
    const paid = new PaidLevels();
    expect(paid.owes(at(86_145_857, 0, onlyNext))).toBe(true);
    expect(paid.owes({ ...at(99_100_000, 0, withAfter), level: 29 })).toBe(true);
    paid.reset();
    expect(paid.owes({ ...at(99_100_000, 0, withAfter), level: 29 })).toBe(true);
  });
});
