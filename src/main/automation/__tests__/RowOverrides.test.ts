import { describe, expect, it } from 'vitest';

import { RowOverrides, type RowOverridesSettings } from '../RowOverrides';
import { t } from '../../app/i18n';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { classifyOccupant, type MobDisposition } from '../../../shared/mobs';
import type { MobRule } from '../../../shared/mobRules';

function mob(name: string, disposition: MobDisposition): RoomOccupant {
  return classifyOccupant(name, {
    players: new Set<string>(),
    mob: () => ({ disposition, uncertain: false, costly: 'never' })
  });
}

function here(...occupants: RoomOccupant[]): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return { ...base, phase: 'in-game', room: { ...base.room, name: 'A Road', occupants } };
}

const settings = (mobRules: MobRule[], enabled = true): RowOverridesSettings => ({
  enabled,
  combat: { mobRules }
});

/*
 * Todo 818: a row saying a monster does not attack first, where the realm says
 * it does, is followed by every reader and said once a connection — never
 * where the two agree.
 */
describe('a row overruling the realm', () => {
  const rows: MobRule[] = [
    { mob: 'giant rat', treat: 'friend' },
    { mob: 'hermit', treat: 'friend' },
    { mob: 'thug', treat: 'default', notHostile: true }
  ];

  it('is said once for each monster, and again after a reset', () => {
    const notices: string[] = [];
    const overrides = new RowOverrides(settings(rows), { notice: (line) => notices.push(line) });
    const state = here(mob('giant rat', 'hostile'), mob('thug', 'hostile'));
    overrides.onCharacter(state);
    overrides.onCharacter(state);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toBe(t('automation.combat.overrideFriend', { target: 'giant rat' }));
    expect(notices[1]).toBe(t('automation.combat.overrideNotHostile', { target: 'thug' }));
    overrides.reset();
    overrides.onCharacter(state);
    expect(notices).toHaveLength(4);
  });

  it('says nothing where the realm agrees, or with no row, or automation off', () => {
    const notices: string[] = [];
    const quiet = new RowOverrides(settings(rows), { notice: (line) => notices.push(line) });
    quiet.onCharacter(here(mob('hermit', 'passive')));
    const unlisted = new RowOverrides(settings([]), { notice: (line) => notices.push(line) });
    unlisted.onCharacter(here(mob('giant rat', 'hostile')));
    const off = new RowOverrides(settings(rows, false), { notice: (line) => notices.push(line) });
    off.onCharacter(here(mob('giant rat', 'hostile')));
    expect(notices).toEqual([]);
    // The control: the same unit, turned on, speaks.
    off.configure(settings(rows));
    off.onCharacter(here(mob('giant rat', 'hostile')));
    expect(notices).toHaveLength(1);
  });
});
