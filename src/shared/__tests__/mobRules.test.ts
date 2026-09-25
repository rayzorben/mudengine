import { describe, expect, it } from 'vitest';

import {
  attacksFirst,
  hitsBack,
  isBanded,
  MOB_STANCES,
  MOB_TREATMENTS,
  normalizeMobRules,
  peaceOf,
  stanceHere,
  treated,
  type MobRule
} from '../mobRules';
import type { RoomOccupant } from '../character';

/**
 * Todo 818: MegaMUD's relationships beside the bands (`MOB_STANCES`), and its
 * *Not Hostile* on a banded row, read through one set of functions so every
 * module means the same thing by a row.
 */
describe('a row may say what a monster is', () => {
  const hostile = (name: string): Pick<RoomOccupant, 'name' | 'disposition'> => ({
    name,
    disposition: 'hostile'
  });

  it('reads the three new stances and drops what fights from them', () => {
    const rows = normalizeMobRules([
      { mob: 'Old Hermit', treat: 'friend', cast: { spell: 'harm', times: 1 } },
      { mob: 'black ooze', treat: 'escape', noBackstab: true },
      { mob: 'stalker', treat: 'hangup', notHostile: true },
      { mob: 'thug', treat: 'default', notHostile: true },
      { mob: 'typo', treat: 'freind' }
    ]);
    expect(rows).toEqual([
      { mob: 'old hermit', treat: 'friend' },
      { mob: 'black ooze', treat: 'escape' },
      { mob: 'stalker', treat: 'hangup' },
      { mob: 'thug', treat: 'default', notHostile: true }
    ]);
  });

  it('keeps the runtime list and the stances together, stances first', () => {
    expect(MOB_TREATMENTS.slice(0, MOB_STANCES.length)).toEqual([...MOB_STANCES]);
    for (const treat of MOB_TREATMENTS) {
      const row = treated({ mob: 'rat', treat: 'default' }, treat);
      expect(isBanded(row)).toBe(!(MOB_STANCES as readonly string[]).includes(treat));
    }
  });

  it('takes a stance off every way of fighting', () => {
    const banded: MobRule = {
      mob: 'rat',
      treat: 'first',
      cast: { spell: 'harm', times: 2 },
      noBackstab: true,
      notHostile: true
    };
    expect(treated(banded, 'friend')).toEqual({ mob: 'rat', treat: 'friend' });
    expect(treated(banded, 'last')).toEqual({ ...banded, treat: 'last' });
  });

  it('hits back what it would run or hang up from, and never a friend or a never', () => {
    const answers = MOB_TREATMENTS.map((treat) => [
      treat,
      hitsBack(treated({ mob: 'rat', treat: 'default' }, treat))
    ]);
    expect(Object.fromEntries(answers)).toEqual({
      never: false,
      friend: false,
      escape: true,
      hangup: true,
      first: true,
      high: true,
      default: true,
      low: true,
      last: true
    });
    expect(hitsBack(undefined)).toBe(true);
  });

  /* The realm says it attacks on sight; the row is believed over it. */
  it('believes a row that says a monster does not attack first', () => {
    const rules: MobRule[] = [
      { mob: 'old hermit', treat: 'friend' },
      { mob: 'thug', treat: 'default', notHostile: true },
      { mob: 'black ooze', treat: 'escape' }
    ];
    expect(peaceOf(rules[0])).toBe('friend');
    expect(peaceOf(rules[1])).toBe('not-hostile');
    expect(attacksFirst(hostile('Old Hermit'), null, rules)).toBe(false);
    expect(attacksFirst(hostile('thug'), null, rules)).toBe(false);
    // The control: no claim, and the realm answers as it always did.
    expect(peaceOf(rules[2])).toBeNull();
    expect(attacksFirst(hostile('black ooze'), null, rules)).toBe(true);
    expect(attacksFirst(hostile('thug'), null, [])).toBe(true);
  });

  it('finds the monster a stance names in the room, and only a monster', () => {
    const rules: MobRule[] = [{ mob: 'black ooze', treat: 'escape' }];
    const here = [
      { name: 'Black Ooze', kind: 'player' as const },
      { name: 'rat', kind: 'mob' as const },
      { name: 'black ooze', kind: 'mob' as const }
    ];
    expect(stanceHere(here, rules, 'escape')).toBe('black ooze');
    expect(stanceHere(here, rules, 'hangup')).toBeNull();
    expect(stanceHere(here.slice(0, 2), rules, 'escape')).toBeNull();
  });
});
