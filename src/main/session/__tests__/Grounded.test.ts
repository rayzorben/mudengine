import { describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { Grounded } from '../Grounded';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

function at(hp: number | null, mortallyWounded: boolean): CharacterState {
  return { ...EMPTY_CHARACTER, mortallyWounded, vitals: { ...EMPTY_CHARACTER.vitals, hp } };
}

function rig(): {
  grounded: Grounded;
  notice: ReturnType<typeof vi.fn>;
  noteSafety: ReturnType<typeof vi.fn>;
} {
  const notice = vi.fn();
  const noteSafety = vi.fn();
  return { grounded: new Grounded({ noteSafety }, { notice }), notice, noteSafety };
}

describe('Grounded', () => {
  it('lets a standing character act, and says nothing', () => {
    const { grounded, notice } = rig();
    expect(grounded.standsDown(at(40, false))).toBe(false);
    expect(notice).not.toHaveBeenCalled();
  });

  it('stands down on the ground and says so once per stretch, again after getting up', () => {
    const { grounded, notice, noteSafety } = rig();
    expect(grounded.standsDown(at(-8, true))).toBe(true);
    expect(grounded.standsDown(at(-9, true))).toBe(true);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(noteSafety.mock.calls[0]![0]).toMatchObject({
      action: 'stand down',
      because: t('session.safety.whyMortallyWounded', { hp: -8 })
    });

    expect(grounded.standsDown(at(1, false))).toBe(false);
    expect(grounded.standsDown(at(-2, true))).toBe(true);
    expect(notice).toHaveBeenCalledTimes(2);
  });

  /* Down before any status line stated the figure: null is not zero. */
  it('does not call an unread figure zero', () => {
    const { grounded, noteSafety } = rig();
    grounded.standsDown(at(null, true));
    expect(noteSafety.mock.calls[0]![0].because).toBe(t('session.safety.whyMortallyWoundedUnread'));
  });
});
