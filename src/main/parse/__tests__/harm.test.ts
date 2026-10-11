import { describe, expect, it } from 'vitest';

import { FightTracker } from '../combat';
import { harmOf } from '../harm';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { Block } from '../../../shared/blocks';
import { NO_FIGHTS } from '../../../shared/fights';
import type { HarmPrediction, HarmRecord } from '../../../shared/harm';
import { NO_LORE } from '../../../shared/lore';

/*
 * What each monster did to the character (todo 26): read off the lines on
 * it, stamped with the prediction at its first line, written at Combat Off
 * and at a death, and nowhere on a closed socket.
 */
const line = (type: Block['type'], text: string, damage?: number, at = 0): Block =>
  ({
    type,
    text,
    at,
    groups: damage === undefined ? {} : { damage: String(damage) }
  }) as unknown as Block;

const PREDICTED: HarmPrediction = {
  row: 'cave bear',
  terms: { swings: 2, lands: 0.5, perHit: 10, casts: 0, perCast: null, harm: 10 },
  odds: { kind: 'pending' },
  roundMs: 5_000
};

function fight() {
  const harm: HarmRecord[] = [];
  const asked: string[] = [];
  const tracker = new FightTracker({
    lore: NO_LORE,
    fights: NO_FIGHTS,
    harm: {
      harm: (record) => harm.push(record),
      predict: (mob) => {
        asked.push(mob);
        return PREDICTED;
      },
      taken: () => harm
    },
    withOccupant: (s) => s.room
  });
  const s: CharacterState = {
    ...structuredClone(EMPTY_CHARACTER),
    progress: { ...EMPTY_CHARACTER.progress, level: 7, armourClass: 12 }
  };
  return { tracker, harm, asked, s };
}

describe('reading a line on the character', () => {
  it('tells a blow from a cast and a miss', () => {
    expect(harmOf(line('mob-hits', 'The cave bear claws you for 9 damage!', 9))).toEqual({
      kind: 'melee',
      damage: 9
    });
    expect(
      harmOf(line('mob-hits', 'The dark priest casts unholy force on you for 38 damage!', 38))
    ).toEqual({ kind: 'spell', damage: 38 });
    expect(harmOf(line('mob-hits', 'A whirlwind of fire burns you for 13 damage!', 13))).toEqual({
      kind: 'spell',
      damage: 13
    });
    expect(harmOf(line('mob-misses', 'The cave bear swings at you, but misses!'))).toEqual({
      kind: 'miss'
    });
    expect(harmOf(line('user-takes-damage', 'You are shocked for 3 damage!', 3))).toEqual({
      kind: 'spell',
      damage: 3
    });
    expect(harmOf(line('player-attacks', 'Rend moves to attack you!'))).toBeNull();
  });
});

