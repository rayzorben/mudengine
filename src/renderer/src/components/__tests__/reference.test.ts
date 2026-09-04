import { describe, expect, it } from 'vitest';

import { effectValues, entryKey, flattenLookup } from '../ReferenceDetail';
import type { WorldLookup, WorldSpell } from '@shared/world';

/*
 * The realm repeating a name is not hypothetical: `data-Paradigm-1.9-TEST`
 * carries two spells called `maelstrom` and two called `magic armour`, and a
 * lookup for `ma` returns both of each. A key that is not unique costs React
 * the ability to delete the older of the pair, and the row it drew is left in
 * the document after the answer that held it — dead rows above the live ones,
 * which reads as the highlight being on the wrong line.
 */
const spell = (id: number, name: string, level?: number): WorldSpell =>
  level === undefined ? { id, name } : { id, name, level };

const REPEATED: WorldLookup = {
  mobs: [],
  items: [],
  // Two rows each, with the realm's own ids, exactly as `lookup('ma')` answers.
  spells: [
    spell(292, 'maelstrom', 24),
    spell(1374, 'maelstrom', 24),
    spell(52, 'magic armour', 6),
    spell(875, 'magic armour')
  ],
  races: [],
  classes: [],
  classNames: {}
};

describe('a lookup the realm answered with a repeated name', () => {
  it('still gives every row its own key', () => {
    const entries = flattenLookup(REPEATED);
    const keys = entries.map((entry, index) => entryKey(entry, index));
    expect(entries).toHaveLength(4);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /* Two rows saying the same words are two rows; the answer is not deduped. */
  it('keeps both of them, because the realm said both', () => {
    expect(flattenLookup(REPEATED).map((entry) => entry.name)).toEqual([
      'maelstrom',
      'maelstrom',
      'magic armour',
      'magic armour'
    ]);
  });
});

describe("what a character has learned rides beside the realm's answer", () => {
  it('lands on the monster it names and nowhere else', () => {
    const entries = flattenLookup({
      mobs: [
        { name: 'giant rat', hp: 12, disposition: null, uncertain: false, costly: 'never' },
        { name: 'cave rat', hp: 20, disposition: null, uncertain: false, costly: 'never' }
      ],
      items: [],
      spells: [],
      races: [],
      classes: [],
      classNames: {},
      learned: { 'giant rat': { kill: 14, survived: 20, kills: 3, at: 1 } },
      fights: {
        'cave rat': {
          fights: 2,
          kills: 2,
          meanMine: 15,
          meanBlows: 3,
          meanMs: null,
          opened: 2,
          latest: 5
        }
      }
    });
    expect(
      entries.map((entry) => (entry.kind === 'mob' ? (entry.fights?.fights ?? null) : 'x'))
    ).toEqual([null, 2]);
    expect(
      entries.map((entry) => (entry.kind === 'mob' ? (entry.learned?.kills ?? null) : 'x'))
    ).toEqual([3, null]);
  });
});

/*
 * Which values a card shows when the realm states several for one id.
 *
 * The realm file records every value every row stated rather than resolving
 * them, because "worst" only means "highest" for a magnitude and the file must
 * not bake a display judgement in (see `BuiltMob.ab`). So the caution lives
 * here, and these are the two halves of it.
 */
describe('reading an effect the realm states more than once', () => {
  /*
   * `zombie` is three rows and they disagree about fire: -100%, -50%, -35%.
   * Listing all three asks the reader to pick, and the reassuring end is the
   * one that gets a character killed — so the least-vulnerable figure is shown,
   * the same choice `hp` makes.
   */
  it('shows the cautious end of a magnitude the rows disagree about', () => {
    expect(effectValues(5, [-100, -50, -35], 'mob')).toEqual([-35]);
    expect(effectValues(3, [100, 125], 'mob')).toEqual([125]);
  });

  /*
   * And never reduces a set. `dwarven warrior` states `MonsGuards` three times
   * — three different monsters that come to help — and a maximum kept one of
   * the three, silently. Same for the two spells a sand dragon is immune to.
   */
  it('keeps every member of a set, because each is a separate fact', () => {
    expect(effectValues(146, [396, 424, 426], 'mob')).toEqual([396, 424, 426]);
    expect(effectValues(139, [40, 45], 'mob')).toEqual([40, 45]);
    // `ClassOk` is the same shape of answer: usable by Mage *and* Priest.
    expect(effectValues(59, [12, 5], 'mob')).toEqual([12, 5]);
  });

  /** An id nothing states is not an id anything has to draw. */
  it('has nothing to say about no values at all', () => {
    expect(effectValues(5, [], 'mob')).toEqual([]);
  });
});
