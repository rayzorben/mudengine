import { describe, expect, it } from 'vitest';

import {
  canRestore,
  dropAllPlan,
  equip,
  equipAllPlan,
  equipBlock,
  GEAR_ACTIONS,
  isWearable,
  learnLoadout,
  restorePlan,
  unequip,
  UNKNOWN_WEARER,
  type EquipRestrictions,
  type Loadout,
  type Wearer
} from '../gear';
import type { CarriedItem } from '../character';
import { wireItem } from '../entities';

const NOW = 1_700_000_000_000;

function carried(over: Partial<CarriedItem> & { name: string }): CarriedItem {
  return { ...wireItem(over.name), ...over };
}

/** Everything worn is a fact only a listing states; everything else is in the pack. */
const worn = (name: string, slot: string): CarriedItem => carried({ name, slot, equipped: true });

describe('learning what is in each slot', () => {
  it('records a listing worn items against their slots', () => {
    const after = learnLoadout([], [worn('padded helm', 'Head'), carried({ name: 'rope' })], NOW);
    expect(after).toEqual([{ slot: 'Head', item: 'padded helm', at: NOW }]);
  });

  /*
   * Both halves are required. `equipped` with no slot is an item in use
   * somewhere no listing has named, and filing it under a slot word the client
   * does not have would invent the one thing this must not.
   */
  it('does not file something worn in a slot nothing has named', () => {
    expect(learnLoadout([], [carried({ name: 'torch', equipped: true })], NOW)).toEqual([]);
  });

  /*
   * The whole point: a slot is never emptied by an item coming off. Dying takes
   * everything off, and a loadout that forgot at that moment would forget
   * exactly when it is wanted.
   */
  it('keeps a slot after the item in it comes off', () => {
    const held = learnLoadout([], [worn('padded helm', 'Head')], NOW);
    const after = learnLoadout(held, [carried({ name: 'padded helm' })], NOW + 1000);
    expect(after).toBe(held);
  });

  /* Swapping a helm by hand re-teaches the loadout, with no second gesture. */
  it('replaces a slot when something else goes into it', () => {
    const held = learnLoadout([], [worn('padded helm', 'Head')], NOW);
    const after = learnLoadout(held, [worn('iron helm', 'Head')], NOW + 1000);
    expect(after).toEqual([{ slot: 'Head', item: 'iron helm', at: NOW + 1000 }]);
  });

  /* A listing restates every slot on every `i`; writing the file for one that
     said the same kit is a disk touched for nothing. */
  it('returns what it was handed when nothing moved', () => {
    const held = learnLoadout([], [worn('padded helm', 'Head')], NOW);
    expect(learnLoadout(held, [worn('padded helm', 'Head')], NOW + 5000)).toBe(held);
  });

  /* The listing annotates and prose does not — `padded helm (Head)` against
     `padded helm` is one item, which is `sameItem`'s whole job. */
  it('reads the listing spelling and the sentence spelling as one item', () => {
    const held = learnLoadout([], [worn('padded helm', 'Head')], NOW);
    expect(learnLoadout(held, [worn('the padded helm', 'Head')], NOW + 1)).toBe(held);
  });

  it('sorts by slot, so a file written twice from the same facts is the same file', () => {
    const after = learnLoadout(
      [],
      [worn('boots', 'Feet'), worn('helm', 'Head'), worn('vest', 'Torso')],
      NOW
    );
    expect(after.map((entry) => entry.slot)).toEqual(['Feet', 'Head', 'Torso']);
  });
});

