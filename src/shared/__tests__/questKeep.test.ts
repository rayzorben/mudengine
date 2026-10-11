import { describe, expect, it } from 'vitest';

import { itemsQuestsWant, keptFor } from '../questKeep';
import type { Quest, QuestDoer, QuestStanding } from '../quests';

/** Smash as Paradigm writes it: rank 1 takes a quest token; a Mage's route also checks a wand. */
const SMASH: Quest = {
  id: 32,
  name: 'Smash',
  steps: [
    {
      block: 2942,
      say: ['return'],
      to: 1,
      needs: [{ kind: 'carry', item: 1247, name: 'quest token' }],
      takes: [{ id: 1247, name: 'quest token' }],
      gives: [],
      ways: [
        {
          needs: [
            { kind: 'class', id: 2, is: true, name: 'Mage' },
            { kind: 'carry', item: 900, name: 'oak wand' }
          ],
          takes: [],
          gives: []
        }
      ]
    },
    {
      block: 2943,
      say: ['altar'],
      to: 2,
      needs: [{ kind: 'floor', item: 1556, lying: true, name: 'altar of dawn' }],
      takes: [{ id: 1300, name: 'silver chalice' }],
      gives: []
    }
  ]
};

const at =
  (rank: number | null, held = rank !== null): (() => QuestStanding) =>
  () => ({
    rank,
    held
  });

/** Nothing on the sheet yet: no class, race, level or listing. */
const NOBODY: QuestDoer = { className: null, race: null, level: null, counters: null };

/** A Warrior's quest that wants a severed head and forbids NeutralQuest (counter 127). */
const GOOD: Quest = {
  id: 126,
  name: 'GoodQuest',
  steps: [
    {
      block: 100,
      say: ['head'],
      to: 1,
      who: 'Sage',
      needs: [
        { kind: 'class', id: 1, is: true, name: 'Warrior' },
        { kind: 'ability', id: 127, absent: true, name: 'NeutralQuest' }
      ],
      takes: [{ id: 684, name: 'severed head of Goru-Nezar' }],
      gives: []
    }
  ]
};

describe('the items an unfinished quest still needs', () => {
  it('keeps every route’s items while the rank is unknown, and never a floor fixture', () => {
    const wanted = itemsQuestsWant([SMASH], at(null), NOBODY);
    expect([...wanted.keys()].sort((a, b) => a - b)).toEqual([900, 1247, 1300]);
    expect(wanted.get(1247)).toBe('Smash');
  });

  it('lets go of a step’s items once the counter is past it', () => {
    expect([...itemsQuestsWant([SMASH], at(1), NOBODY).keys()]).toEqual([1300]);
    expect(itemsQuestsWant([SMASH], at(2), NOBODY).size).toBe(0);
  });

  /* `giveability 32 0` is a granted zero; a counter never named is not held. */
  it('reads a counter the listing does not name as not started', () => {
    expect(itemsQuestsWant([SMASH], at(5, false), NOBODY).size).toBe(3);
  });

  it('keeps only the character’s own class route once the class is known', () => {
    const warrior = { ...NOBODY, className: 'Warrior' };
    expect([...itemsQuestsWant([SMASH], at(null), warrior).keys()].sort()).toEqual([1247, 1300]);
    const mage = { ...NOBODY, className: 'mage' };
    expect(itemsQuestsWant([SMASH], at(null), mage).has(900)).toBe(true);
  });

  it('keeps nothing for a quest a class or a counter shuts for good', () => {
    expect(itemsQuestsWant([GOOD], at(null), NOBODY).get(684)).toBe('GoodQuest');
    expect(itemsQuestsWant([GOOD], at(null), { ...NOBODY, className: 'Mage' }).size).toBe(0);
    const started = { complete: true, sums: { 127: 1 }, at: 0 };
    const neutral = { ...NOBODY, className: 'Warrior', counters: started };
    expect(itemsQuestsWant([GOOD], at(null), neutral).size).toBe(0);
    // An incomplete listing settles nothing, so the head stays.
    const partial = { ...neutral, counters: { ...started, complete: false } };
    expect(itemsQuestsWant([GOOD], at(null), partial).get(684)).toBe('GoodQuest');
  });

  it('keeps the items of a quest the character is only too low for', () => {
    const gated: Quest = {
      ...GOOD,
      steps: [{ ...GOOD.steps[0]!, needs: [{ kind: 'level', min: 30 }] }]
    };
    const low = { ...NOBODY, className: 'Warrior', level: 4 };
    expect(itemsQuestsWant([gated], at(null), low).get(684)).toBe('GoodQuest');
  });
});

describe('which carried item a quest keeps', () => {
  const wanted = new Map([[1247, 'Smash']]);

  it('answers by the row a room settled, else by any row the name may be', () => {
    expect(keptFor(wanted, { row: { id: 1247 } })).toBe('Smash');
    expect(keptFor(wanted, { ids: [5, 1247] })).toBe('Smash');
    expect(keptFor(wanted, { id: 1247 })).toBe('Smash');
    expect(keptFor(wanted, { row: { id: 5 }, ids: [5, 1247] })).toBeNull();
  });

  it('keeps nothing the realm cannot name', () => {
    expect(keptFor(wanted, {})).toBeNull();
  });
});
