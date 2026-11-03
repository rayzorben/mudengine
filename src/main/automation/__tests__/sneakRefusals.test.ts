import { describe, expect, it } from 'vitest';

import { SneakRefusals } from '../sneakRefusals';
import { t } from '../../app/i18n';

const MOVE = { sneak: true, sneakGiveUp: 2 };

describe('refused sneaks in a row', () => {
  it('gives up at the limit, said once, and starts again at a new level', () => {
    const said: string[] = [];
    const refusals = new SneakRefusals(MOVE, (m) => said.push(m));
    expect(refusals.givenUp(5)).toBe(false);
    refusals.refused();
    refusals.refused();
    refusals.refused();
    expect(refusals.givenUp(5)).toBe(true);
    expect(said).toEqual([t('automation.walk.sneakGaveUp', { count: 2 })]);
    expect(refusals.givenUp(6)).toBe(false);
  });

  it('counts only refusals in a row', () => {
    const refusals = new SneakRefusals(MOVE);
    refusals.givenUp(5);
    refusals.refused();
    refusals.sneaked();
    refusals.refused();
    expect(refusals.givenUp(5)).toBe(false);
  });

  it('starts again when Auto-Sneak on Move is turned on', () => {
    const refusals = new SneakRefusals(MOVE);
    refusals.givenUp(5);
    refusals.refused();
    refusals.refused();
    refusals.configure({ ...MOVE, sneak: false });
    expect(refusals.givenUp(5)).toBe(true);
    refusals.configure(MOVE);
    expect(refusals.givenUp(5)).toBe(false);
  });
});
