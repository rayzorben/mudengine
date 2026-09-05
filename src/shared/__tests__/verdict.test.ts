import { describe, expect, it } from 'vitest';

import { rankByVerdict, verdictFor, wieldedWeapon, type Verdict } from '../verdict';
import type { Menace } from '../menace';
import type { ProwessSheet } from '../prowess';

const SHEET: ProwessSheet = {
  level: 10,
  agility: 60,
  intellect: 50,
  charm: 55,
  willpower: 50,
  health: 60,
  strength: 55,
  spellcasting: 40,
  combatLevel: 4,
  mageryLevel: null,
  encumbrancePercent: 20
};

const SWORD = { min: 5, max: 12, speed: 20, strength: 30 };

function menace(perRound: number, hp: number): Menace {
  return {
    perRound,
    blows: perRound,
    onDeath: 0,
    hp,
    weight: perRound / hp,
    hazards: [],
    wide: false
  };
}

describe('a verdict is both halves or it is honest about the missing one', () => {
  it('prices the fight in health, not in the monster’s numbers', () => {
    const result = verdictFor(
      menace(8, 120),
      { armourClass: 30, damageResist: 2, dodge: 10 },
      SHEET,
      SWORD,
      'greatermud'
    );
    expect(result.rounds?.from).toBe('bound');
    // The answer: what taking it on takes off this character.
    expect(result.cost?.value).toBeCloseTo(8 * result.rounds!.value, 6);
    expect(result.cost?.from).toBe('bound');
  });

  it('answers no cost when only one half is known', () => {
    // Half a product is not an estimate of it.
    const noRounds = verdictFor(menace(8, 120), {}, SHEET, null, 'greatermud');
    expect(noRounds.rounds).toBeNull();
    expect(noRounds.cost).toBeNull();
    expect(noRounds.menace).not.toBeNull();

    const noMenace = verdictFor(null, { hp: 120 }, SHEET, SWORD, 'greatermud');
    expect(noMenace.cost).toBeNull();
  });

  it('takes the health from the menace, which is the realm’s high end', () => {
    const tough = verdictFor(menace(8, 400), { armourClass: 30 }, SHEET, SWORD, 'greatermud');
    const easy = verdictFor(menace(8, 40), { armourClass: 30 }, SHEET, SWORD, 'greatermud');
    expect(tough.rounds!.value).toBeGreaterThan(easy.rounds!.value);
  });

  it('answers no rounds at all on a family with no formulas', () => {
    const other = verdictFor(menace(8, 120), { armourClass: 30 }, SHEET, SWORD, 'majormud');
    expect(other.rounds).toBeNull();
    expect(other.menace).not.toBeNull();
  });
});

describe('ranking on rounds rather than on health', () => {
  function verdict(perRound: number, hp: number, rounds: number | null): Verdict {
    return {
      menace: menace(perRound, hp),
      rounds: rounds === null ? null : { value: rounds, from: 'bound' },
      cost: rounds === null ? null : { value: perRound * rounds, from: 'bound' }
    };
  }

  it('reverses the order health alone would have given', () => {
    /*
     * The case health cannot see: two monsters with the same health and the
     * same damage, one of which takes four times as long to kill because this
     * character can barely hit it. `rankByMenace` calls them equal and takes
     * the first; the rounds say the quick one comes off the board first.
     */
    const slow = verdict(10, 100, 20);
    const quick = verdict(10, 100, 5);
    expect(slow.menace!.weight).toBe(quick.menace!.weight);
    expect(rankByVerdict([slow, quick])).toEqual([1, 0]);
  });

  it('still prefers the small nuisance over the big slow one', () => {
    // Smith's rule, unchanged: 30 a round over two rounds beats 50 a round
    // over thirty.
    const nuisance = verdict(30, 100, 2);
    const ogre = verdict(50, 3000, 30);
    expect(rankByVerdict([ogre, nuisance])).toEqual([1, 0]);
  });

  it('puts a monster it cannot cost after every one it can', () => {
    // Not a monster to open on. The two scales are not comparable, so the
    // fallbacks are ordered among themselves and placed last.
    const known = verdict(5, 100, 10);
    const unknown = verdict(90, 100, null);
    expect(rankByVerdict([unknown, known])).toEqual([1, 0]);
  });

  it('orders the uncostable ones among themselves by menace over health', () => {
    const worse = verdict(40, 100, null);
    const better = verdict(5, 100, null);
    expect(rankByVerdict([better, worse])).toEqual([1, 0]);
  });

  it('keeps a monster the realm cannot place first at all', () => {
    // `rankByMenace`'s own answer, and for its own reason: a monster nothing is
    // known about is the one this client has least right to walk past.
    const unplaced: Verdict = { menace: null, rounds: null, cost: null };
    expect(rankByVerdict([verdict(5, 100, 10), unplaced])).toEqual([1, 0]);
  });

  it('is stable where nothing separates two monsters', () => {
    const a = verdict(10, 100, 5);
    const b = verdict(10, 100, 5);
    expect(rankByVerdict([a, b])).toEqual([0, 1]);
  });
});

describe('what is being swung', () => {
  const sword = { equipped: true, kind: 'weapon', weapon: SWORD };
  const helm = { equipped: true, kind: 'armour', weapon: undefined };
  const spare = { equipped: false, kind: 'weapon', weapon: { min: 1, max: 2 } };

  it('is the equipped weapon and nothing else', () => {
    expect(wieldedWeapon([helm, sword, spare])).toBe(SWORD);
  });

  it('is nothing for a character fighting unarmed', () => {
    // Honest rather than convenient: martial arts is on the sheet and its
    // conversion to a damage range is not in hand.
    expect(wieldedWeapon([helm, spare])).toBeNull();
    expect(wieldedWeapon([])).toBeNull();
  });

  it('takes the first of two rather than choosing between them', () => {
    const second = { equipped: true, kind: 'weapon', weapon: { min: 50, max: 60 } };
    expect(wieldedWeapon([sword, second])).toBe(SWORD);
  });
});
