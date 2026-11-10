import { describe, expect, it } from 'vitest';

import { Classifier } from '../Classifier';
import { actsOf, applyAct, readLine } from '../lineActs';
import { CharacterTracker } from '../CharacterTracker';
import { surveyHere } from '../../../shared/survey';

/*
 * `rm` on MajorMUD Plus, verbatim from Yang's session logs on omniversebbs.com
 * (OCI `logs/2026-11-04_22-08-51_yang.log`, `2026-11-05_04-12-45_yang.log`,
 * `2026-11-10_02-01-15_yang.log`).
 */
const SHOP_ROOM = [
  'Location:      15,968',
  'Illumination: 75 (Regular Light)   Ambient: 0  You: +75  Others: +0',
  'Spawn:         0/5',
  'Spawn Grp:    0',
  '  (none present)',
  'Type:          Shop [S]',
  'Flags:         Patrollable, GangHouse',
  'Shop:          134',
  'Trap:          None'
];

const ARMOUR_SHOP = [
  'Location:      1,2142',
  'Illumination: 50 (Regular Light)   Ambient: 0  You: +50  Others: +0',
  'Spawn:         0/1',
  'Spawn Grp:    2',
  '  Aiken, Thuluk, Helfgrim, Colin, Skali, Gurbultis, Lady Sentara',
  '  Guildmaster, old man, Giovanni, Meia, Sarkhee, bishop, priest, healer',
  '  boatman, crippled adventurer, Nathaniel, Betram, Dathalar, Rayth, Corwyn',
  '  ferryman, warrior spirit',
  '  ...(showing first 24)',
  'Type:          Shop [S]',
  'Flags:         Safe, PermNpcAlive',
  'Shop:          46',
  'Trap:          None'
];

const DARK_TUNNEL = [
  'Location:      1,783',
  'Illumination: -125 (barely visible)   Ambient: -175  You: +50  Others: +0',
  '  Only your light holds back the dark.',
  'Spawn:         2/8',
  'Spawns:        giant rat (#1)',
  'Type:          Normal [*]',
  'Flags:         None',
  'Shop:          None',
  'Trap:          None'
];

const BANK = [
  'Location:      1,297',
  'Illumination: 50 (Regular Light)   Ambient: 0  You: +50  Others: +0',
  'Spawn:         1/1',
  'Spawn Grp:    5  (lvl 1-4)',
  '  guardsman, Sheriff Lionheart, elite guardsman',
  'Type:          Shop [S]',
  'Flags:         Safe, Patrollable, PermNpcAlive',
  'Shop:          8',
  'Trap:          None'
];

const PROMPT = '[HP=70/KAI=6]:';

function play(lines: readonly string[]): CharacterTracker {
  const classifier = new Classifier();
  const tracker = new CharacterTracker();
  let seq = 0;
  for (const text of lines) {
    seq += 1;
    const line = { seq, at: 1_000 + seq, text, plain: text, terminator: 'newline' as const };
    for (const act of actsOf(readLine(classifier, line))) applyAct(tracker, act);
  }
  return tracker;
}

describe('rm on MajorMUD Plus', () => {
  it('reads every row of a shop with an empty spawn group', () => {
    const tracker = play([...SHOP_ROOM, PROMPT]);
    expect(tracker.current.room.map).toBe(15);
    expect(tracker.current.room.number).toBe(968);
    expect(surveyHere(tracker.current)).toEqual({
      map: 15,
      room: 968,
      at: 1_001,
      light: { seen: 75, phrase: 'Regular Light', ambient: 0, own: 75, others: 0 },
      spawn: { present: 0, max: 5 },
      group: { id: 0, levels: null, mobs: [], shown: null },
      lair: null,
      type: { name: 'Shop', glyph: 'S' },
      flags: ['Patrollable', 'GangHouse'],
      shop: 134,
      trap: 'None'
    });
  });

  it('closes on the trap row, before the prompt', () => {
    expect(surveyHere(play(SHOP_ROOM).current)?.trap).toBe('None');
  });

  it("joins a group's names across its lines and keeps the cut", () => {
    const group = surveyHere(play(ARMOUR_SHOP).current)?.group;
    expect(group?.mobs).toHaveLength(24);
    expect(group?.mobs[6]).toBe('Lady Sentara');
    expect(group?.mobs.at(-1)).toBe('warrior spirit');
    expect(group?.shown).toBe(24);
  });

  it('reads the level range of a group', () => {
    const survey = surveyHere(play(BANK).current);
    expect(survey?.group).toEqual({
      id: 5,
      levels: { low: 1, high: 4 },
      mobs: ['guardsman', 'Sheriff Lionheart', 'elite guardsman'],
      shown: null
    });
    expect(survey?.flags).toEqual(['Safe', 'Patrollable', 'PermNpcAlive']);
  });

  it("reads a lair's monsters and a dark room, and no shop as none", () => {
    const survey = surveyHere(play(DARK_TUNNEL).current);
    expect(survey?.light).toEqual({
      seen: -125,
      phrase: 'barely visible',
      ambient: -175,
      own: 50,
      others: 0
    });
    expect(survey?.group).toBeNull();
    expect(survey?.lair).toEqual([{ name: 'giant rat', id: 1 }]);
    expect(survey?.flags).toEqual([]);
    expect(survey?.shop).toBe('none');
    expect(survey?.spawn).toEqual({ present: 2, max: 8 });
  });

  it('describes only the room it named', () => {
    const tracker = play([...DARK_TUNNEL, PROMPT, ...SHOP_ROOM.slice(0, 1), PROMPT]);
    // A later `Location:` with no rows under it (GreaterMUD's shape) moves the room on and leaves the survey behind.
    expect(tracker.current.survey?.room).toBe(783);
    expect(surveyHere(tracker.current)).toBeNull();
  });

  it('ends at the first line that is not a row, so the next listing opens', () => {
    const tracker = play([
      'Location:            1,2150',
      'You are carrying padded helm (Head), quarterstaff (Weapon Hand)',
      'You have no keys.',
      'Wealth: 0 copper farthings',
      'Encumbrance: 260/3360 - None [7%]',
      PROMPT
    ]);
    expect(tracker.current.inventory.items.map((item) => item.name)).toEqual([
      'padded helm',
      'quarterstaff'
    ]);
  });

  it("makes nothing of GreaterMUD's rows", () => {
    const tracker = play([
      'Location:            1,2150',
      'Regen Time:            4m 30s',
      'Room Illu:            0 (200)',
      '[HP=34]:'
    ]);
    expect(tracker.current.room.number).toBe(2150);
    expect(tracker.current.survey).toBeNull();
  });
});