describe('what each monster did, written when the fight ends', () => {
  it('writes one record a monster at Combat Off, with the opening stamped', () => {
    const { tracker, harm, asked, s } = fight();
    tracker.blowOnMe(
      s,
      1_000,
      'cave bear',
      line('mob-hits', 'The cave bear claws you for 9 damage!', 9)
    );
    tracker.blowOnMe(
      s,
      1_200,
      'cave bear',
      line('mob-misses', 'The cave bear swings at you, but misses!')
    );
    tracker.blowOnMe(s, 6_000, 'kobold', line('mob-hits', 'The kobold stabs you for 3 damage!', 3));
    tracker.blowOnMe(
      s,
      6_100,
      undefined,
      line('mob-hits', 'A whirlwind of fire burns you for 13 damage!', 13)
    );
    expect(harm).toEqual([]);
    tracker.status(s, false, 7_000);

    expect(asked).toEqual(['cave bear', 'kobold']);
    const bear = harm.find((record) => record.mob === 'cave bear');
    expect(bear).toMatchObject({
      ended: 'off',
      firstAt: 1_000,
      lastAt: 1_200,
      hits: 1,
      misses: 1,
      meleeDamage: 9,
      joined: false,
      level: 7,
      armourClass: 12,
      predicted: PREDICTED
    });
    expect(harm.find((record) => record.mob === 'kobold')?.joined).toBe(true);
    expect(harm.find((record) => record.mob === null)).toMatchObject({
      casts: 1,
      spellDamage: 13,
      predicted: null
    });
  });

  it('writes the fight that killed the character, ended by the death', () => {
    const { tracker, harm, s } = fight();
    tracker.blowOnMe(
      s,
      1_000,
      'cave bear',
      line('mob-hits', 'The cave bear rips you for 40 damage!', 40)
    );
    tracker.diedHere(2_000);
    expect(harm.map((record) => [record.mob, record.ended])).toEqual([['cave bear', 'died']]);
    // And the next fight starts from nothing: no blow of the first is carried into it.
    tracker.blowOnMe(
      s,
      9_000,
      'cave bear',
      line('mob-hits', 'The cave bear rips you for 5 damage!', 5)
    );
    tracker.status(s, false, 9_500);
    expect(harm[1]).toMatchObject({ hits: 1, meleeDamage: 5, firstAt: 9_000 });
  });

  it('writes nothing for a fight a closed socket cut off', () => {
    const { tracker, harm, s } = fight();
    tracker.blowOnMe(
      s,
      1_000,
      'cave bear',
      line('mob-hits', 'The cave bear claws you for 9 damage!', 9)
    );
    tracker.forget();
    // Positive control: the same tracker does write once a fight ends.
    tracker.status(s, false, 2_000);
    expect(harm).toEqual([]);
    tracker.blowOnMe(
      s,
      3_000,
      'cave bear',
      line('mob-hits', 'The cave bear claws you for 9 damage!', 9)
    );
    tracker.status(s, false, 4_000);
    expect(harm).toHaveLength(1);
  });

  it('keeps damage naming nobody in a fight in the unnamed record, and none outside one', () => {
    const { tracker, harm, s } = fight();
    const shocked = (at: number) =>
      line('user-takes-damage', 'You are shocked for 3 damage!', 3, at);
    tracker.heard(shocked(500), s);
    tracker.status(s, false, 600);
    expect(harm).toEqual([]);
    // Positive control: the same line while something is swinging is kept.
    const fighting: CharacterState = { ...s, inCombat: true };
    tracker.blowOnMe(
      fighting,
      1_000,
      'cave bear',
      line('mob-hits', 'The cave bear claws you for 9 damage!', 9)
    );
    tracker.heard(shocked(1_100), fighting);
    tracker.status(fighting, false, 2_000);
    expect(harm.find((record) => record.mob === null)).toMatchObject({ casts: 1, spellDamage: 3 });
    expect(harm.find((record) => record.mob === 'cave bear')).toMatchObject({ hits: 1, casts: 0 });
  });

  it('settles a monster that hit with no Combat Off once the state shows no fight', () => {
    const { tracker, harm, s } = fight();
    const fighting: CharacterState = { ...s, inCombat: true };
    tracker.blowOnMe(
      fighting,
      1_000,
      'cave bear',
      line('mob-hits', 'The cave bear claws you for 9 damage!', 9)
    );
    // Still fighting: nothing is written yet.
    tracker.heard(line('room-name', 'Forest Path', undefined, 1_500), fighting);
    expect(harm).toEqual([]);
    // Walked away, no Combat Off printed: the next line settles it.
    tracker.heard(line('room-name', 'Forest Path', undefined, 4_000), s);
    expect(harm).toMatchObject([{ mob: 'cave bear', ended: 'off', at: 4_000, hits: 1 }]);
    // And a later fight with the same monster starts a record of its own.
    tracker.blowOnMe(
      fighting,
      9_000,
      'cave bear',
      line('mob-hits', 'The cave bear claws you for 4 damage!', 4)
    );
    tracker.status(fighting, false, 9_500);
    expect(harm[1]).toMatchObject({ firstAt: 9_000, meleeDamage: 4 });
  });

  it('opens no record for a miss nobody is named for', () => {
    const { tracker, harm, s } = fight();
    const fighting: CharacterState = { ...s, inCombat: true };
    tracker.blowOnMe(fighting, 1_000, undefined, line('mob-misses', 'The statue looms over you.'));
    tracker.status(fighting, false, 1_500);
    expect(harm).toEqual([]);
    // Positive control: a named miss in the same fight is kept.
    tracker.blowOnMe(
      fighting,
      2_000,
      'cave bear',
      line('mob-misses', 'The cave bear swings at you, but misses!')
    );
    tracker.status(fighting, false, 2_500);
    expect(harm).toMatchObject([{ mob: 'cave bear', misses: 1 }]);
  });
});
