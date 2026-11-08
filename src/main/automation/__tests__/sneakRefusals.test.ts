import { describe, expect, it } from 'vitest';

import { SneakRefusals } from '../sneakRefusals';
import { t } from '../../app/i18n';

const MOVE = { sneak: true, sneakGiveUp: 2 };
const at = (level: number, stealthSkill: number | null = 64) => ({ level, stealthSkill });

describe('refused sneaks in a row', () => {
  it('gives up at the limit, said once, and starts again at a new level', () => {
    const said: string[] = [];
    const refusals = new SneakRefusals(MOVE, (m) => said.push(m));
    expect(refusals.givenUp(at(5))).toBe(false);
    refusals.refused();
    refusals.refused();
    refusals.refused();
    expect(refusals.givenUp(at(5))).toBe(true);
    expect(said).toEqual([t('automation.walk.sneakGaveUp', { count: 2 })]);
    expect(refusals.givenUp(at(6))).toBe(false);
  });

  // Rayzor, 2026-11-08: four refused at -63 while Heavy, then 64 once the raft was dropped.
  it('starts again when the sheet shows another Stealth figure', () => {
    const refusals = new SneakRefusals(MOVE);
    refusals.givenUp(at(21, -63));
    refusals.refused();
    refusals.refused();
    expect(refusals.givenUp(at(21, -63))).toBe(true);
    expect(refusals.givenUp(at(21, 64))).toBe(false);
  });

  it('counts only refusals in a row', () => {
    const refusals = new SneakRefusals(MOVE);
    refusals.givenUp(at(5));
    refusals.refused();
    refusals.sneaked();
    refusals.refused();
    expect(refusals.givenUp(at(5))).toBe(false);
  });

  it('starts again when Auto-Sneak on Move is turned on', () => {
    const refusals = new SneakRefusals(MOVE);
    refusals.givenUp(at(5));
    refusals.refused();
    refusals.refused();
    refusals.configure({ ...MOVE, sneak: false });
    expect(refusals.givenUp(at(5))).toBe(true);
    refusals.configure(MOVE);
    expect(refusals.givenUp(at(5))).toBe(false);
  });
});
