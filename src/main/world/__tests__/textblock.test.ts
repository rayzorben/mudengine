import { describe, expect, it } from 'vitest';

import {
  blockUses,
  keywordTable,
  phraseOf,
  readLines,
  readStep,
  roleOf,
  rollOf,
  SERVER_LINE,
  stepsRun,
  type TbVerb
} from '../navigation/textblock';

/**
 * One written example per verb the server reads, with what it must read as.
 * The table is keyed by `TbVerb`, so a verb added to `SERVER_LINE` without an
 * example here does not type-check.
 */
const EXAMPLES: Record<TbVerb, [string, object]> = {
  check: ['check class', { verb: 'nothing' }],
  levelcheck: ['levelcheck', { verb: 'nothing' }],
  checkitem: ['checkitem 622 3208', { verb: 'checkitem', item: 622, message: 3208 }],
  giveitem: ['giveitem 642', { verb: 'giveitem', item: 642 }],
  droproomitem: ['droproomitem 12', { verb: 'droproomitem', item: 12 }],
  message: ['message 1205', { verb: 'message', message: 1205 }],
  mesage: ['mesage 1205', { verb: 'message', message: 1205 }],
  addexp: ['addexp 150000', { verb: 'addexp', amount: 150000 }],
  addevil: ['addevil -5', { verb: 'addevil', amount: -5 }],
  addlife: ['addlife 3000', { verb: 'addlife', message: 3000 }],
  checklives: ['checklives 3001', { verb: 'checklives', message: 3001 }],
  adddelay: ['adddelay 5', { verb: 'delay', seconds: 5 }],
  delay: ['delay 3', { verb: 'delay', seconds: 3 }],
  cast: ['cast 512', { verb: 'cast', spell: 512 }],
  checkability: ['checkability 133', { verb: 'checkability', ability: 133, value: -1 }],
  checkabilityexact: [
    'checkabilityexact 126 5',
    { verb: 'checkabilityexact', ability: 126, value: 5 }
  ],
  testability: ['testability 126 5', { verb: 'testability', ability: 126, value: 5 }],
  failability: ['failability 22', { verb: 'failability', ability: 22 }],
  checkspell: ['checkspell 711 2654', { verb: 'checkspell', spell: 711, otherwise: 2654 }],
  failspell: ['failspell 512', { verb: 'failspell', spell: 512 }],
  class: ['class 9 2682', { verb: 'class', classId: 9 }],
  clearitem: ['clearitem 0', { verb: 'clearitem', item: 0 }],
  evilaligned: ['evilaligned 200 801', { verb: 'evilaligned', value: 200 }],
  goodaligned: ['goodaligned -51 801', { verb: 'goodaligned', value: -51 }],
  failitem: ['failitem 690', { verb: 'failitem', item: 690 }],
  giveability: ['giveability 126 6', { verb: 'giveability', ability: 126, value: 6 }],
  setability: ['setability 126 0', { verb: 'setability', ability: 126, value: 0 }],
  addability: ['addability 7 1', { verb: 'addability', ability: 7, value: 1 }],
  givecoins: ['givecoins 400 G', { verb: 'givecoins', amount: 400, coin: 'gold' }],
  learnspell: ['learnspell 77', { verb: 'learnspell', spell: 77 }],
  maxlevel: ['maxlevel 19', { verb: 'maxlevel', level: 19 }],
  minlevel: ['minlevel 20 1220', { verb: 'minlevel', level: 20, message: 1220 }],
  needmonster: ['needmonster 86 55', { verb: 'needmonster', monster: 86, message: 55 }],
  nomonsters: ['nomonsters 1093', { verb: 'nomonsters', message: 1093 }],
  monsters: ['monsters', { verb: 'monsters' }],
  price: ['price 10000 33', { verb: 'price', copper: 10000, message: 33 }],
  race: ['race 5', { verb: 'race', raceId: 5 }],
  random: ['random 871', { verb: 'random', block: 871 }],
  remoteaction: [
    'remoteaction 909 1360 0 3',
    { verb: 'remoteaction', room: 909, ordinal: 0, exit: 'w' }
  ],
  removeability: ['removeability 9', { verb: 'removeability', ability: 9 }],
  roomitem: ['roomitem 993 1834', { verb: 'roomitem', item: 993 }],
  failroomitem: ['failroomitem 3391', { verb: 'failroomitem', item: 3391 }],
  summon: ['summon 404', { verb: 'summon', monster: 404 }],
  takeitem: ['takeitem 1975', { verb: 'takeitem', item: 1975 }],
  teleport: ['teleport 681 3', { verb: 'teleport', room: 681, map: 3 }],
  text: ['text 354', { verb: 'show', block: 354 }],
  testskill: [
    'testskill strength 20 708',
    { verb: 'testskill', stat: 'strength', value: 20, otherwise: 708 }
  ]
};

