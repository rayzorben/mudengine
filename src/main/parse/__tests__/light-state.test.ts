import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Classifier } from '../Classifier';
import { CharacterTracker } from '../CharacterTracker';
import { WorldGraph } from '../../world/WorldGraph';

const REALM = path.resolve('resources/world/rooms.jsonl.gz');
const realm = fs.existsSync(REALM) ? WorldGraph.load(REALM) : null;

/** The stat sheet as the live realm prints it (festus, 2026-09-03). */
const SHEET = [
  'Name: Festus Marcus                    Lives/CP:      9/2',
  'Race: Kang        Exp: 88213           Perception:     60',
  'Class: Paladin    Level: 6             Stealth:         0',
  'Hits:    86/86    Armour Class:  41/5  Thievery:        0',
  'Mana:     4/18    Spellcasting: 48     Traps:           0',
  '                                       Picklocks:       0',
  'Strength:  80     Agility: 56          Tracking:        0',
  'Intellect: 40     Health:  60          Martial Arts:   12',
  'Willpower: 50     Charm:   50          MagicRes:       47',
  '[HP=86/MA=4]:'
];

/** The listing closes on the lines the server prints after it. */
const PACK_TAIL = [
  'You have no keys.',
  'Wealth: 0 copper farthings',
  'Encumbrance: 260/3360 - None [7%]',
  '[HP=86/MA=3]:'
];

function feeder(world?: WorldGraph): {
  tracker: CharacterTracker;
  feed: (text: string) => void;
  pack: (line: string) => void;
} {
  const classifier = new Classifier();
  const tracker = new CharacterTracker(world);
  let seq = 0;
  const feed = (text: string): void => {
    seq += 1;
    const { block, batch } = classifier.classify({
      seq,
      at: 1_700_000_000_000 + seq,
      text,
      plain: text,
      terminator: 'newline'
    });
    tracker.apply(block);
    if (batch) tracker.apply(batch, batch.rows);
  };
  const pack = (line: string): void => {
    feed(line);
    for (const tail of PACK_TAIL) feed(tail);
  };
  return { tracker, feed, pack };
}

describe('the rest of the stat sheet', () => {
  it('keeps every figure the sheet prints, and the whole name', () => {
    const { tracker, feed } = feeder();
    for (const line of SHEET) feed(line);
    const { progress } = tracker.current;
    expect(tracker.current.name).toBe('Festus');
    expect(tracker.current.fullName).toBe('Festus Marcus');
    expect(progress).toMatchObject({
      lives: 9,
      cp: 2,
      perception: 60,
      stealthSkill: 0,
      thievery: 0,
      armourClass: 41,
      damageResist: 5,
      spellcasting: 48,
      traps: 0,
      picklocks: 0,
      strength: 80,
      agility: 56,
      tracking: 0,
      intellect: 40,
      health: 60,
      martialArts: 12,
      willpower: 50,
      charm: 50,
      magicRes: 47
    });
  });

  it('draws nothing as zero before the sheet has printed', () => {
    const { tracker, feed } = feeder();
    feed('[HP=86/MA=4]:');
    expect(tracker.current.progress.charm).toBeNull();
    expect(tracker.current.fullName).toBeNull();
  });
});

describe('a light burning down', () => {
  /* `Your torch flickers and goes out.` — live, 2026-09-03. The torch stays
     readied and in the pack; only its charge is gone. */
  it('sets the readied torch to no charge and leaves the spare alone', () => {
    const { tracker, feed, pack } = feeder();
    feed('[HP=86/MA=3]:');
    pack('You are carrying torch (Readied/11), 2 torch, token of Silvermere');
    feed('Your torch flickers and goes out.');
    const torches = tracker.current.inventory.items.filter((item) => item.name === 'torch');
    expect(torches.map((item) => [item.equipped, item.charges])).toEqual([
      [true, 0],
      [false, null],
      [false, null]
    ]);
  });

  it('reads the lamp’s spelling from the corpus too', () => {
    const { tracker, feed, pack } = feeder();
    feed('[HP=86/MA=3]:');
    pack('You are carrying lantern (Readied/240)');
    feed('Your lamp runs out of oil, and goes out.');
    // `lamp` is not `lantern` by the server's own matching, so nothing moves:
    // the sentence names the kind rather than the item, and the next listing
    // corrects it. Refusing beats guessing which light went out.
    expect(tracker.current.inventory.items[0]?.charges).toBe(240);
  });
});

describe.skipIf(realm === null)('what the character sees by', () => {
  it('is worked out from the race and the pack once both are known', () => {
    const { tracker, feed, pack } = feeder(realm!);
    feed('[HP=86/MA=4]:');
    expect(tracker.current.sight).toBeNull();
    pack('You are carrying carved ivory mask (Face), torch (Readied/62), 2 torch');
    // The pack alone: the mask's 25, a lit torch reaching 100, race unknown.
    expect(tracker.current.sight).toEqual({
      vision: 25,
      reach: 100,
      lit: 'torch',
      total: 125,
      raceKnown: false
    });
    for (const line of SHEET) feed(line);
    // A Kang sees by nothing of its own; the mask and the torch are the lot.
    expect(tracker.current.sight).toMatchObject({ vision: 25, total: 125, raceKnown: true });
  });

  it('counts a race’s night vision, and a burnt-out torch as no reach', () => {
    const { tracker, feed, pack } = feeder(realm!);
    feed('[HP=86/MA=4]:');
    for (const line of SHEET) feed(line.replace('Race: Kang       ', 'Race: Gaunt One  '));
    pack('You are carrying torch (Readied/62)');
    expect(tracker.current.sight).toMatchObject({ vision: 200, reach: 100, total: 300 });
    feed('Your torch flickers and goes out.');
    expect(tracker.current.sight).toMatchObject({ vision: 200, reach: 0, lit: null, total: 200 });
  });
});
