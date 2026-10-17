import { describe, expect, it } from 'vitest';

import {
  attacksFirst,
  hitsBack,
  inheritedRows,
  mergeMobRules,
  mobRuleFor,
  sourcesBeneath,
  isBanded,
  MOB_STANCES,
  MOB_TREATMENTS,
  normalizeMobRules,
  peaceOf,
  stanceHere,
  stopsToKill,
  treated,
  type MobRule
} from '../mobRules';
import type { RoomOccupant } from '../character';
import type { Standing } from '../mobs';

/**
 * Todo 818: MegaMUD's relationships beside the bands (`MOB_STANCES`), and its
 * *Not Hostile* on a banded row, read through one set of functions so every
 * module means the same thing by a row.
 */
describe('a row may say what a monster is', () => {
  const hostile = (name: string): Pick<RoomOccupant, 'name' | 'disposition' | 'mob'> => ({
    name,
    disposition: 'hostile'
  });
  const unranked: Standing = { alignment: null, pack: [] };

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

  it('reads stop to kill off a banded row only', () => {
    const rows = normalizeMobRules([
      { mob: 'Cave Bear', treat: 'high', stopToKill: true },
      { mob: 'town guard', treat: 'never', stopToKill: true },
      { mob: 'rat', treat: 'low', stopToKill: 'yes' }
    ]);
    expect(rows).toEqual([
      { mob: 'cave bear', treat: 'high', stopToKill: true },
      { mob: 'town guard', treat: 'never' },
      { mob: 'rat', treat: 'low' }
    ]);
    expect(stopsToKill(rows, 'the cave bear')).toBe(true);
    expect(stopsToKill(rows, 'town guard')).toBe(false);
    expect(stopsToKill(rows, 'rat')).toBe(false);
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
    expect(attacksFirst(hostile('Old Hermit'), unranked, rules)).toBe(false);
    expect(attacksFirst(hostile('thug'), unranked, rules)).toBe(false);
    // The control: no claim, and the realm answers as it always did.
    expect(peaceOf(rules[2])).toBeNull();
    expect(attacksFirst(hostile('black ooze'), unranked, rules)).toBe(true);
    expect(attacksFirst(hostile('thug'), unranked, [])).toBe(true);
  });

  it('finds the monster a stance names in the room', () => {
    const rules: MobRule[] = [{ mob: 'black ooze', treat: 'escape' }];
    const here = [
      { name: 'rat', kind: 'mob' as const },
      { name: 'black ooze', kind: 'mob' as const }
    ];
    expect(stanceHere(here, rules, 'escape')).toBe('black ooze');
    expect(stanceHere(here, rules, 'hangup')).toBeNull();
    expect(stanceHere(here.slice(0, 1), rules, 'escape')).toBeNull();
  });

  it('reaches a player the row names for a leaving stance, and only for one (todo 87)', () => {
    const rules: MobRule[] = [
      { mob: 'Nusse', treat: 'hangup' },
      { mob: 'Vaelor', treat: 'never' }
    ];
    const here = [
      { name: 'Vaelor', kind: 'player' as const },
      { name: 'Nusse', kind: 'player' as const }
    ];
    expect(stanceHere(here, rules, 'hangup')).toBe('Nusse');
    expect(stanceHere(here, rules, 'escape')).toBeNull();
    // `never` and `friend` stay the monsters' own.
    expect(stanceHere(here, rules, 'never')).toBeNull();
    expect(stanceHere([{ name: 'Nusse', kind: 'unknown' as const }], rules, 'hangup')).toBe(
      'Nusse'
    );
  });
});

/* Todo 817: MegaMUD's table is the lowest scope, and a form shows what it inherits. */
describe('the monster lists beneath a form', () => {
  const megamud: MobRule[] = [
    { mob: 'orc', treat: 'never' },
    { mob: 'troll', treat: 'high' }
  ];
  const global: MobRule[] = [{ mob: 'orc', treat: 'low' }];

  it('lets every narrower scope replace a MegaMUD row, and a default band cancel its stance', () => {
    const merged = mergeMobRules(megamud, global, [{ mob: 'troll', treat: 'default' }]);
    expect(mobRuleFor(merged, 'an orc')).toEqual({ mob: 'orc', treat: 'low' });
    expect(mobRuleFor(merged, 'Troll')).toEqual({ mob: 'troll', treat: 'default' });
    expect(mobRuleFor(merged, 'goblin')).toBeUndefined();
  });

  it('finds a row by the first one for its monster, in a list of hundreds', () => {
    const many = Array.from({ length: 700 }, (_, at): MobRule => ({
      mob: `mob ${at}`,
      treat: 'low'
    }));
    const rows = [...many, { mob: 'mob 3', treat: 'never' } as MobRule];
    expect(mobRuleFor(rows, 'mob 3')).toEqual({ mob: 'mob 3', treat: 'low' });
    expect(mobRuleFor(rows, 'mob 699')?.treat).toBe('low');
  });

  it('keeps 64 rows a scope unless the caller says more', () => {
    const many = Array.from({ length: 100 }, (_, at) => ({ mob: `mob ${at}`, treat: 'low' }));
    expect(normalizeMobRules(many)).toHaveLength(64);
    expect(normalizeMobRules(many, 1000)).toHaveLength(100);
  });

  it('shows the narrowest inherited row per monster, marked where the form replaces it', () => {
    const rows = inheritedRows(
      [
        { source: 'megamud', rows: megamud },
        { source: 'global', rows: global }
      ],
      [{ mob: 'Troll', treat: 'last' }]
    );
    expect(rows).toEqual([
      { row: { mob: 'orc', treat: 'low' }, source: 'global', replaced: false },
      { row: { mob: 'troll', treat: 'high' }, source: 'megamud', replaced: true }
    ]);
  });

  it('puts MegaMUD beneath every scope, and the realm only beneath a character', () => {
    expect(sourcesBeneath('global')).toEqual(['megamud']);
    expect(sourcesBeneath('realm')).toEqual(['megamud', 'global']);
    expect(sourcesBeneath('character')).toEqual(['megamud', 'global', 'realm']);
  });
});
