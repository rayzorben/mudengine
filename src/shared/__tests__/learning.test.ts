import { describe, expect, it } from 'vitest';

import { MAX_LEVEL_ABILITY, MIN_LEVEL_ABILITY } from '../abilities';
import { learnVerdict, scrollLesson, taughtBy, withSpell, type Learner } from '../learning';
import { poolOf } from '../spellchoice';

/*
 * `Spell.CanPlayerUseSpell`, as `read` asks it (todo 20). The codes are the
 * server's `SpellMageryType`: 1 Mage, 2 Priest. Magic missile is type 1
 * level 1; the Mage class is type 1 level 3, the Warrior 0.
 */
const MAGE: Learner = { mageryType: 1, mageryLevel: 3, level: 1, alignment: null };
const WARRIOR: Learner = { mageryType: 0, mageryLevel: 0, level: 1, alignment: null };
const MISSILE = { mageryType: 1, mageryLevel: 1 };

describe('who may learn a spell', () => {
  it('teaches a spell of the class’s magery type and level', () => {
    expect(learnVerdict(MISSILE, MAGE)).toEqual({ kind: 'learns' });
  });

  it('refuses another type, as captures/219 has a Warrior refused magic missile', () => {
    expect(learnVerdict(MISSILE, WARRIOR)).toEqual({ kind: 'refused', why: 'magery' });
  });

  it('refuses a magery level above the class’s', () => {
    const gypsy: Learner = { ...MAGE, mageryLevel: 2 };
    expect(learnVerdict({ mageryType: 1, mageryLevel: 3 }, gypsy)).toEqual({
      kind: 'refused',
      why: 'magery-level'
    });
  });

  it('teaches a type 0 spell to any class', () => {
    expect(learnVerdict({}, WARRIOR)).toEqual({ kind: 'learns' });
  });

  it('reads the level rows, and not the spell’s cast level', () => {
    const banded = { abilities: [[MIN_LEVEL_ABILITY, 5] as [number, number]] };
    expect(learnVerdict(banded, MAGE)).toEqual({ kind: 'refused', why: 'too-low' });
    const capped = { abilities: [[MAX_LEVEL_ABILITY, 0] as [number, number]] };
    expect(learnVerdict(capped, MAGE)).toEqual({ kind: 'refused', why: 'too-high' });
  });

  it('refuses on an alignment row the whole band fails', () => {
    // Evil (98): refused below 40 points, which every Saint is.
    const evil = { abilities: [[98, 0] as [number, number]] };
    expect(learnVerdict(evil, { ...MAGE, alignment: 'Saint' })).toEqual({
      kind: 'refused',
      why: 'alignment'
    });
  });

  // `CanPlayerUseSpell` ends on `reqLevel > Level`: "Too powerful" (Spell.cs:424).
  it('refuses a spell above the character’s level, and is unknown on an unread level', () => {
    expect(learnVerdict({ ...MISSILE, level: 8 }, MAGE)).toEqual({
      kind: 'refused',
      why: 'req-level'
    });
    expect(learnVerdict({ ...MISSILE, level: 1 }, MAGE)).toEqual({ kind: 'learns' });
    expect(learnVerdict({ ...MISSILE, level: 8 }, { ...MAGE, level: null })).toEqual({
      kind: 'unknown'
    });
  });

  it('is unknown on an alignment row with the alignment unread', () => {
    expect(learnVerdict({ abilities: [[98, 0]] }, MAGE)).toEqual({ kind: 'unknown' });
  });

  it('is unknown where the class row states no magery type, and never refuses for it', () => {
    const unread: Learner = { mageryType: null, mageryLevel: null, level: 1, alignment: null };
    expect(learnVerdict(MISSILE, unread)).toEqual({ kind: 'unknown' });
  });
});

describe('a spell added to a book', () => {
  it('appends the realm’s columns once', () => {
    const book = withSpell([], 'magic missile', { short: 'mmis', level: 1, mana: 3 });
    expect(book).toEqual([{ name: 'magic missile', short: 'mmis', level: 1, cost: 3 }]);
    expect(withSpell(book, 'Magic Missile', null)).toBe(book);
  });
});

describe('the scroll and the pool', () => {
  it('reads every spell a scroll’s LearnSp names', () => {
    expect(
      taughtBy({
        abilities: [
          [42, 1],
          [17, 0],
          [42, 13]
        ]
      })
    ).toEqual([1, 13]);
  });

  // A Mystic's book is kai before a statline says so, so no attack is cast from it.
  it('takes the pool from the class row until the wire says', () => {
    expect(poolOf(null, 5)).toBe('KAI');
    expect(poolOf(null, 1)).toBe('MA');
    expect(poolOf(null, 0)).toBeNull();
    expect(poolOf('MA', 5)).toBe('MA');
  });
});

/*
 * Todo 770: a scroll on a shop's shelf. The user's own example: a Priest
 * (Priest 3) can learn Priest 1-3 spells, a Cleric (Priest 2) only Priest 1-2,
 * and a Mage spell is refused to both.
 */
describe('what a scroll on the shelf would teach', () => {
  const PRIEST: Learner = { mageryType: 2, mageryLevel: 3, level: 10, alignment: null };
  const CLERIC: Learner = { ...PRIEST, mageryLevel: 2 };
  const prayer = (name: string, mageryLevel: number) => ({ name, mageryType: 2, mageryLevel });
  const book = [{ name: 'Minor Healing', short: 'mihe', level: 1, cost: 2 }];

  it('learns by magery type and level, as the user put it', () => {
    const third = [prayer('cure poison', 3)];
    expect(scrollLesson(third, PRIEST, [])?.verdict).toEqual({ kind: 'learns' });
    expect(scrollLesson(third, CLERIC, [])?.verdict).toEqual({
      kind: 'refused',
      why: 'magery-level'
    });
    expect(scrollLesson([prayer('bless', 2)], CLERIC, [])?.verdict).toEqual({ kind: 'learns' });
    const missile = [{ name: 'magic missile', mageryType: 1, mageryLevel: 1 }];
    expect(scrollLesson(missile, PRIEST, [])?.verdict).toEqual({ kind: 'refused', why: 'magery' });
  });

  it('is learned when the book lists every spell, and unknown when the book was never read', () => {
    const healing = [prayer('minor healing', 1)];
    expect(scrollLesson(healing, PRIEST, book)?.learned).toBe(true);
    expect(scrollLesson([prayer('bless', 1)], PRIEST, book)?.learned).toBe(false);
    expect(scrollLesson(healing, PRIEST, null)?.learned).toBeNull();
  });

  it('takes the first refusal, and is unknown where the class is', () => {
    const two = [prayer('bless', 1), prayer('cure poison', 3)];
    expect(scrollLesson(two, CLERIC, [])?.verdict).toEqual({
      kind: 'refused',
      why: 'magery-level'
    });
    const unread: Learner = { ...PRIEST, mageryType: null, mageryLevel: null };
    expect(scrollLesson(two, unread, [])?.verdict).toEqual({ kind: 'unknown' });
  });

  it('is nothing for a thing that teaches nothing', () => {
    expect(scrollLesson([], PRIEST, book)).toBeNull();
  });
});