describe('one step, as the server reads it', () => {
  it('reads every verb the server runs', () => {
    for (const [verb, [written, read]] of Object.entries(EXAMPLES)) {
      expect(readStep(written), verb).toMatchObject({ ...read, text: written });
    }
    expect(Object.keys(EXAMPLES).sort()).toEqual(Object.keys(SERVER_LINE).sort());
  });

  /* `said` is the condition as written: the message id is not part of it. */
  it('keeps the words that state the condition', () => {
    expect(readStep('minlevel 20 1220').said).toBe('minlevel 20');
    expect(readStep('testskill strength 20 708').said).toBe('testskill strength 20');
    expect(readStep('nomonsters 1093').said).toBe('nomonsters');
    expect(readStep('givecoins 400 G').said).toBe('givecoins 400 G');
  });

  it('reads a bare number as a block to show, and an empty step as nothing', () => {
    expect(readStep('666')).toMatchObject({ verb: 'show', block: 666 });
    expect(readStep('')).toMatchObject({ verb: 'nothing' });
    // Led by a space, the server's verb is empty: a leaderboard line run as a step.
    expect(readStep('  2. Mouth Devereaux  75')).toMatchObject({ verb: 'nothing' });
  });

  /*
   * The server matches a verb exactly and prints *Not Yet Implemented* for
   * anything else (`TextBlockPart.cs:1265`), failing the line. Real junk from
   * the three databases.
   */
  it('reads what the server cannot run as unknown, which fails its line', () => {
    for (const junk of ['add delay 5', 'nononsters 503', 'goodability -51 3154', 'Message 5']) {
      expect(readStep(junk)).toMatchObject({ verb: 'unknown', why: 'verb' });
      expect(roleOf(readStep(junk))).toBe('unknown');
    }
    expect(readStep('failroomitem')).toMatchObject({ verb: 'unknown', why: 'arguments' });
    expect(readStep('summon guard')).toMatchObject({ verb: 'unknown', why: 'arguments' });
    expect(readStep('testskill 34 4021')).toMatchObject({ verb: 'unknown', why: 'arguments' });
  });

  it('pays gold for a coin letter the server does not spell', () => {
    expect(readStep('givecoins 50 Z')).toMatchObject({ coin: 'gold' });
    expect(readStep('givecoins 50 r')).toMatchObject({ coin: 'runic' });
  });

  it('gives each kind of step its role', () => {
    expect(roleOf(readStep('minlevel 20'))).toBe('gate');
    expect(roleOf(readStep('nomonsters'))).toBe('gate');
    expect(roleOf(readStep('takeitem 5'))).toBe('pays');
    expect(roleOf(readStep('price 100'))).toBe('pays');
    expect(roleOf(readStep('teleport 1 2'))).toBe('effect');
    expect(roleOf(readStep('random 9'))).toBe('flow');
    expect(roleOf(readStep('message 9'))).toBe('say');
  });
});

describe('a block, as the server runs it', () => {
  it('reads a phrase, a roll threshold and a keyword table', () => {
    const [portal, bare] = readLines('go portal:minlevel 40 2594:teleport 1041 8\ngiveitem 983');
    expect(phraseOf(portal!)).toBe('go portal');
    expect(stepsRun(portal!, 'phrased').map((step) => step.verb)).toEqual(['minlevel', 'teleport']);
    expect(phraseOf(bare!)).toBeNull();
    expect(stepsRun(bare!, 'steps').map((step) => step.verb)).toEqual(['giveitem']);

    const [roll] = readLines('77:addexp 0');
    expect(rollOf(roll!)).toBe(77);
    expect(stepsRun(roll!, 'roll').map((step) => step.verb)).toEqual(['addexp']);

    const table = keywordTable({ lines: readLines('return:353\nMarkus:353\nbox:354\ngood1:9') });
    expect([...table]).toEqual([
      [353, ['return', 'Markus']],
      [354, ['box']]
    ]);
  });

  /*
   * `text N` and a bare number print the block; only what it links to runs
   * (`TextBlock.Display`). `random` runs a roll table, and `checkspell` and
   * `testskill` run their fallback as steps.
   */
  it('follows how each block is reached', () => {
    const blocks = new Map(
      Object.entries({
        1: { action: 'ask fork:1427\nroll:random 5\ndesert:checkspell 711 6', linkTo: null },
        1427: { action: 'The gnome smiles.', linkTo: 1428 },
        1428: { action: 'giveitem 983', linkTo: null },
        5: { action: '50:message 1\n100:testskill strength 20 7', linkTo: null },
        6: { action: 'cast 712', linkTo: null },
        7: { action: 'cast 9', linkTo: null },
        8: { action: 'never reached', linkTo: null }
      }).map(([id, block]) => [
        Number(id),
        { lines: readLines(block.action), linkTo: block.linkTo }
      ])
    );
    const uses = blockUses(blocks, { phrased: [1], steps: [] });
    expect(uses.get(1)).toEqual(new Set(['phrased']));
    expect(uses.get(1427)).toEqual(new Set(['shown']));
    expect(uses.get(1428)).toEqual(new Set(['steps']));
    expect(uses.get(5)).toEqual(new Set(['roll']));
    expect(uses.get(6)).toEqual(new Set(['steps']));
    expect(uses.get(7)).toEqual(new Set(['steps']));
    expect(uses.has(8)).toBe(false);
  });
});
