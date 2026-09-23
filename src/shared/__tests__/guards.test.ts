import { describe, expect, it } from 'vitest';

import { GUARDED_BY_ABILITY, guardsFirst, inTheFight, protects, type Guardable } from '../guards';

/** A monster of these realm rows, protected by the rows in `by`. */
function monster(name: string, ids: number[], by: number[] = []): Guardable {
  return {
    name,
    mob: {
      ids,
      ...(by.length === 0
        ? {}
        : { abilities: by.map((row): [number, number] => [GUARDED_BY_ABILITY, row]) })
    }
  };
}

describe('who protects whom', () => {
  /* The ability sits on the ward and names its guards' rows
     (`Mob.GetGuardedByMobTypes`), not the other way round. */
  it('reads the list off the one protected', () => {
    const chief = monster('tasloi chief', [7], [10]);
    const warrior = monster('tasloi warrior', [10]);
    expect(protects(warrior, chief)).toBe(true);
    expect(protects(chief, warrior)).toBe(false);
  });

  /* `dwarven guard` is rows 395 and 396; only 396 protects champion gudruk. */
  it('is a maybe where only some of the guard’s rows are listed', () => {
    const gudruk = monster('champion gudruk', [429], [396]);
    expect(protects(monster('dwarven guard', [395, 396]), gudruk)).toBeNull();
    expect(
      protects(
        {
          name: 'dwarven guard',
          mob: { ids: [395, 396], row: { id: 396, how: 'here', steps: 0, beyond: null } }
        },
        gudruk
      )
    ).toBe(true);
  });

  /* `champion gudruk` 429 lists 396 and its row 465 lists nobody: the
     realm file folds the two, so which row stands here is unknown. */
  it('is a maybe where the one protected is several rows', () => {
    expect(
      protects(monster('dwarven guard', [396]), monster('champion gudruk', [429, 465], [396]))
    ).toBeNull();
  });

  it('never counts one of a name as protecting another of it', () => {
    expect(protects(monster('dwarven guard', [395]), monster('dwarven guard', [395], [395]))).toBe(
      false
    );
  });

  it('says no for a monster the realm cannot place', () => {
    expect(protects({ name: 'thing' }, monster('tasloi chief', [7], [10]))).toBe(false);
  });
});

describe('the order a room is fought in', () => {
  it('takes the guard of the first-ranked before it, not the next in the ranking', () => {
    const room = [
      monster('tasloi chief', [7], [10]),
      monster('kobold', [3]),
      monster('tasloi warrior', [10])
    ];
    expect(guardsFirst([0, 1, 2], room)).toEqual([2, 0, 1]);
  });

  it('follows a chain of guards to its end', () => {
    const room = [
      monster('orc warlord', [724], [725]),
      monster('orc captain', [725], [727]),
      monster('orc lieutenant', [727])
    ];
    expect(guardsFirst([0, 1, 2], room)).toEqual([2, 1, 0]);
  });

  /* `hill giant chieftan` ← `hill giant` ↔ `hill giant shaman`: the cycle
     cannot be escaped, but the chieftan outside it can wait. */
  it('stops a chain that runs into a cycle inside the cycle', () => {
    const room = [
      monster('hill giant chieftan', [1], [2]),
      monster('hill giant', [2], [3]),
      monster('hill giant shaman', [3], [2])
    ];
    expect(guardsFirst([0, 1, 2], room)[0]).not.toBe(0);
  });

  /* `duergar captain` and `duergar warrior` protect each other. */
  it('keeps the ranking where two protect each other', () => {
    const room = [monster('duergar captain', [1], [2]), monster('duergar warrior', [2], [1])];
    expect(guardsFirst([1, 0], room)).toEqual([1, 0]);
  });

  it('counts a maybe, since both are being fought anyway', () => {
    const room = [monster('champion gudruk', [429], [396]), monster('dwarven guard', [395, 396])];
    expect(guardsFirst([0, 1], room)).toEqual([1, 0]);
  });
});

describe('who ends up in the fight', () => {
  const chief = monster('tasloi chief', [7], [10]);
  const warrior = monster('tasloi warrior', [10], [11]);
  const shaman = monster('tasloi shaman', [11]);
  const rat = monster('giant rat', [4]);
  const room = [rat, chief, warrior, shaman];

  it('brings in a bystander that protects one being fought, and whoever protects it', () => {
    expect(
      inTheFight(
        room,
        (who) => who === chief,
        () => true
      )
    ).toEqual([chief, warrior, shaman]);
  });

  it('leaves a bystander it is only a maybe for', () => {
    const gudruk = monster('champion gudruk', [429], [396]);
    const guard = monster('dwarven guard', [395, 396]);
    expect(
      inTheFight(
        [gudruk, guard],
        (who) => who === gudruk,
        () => true
      )
    ).toEqual([gudruk]);
  });

  it('brings in nobody the caller did not offer', () => {
    expect(
      inTheFight(
        room,
        (who) => who === chief,
        (who) => who === rat
      )
    ).toEqual([chief]);
  });
});