describe('putting back what was on', () => {
  const loadout: Loadout = [
    { slot: 'Head', item: 'padded helm', at: NOW },
    { slot: 'Torso', item: 'padded vest', at: NOW }
  ];

  it('wears what the pack holds and the character is not using', () => {
    const plan = restorePlan(
      loadout,
      [carried({ name: 'padded helm' }), carried({ name: 'padded vest' })],
      10
    );
    expect(plan.commands).toEqual(['wear padded helm', 'wear padded vest']);
    expect(plan.missing).toEqual([]);
  });

  /* Re-wearing something already on earns `You are already wearing …`, a
     command spent to be told so. */
  it('leaves alone what is already in use', () => {
    const plan = restorePlan(
      loadout,
      [worn('padded helm', 'Head'), carried({ name: 'padded vest' })],
      10
    );
    expect(plan.commands).toEqual(['wear padded vest']);
  });

  /*
   * After a death the difference between "put back on" and "gone" is the thing
   * the player most needs to know, and a button that quietly did one of two
   * would hide it.
   */
  it('reports kit the pack no longer holds rather than asking for it', () => {
    const plan = restorePlan(loadout, [carried({ name: 'padded helm' })], 10);
    expect(plan.commands).toEqual(['wear padded helm']);
    expect(plan.missing).toEqual(['padded vest']);
  });

  it('does nothing at all when everything is already on', () => {
    const plan = restorePlan(
      loadout,
      [worn('padded helm', 'Head'), worn('padded vest', 'Torso')],
      10
    );
    expect(plan).toEqual({ commands: [], missing: [], overflow: 0 });
  });

  /* Each one is a command out of the budget a fight is fought with. */
  it('stops at the cap and says how many were left', () => {
    const many: Loadout = Array.from({ length: 5 }, (_, at) => ({
      slot: `Slot${at}`,
      item: `item${at}`,
      at: NOW
    }));
    const plan = restorePlan(
      many,
      many.map((entry) => carried({ name: entry.item })),
      2
    );
    expect(plan.commands).toHaveLength(2);
    expect(plan.overflow).toBe(3);
  });

  /* The button is greyed from the same function that would run, so a lit
     button is one that will do something. */
  it('answers whether there is anything to put back', () => {
    expect(canRestore(loadout, [carried({ name: 'padded helm' })])).toBe(true);
    expect(canRestore(loadout, [worn('padded helm', 'Head')])).toBe(false);
    expect(canRestore([], [carried({ name: 'padded helm' })])).toBe(false);
  });
});

describe('putting on everything the realm says can be worn', () => {
  const wearable = (name: string): boolean => name !== 'healing potion';

  it('wears what the realm places in a slot and leaves the rest', () => {
    const plan = equipAllPlan(
      [carried({ name: 'padded helm' }), carried({ name: 'healing potion' })],
      wearable,
      10
    );
    expect(plan.commands).toEqual(['wear padded helm']);
  });

  it('leaves alone what is already in use', () => {
    const plan = equipAllPlan([worn('padded helm', 'Head')], wearable, 10);
    expect(plan.commands).toEqual([]);
  });

  /* Asking twice puts the spare on the same hands, which the server refuses. */
  it('asks once for two of one name', () => {
    const plan = equipAllPlan(
      [carried({ name: 'padded gloves' }), carried({ name: 'padded gloves' })],
      wearable,
      10
    );
    expect(plan.commands).toEqual(['wear padded gloves']);
  });

  /*
   * An item the realm does not know answers no. A private realm's own item is
   * exactly where the client knows nothing, and a wrong `wear` is broadcast.
   */
  it('offers nothing for a pack the realm cannot place', () => {
    expect(equipAllPlan([carried({ name: 'strange thing' })], () => false, 10).commands).toEqual(
      []
    );
  });
});

describe('putting the pack on the floor', () => {
  /* `drop` takes an item off on the way down, and a *Drop all* that left the
     kit on would be one nobody could use for the thing it is for. */
  it('drops what is worn as well as what is carried', () => {
    const plan = dropAllPlan([worn('padded helm', 'Head'), carried({ name: 'rope' })], 10);
    expect(plan.commands).toEqual(['drop padded helm', 'drop rope']);
  });

  it('stops at the cap and says how many were left', () => {
    const pack = Array.from({ length: 4 }, (_, at) => carried({ name: `item${at}` }));
    const plan = dropAllPlan(pack, 2);
    expect(plan.commands).toHaveLength(2);
    expect(plan.overflow).toBe(2);
  });

  it('does nothing with an empty pack', () => {
    expect(dropAllPlan([], 10)).toEqual({ commands: [], missing: [], overflow: 0 });
  });
});

describe('one item, on and off again', () => {
  /*
   * The two single-row buttons, which are the only gear actions that compose no
   * plan — main resolves the name against the pack and sends one of these.
   */
  it('puts one on with the realm’s own verb', () => {
    expect(equip('padded helm')).toBe('wear padded helm');
  });

  /* `remove`, never `drop`: the second would put the kit on the floor of a
     room anybody standing in can pick it up from. */
  it('takes one off without putting it on the floor', () => {
    expect(unequip('padded helm')).toBe('remove padded helm');
  });

  /*
   * Both halves of the union move together. Main validates a renderer's
   * payload against this list before anything reaches a socket, and an action
   * the card can send but the list does not name is a button that silently
   * does nothing.
   */
  it('names both of them in the closed union main checks against', () => {
    expect(GEAR_ACTIONS).toContain('equip');
    expect(GEAR_ACTIONS).toContain('remove');
  });
});

/*
 * The realm's own restriction columns, measured against `gmud20230902` on
 * 2026-08-31 and checked here against the one case there is a transcript for:
 * a Mystic clicked the pack's own button for a `silver holy amulet` and the
 * server answered `You may not wear that item!`.
 */
describe('who the realm lets wear a thing', () => {
  /** The Mystic from the transcript: class 15, race Halfling, level 28. */
  const mystic: Wearer = {
    classId: 15,
    raceId: 4,
    level: 28,
    strength: 40,
    classNames: { 3: 'Paladin', 4: 'Cleric', 5: 'Priest', 6: 'Missionary', 15: 'Mystic' },
    raceNames: { 4: 'Halfling', 5: 'Elf' }
  };

  const item = (over: EquipRestrictions = {}): EquipRestrictions => ({ slot: 'Neck', ...over });

  it('refuses an item whose class list leaves this character out', () => {
    // `silver holy amulet`: ClassRest 3, 4, 5, 6 — the four holy classes.
    const blocked = equipBlock(item({ classes: [3, 4, 5, 6] }), mystic);
    expect(blocked).toEqual({ kind: 'class', allowed: [3, 4, 5, 6] });
  });

  /* The positive control from the same transcript, and the reason the list is
     read as an allow-list rather than a deny-list: `silver ring` restricts
     nobody and went on without complaint. */
  it('allows an item that restricts nobody', () => {
    expect(equipBlock(item(), mystic)).toBeNull();
  });

  it('allows an item whose class list names this character', () => {
    expect(equipBlock(item({ classes: [12, 15] }), mystic)).toBeNull();
  });

  it('refuses on race the same way', () => {
    // `Caladbolg` is the realm's one race-restricted item: Elf, and this is a
    // Halfling.
    expect(equipBlock(item({ races: [5] }), mystic)).toEqual({ kind: 'race', allowed: [5] });
  });

  it('refuses an item above this character’s level', () => {
    expect(equipBlock(item({ minLevel: 50 }), mystic)).toEqual({
      kind: 'level',
      needs: 50,
      has: 28
    });
  });

  it('allows an item at exactly the level it asks for', () => {
    expect(equipBlock(item({ minLevel: 28 }), mystic)).toBeNull();
  });

  it('refuses a weapon this character cannot lift', () => {
    expect(equipBlock(item({ weapon: { strength: 90 } }), mystic)).toEqual({
      kind: 'strength',
      needs: 90,
      has: 40
    });
  });

  /*
   * The rule this whole feature turns on. Race, class and level are null until
   * a stat sheet has printed, and a client that read those as "level 0, no
   * class" would grey out the entire pack of a character that had merely not
   * typed `st` yet — hiding wearable kit behind a reason it cannot state.
   */
  it('refuses nothing while the character is unknown', () => {
    const strict = item({ classes: [3], races: [5], minLevel: 99, weapon: { strength: 99 } });
    expect(equipBlock(strict, UNKNOWN_WEARER)).toBeNull();
  });

  it('checks each axis only where that half is known', () => {
    const half: Wearer = { ...UNKNOWN_WEARER, level: 10 };
    // The class list cannot be judged, so the level is what answers.
    expect(equipBlock(item({ classes: [3], minLevel: 40 }), half)).toEqual({
      kind: 'level',
      needs: 40,
      has: 10
    });
  });

  /* Who you are before what you have reached: a class restriction never
     changes and a level does, so the first is the one worth reading. */
  it('reports the reason that will still be true tomorrow', () => {
    const blocked = equipBlock(item({ classes: [3], minLevel: 99 }), mystic);
    expect(blocked?.kind).toBe('class');
  });

  it('knows what the realm gives no slot to at all', () => {
    // A glass jug: `Worn` 0, so the realm names no slot and it is not kit.
    expect(isWearable({})).toBe(false);
    expect(isWearable({ slot: 'Neck' })).toBe(true);
    // An item the realm does not carry is not the same as one it says is not
    // wearable, and the card keeps the button rather than guessing.
    expect(isWearable(undefined)).toBe(false);
  });
});
