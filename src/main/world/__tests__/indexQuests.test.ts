import { describe, expect, it } from 'vitest';

import { blocksInReach, indexQuests, itemsInReach } from '../indexQuests';
import type { RealmSource, RealmTable } from '../RealmSource';

/** A realm database made of literals, as `buildRealm.test.ts` builds one. */
function fake(tables: Record<string, Record<string, unknown>[]>): RealmSource {
  return {
    path: '/tmp/test.mdb',
    kind: 'mdb',
    tableNames: () => Object.keys(tables),
    table: (name): RealmTable | null => {
      const found = Object.entries(tables).find(
        ([key]) => key.toLowerCase() === name.toLowerCase()
      );
      if (!found) return null;
      return { name: found[0], columns: Object.keys(found[1][0] ?? {}), rows: found[1] };
    },
    close: () => {}
  };
}

const naming = { classes: [], races: [], spells: [] };

/**
 * The realm's own altar, abridged: a room whose script grants the counter a
 * later block demands, which is what makes it a quest at all.
 *
 * Two blocks, because a counter is derived rather than listed — granted by one
 * script and demanded by another — and one block alone would be a script this
 * index has no reason to believe is a chain.
 */
const ALTAR = {
  Rooms: [
    {
      'Map Number': 7,
      'Room Number': 142,
      Name: 'Large Clearing, Stone Altar',
      CMD: 4703
    }
  ],
  TBInfo: [
    {
      Number: 4703,
      Action: [
        'touch gem : minlevel 12 : giveability 129 2 : addexp 250000',
        'touch black gem : minlevel 12 : giveability 129 2 : addexp 250000'
      ].join('\n'),
      LinkTo: 0
    },
    // The other end of the chain: something that demands the counter, which is
    // the test that makes 129 a quest counter rather than a one-off grant.
    { Number: 4800, Action: 'ask druid : checkability 129 2 : giveability 129 3', LinkTo: 0 }
  ]
};

describe('a quest step the realm scripts onto a room', () => {
  /*
   * Reported live (todo 12): somebody did the Dark Druid quest by typing
   * `touch gem` on the altar and the book neither said where to do it nor
   * noticed it being done. Both halves were one wrong column name — the Rooms
   * table calls them `Map Number` and `Room Number`, and reading `Map`/`Number`
   * gave every room-scripted step an owner of nothing.
   */
  it('carries the room it is scripted onto', () => {
    const quests = indexQuests(fake(ALTAR), naming);
    const step = quests.find((quest) => quest.id === 129)?.steps[0];
    expect(step?.room).toBe('7/142');
    // A room is not somebody: the step has a place and no asker at all, rather
    // than an empty name that reads as one.
    expect(step?.who).toBeUndefined();
  });

  /* And the phrases its own script answers to, which is what a player types. */
  it('carries the phrases the room answers to', () => {
    const quests = indexQuests(fake(ALTAR), naming);
    const step = quests.find((quest) => quest.id === 129)?.steps[0];
    expect(step?.say).toEqual(['touch gem', 'touch black gem']);
  });

  /*
   * **Per step, not per block.** One room's script routinely states several
   * quests: block 4355 of the shipped realm is `pledge good`, `pledge neutral`
   * and `pledge evil` in one room, advancing three different counters. Handing
   * every step every phrase told an evil character to pledge good — and
   * `stepSaid` matched whichever quest came first when they typed the right
   * one.
   */
  it('gives each step the phrase of its own line rather than the block’s', () => {
    const pledges = {
      Rooms: [{ 'Map Number': 1, 'Room Number': 163, Name: 'Shrine', CMD: 4355 }],
      TBInfo: [
        {
          Number: 4355,
          Action: [
            'pledge good : giveability 126 6',
            'pledge neutral : giveability 127 7',
            'pledge evil : giveability 128 3',
            // And a line beside them that is not a quest at all, which must
            // reach none of the three.
            'buy healing : addexp 10'
          ].join('\n'),
          LinkTo: 0
        },
        {
          Number: 4400,
          Action: [
            'ask elder : checkability 126 6 : giveability 126 7',
            'ask elder : checkability 127 7 : giveability 127 8',
            'ask elder : checkability 128 3 : giveability 128 4'
          ].join('\n'),
          LinkTo: 0
        }
      ]
    };
    const quests = indexQuests(fake(pledges), naming);
    const say = (id: number): string[] | undefined =>
      quests.find((quest) => quest.id === id)?.steps[0]?.say;
    expect(say(126)).toEqual(['pledge good']);
    expect(say(127)).toEqual(['pledge neutral']);
    expect(say(128)).toEqual(['pledge evil']);
  });

  /* A row the table cannot place owns no room, rather than a made-up one. */
  it('leaves a step whose room the table cannot place without one', () => {
    const quests = indexQuests(fake({ ...ALTAR, Rooms: [{ Name: 'Nowhere', CMD: 4703 }] }), naming);
    const step = quests.find((quest) => quest.id === 129)?.steps[0];
    expect(step?.room).toBeUndefined();
  });
});

describe('a quest step a monster’s death hands over', () => {
  /*
   * The Phoenix chain's second step, as the shipped realm writes it: the dread
   * mystic's `DeathSpell` is a one-second holder whose `EndCast` is the spell
   * that actually carries the payload, and that spell's `TextBlock` is the
   * step. Nothing rooted at a death, so the block had no owner at all — no
   * place, nobody, no words — and the book drew it as a bare rank and a
   * yellowed note with no word about where either came from.
   */
  const MYSTIC = {
    Monsters: [
      {
        Number: 490,
        Name: 'dread mystic',
        GreetTXT: 0,
        DeathSpell: 603,
        'Summoned By': 'Room 9/930'
      }
    ],
    TBInfo: [
      {
        Number: 1417,
        Action: 'checkability 133 1:testability 133 1:giveitem 989:giveability 133 2',
        LinkTo: 0
      },
      // The far end of the chain, so 133 is a counter rather than a one-off.
      { Number: 1431, Action: 'checkability 133 2:giveability 133 3', LinkTo: 0 }
    ]
  };
  const CHAIN = [
    { id: 603, n: 'dread mystic temp', ab: [[151, 604]] as Array<[number, number]> },
    { id: 604, n: 'dread mystic text', ab: [[148, 1417]] as Array<[number, number]> }
  ];

  it('names the monster, and where it stands', () => {
    const quests = indexQuests(fake(MYSTIC), { ...naming, spells: CHAIN });
    const step = quests.find((quest) => quest.id === 133)?.steps[0];
    expect(step?.kill).toBe('dread mystic');
    expect(step?.room).toBe('9/930');
    expect(step?.to).toBe(2);
  });

  /*
   * And nothing to say, which is the half that made the tagged owner worth
   * having: read as *an asker whose name happens to be empty*, this would have
   * taken the room's branch and been handed the first field of its first line
   * as the phrase to type — `checkability 133 1`, offered to the player as the
   * words to say, and matched by `stepSaid` if they ever typed it.
   */
  it('has no asker and no words, because nothing is said to a corpse', () => {
    const quests = indexQuests(fake(MYSTIC), { ...naming, spells: CHAIN });
    const step = quests.find((quest) => quest.id === 133)?.steps[0];
    expect(step?.who).toBeUndefined();
    expect(step?.say).toEqual([]);
  });

  /*
   * A block the same monster both greets you with and hands over on death is a
   * conversation: the smuggler boss is that monster in the shipped realm, and
   * the roots are queued greeting-first so the more direct act wins.
   */
  it('leaves a block its monster also greets you with a conversation', () => {
    const both = {
      Monsters: [
        {
          Number: 478,
          Name: 'smuggler boss',
          GreetTXT: 1417,
          DeathSpell: 603,
          'Summoned By': 'Room 9/223'
        }
      ],
      TBInfo: MYSTIC.TBInfo
    };
    const quests = indexQuests(fake(both), { ...naming, spells: CHAIN });
    const step = quests.find((quest) => quest.id === 133)?.steps[0];
    expect(step?.who).toBe('smuggler boss');
    expect(step?.kill).toBeUndefined();
  });

  /* A spell that hands on to itself is a chain with an end, not a hang. */
  it('terminates on a spell chain that loops', () => {
    const looped = [
      { id: 603, n: 'a', ab: [[151, 604]] as Array<[number, number]> },
      {
        id: 604,
        n: 'b',
        ab: [
          [151, 603],
          [148, 1417]
        ] as Array<[number, number]>
      }
    ];
    const quests = indexQuests(fake(MYSTIC), { ...naming, spells: looped });
    expect(quests.find((quest) => quest.id === 133)?.steps[0]?.kill).toBe('dread mystic');
  });

  /* A death spell that runs no block owns nothing, rather than every block. */
  it('claims nothing for a death spell that names no text block', () => {
    const quests = indexQuests(fake(MYSTIC), {
      ...naming,
      spells: [{ id: 603, n: 'plain harm', ab: [[1, 40]] as Array<[number, number]> }]
    });
    const step = quests.find((quest) => quest.id === 133)?.steps[0];
    expect(step?.kill).toBeUndefined();
    expect(step?.room).toBeUndefined();
  });
});

/*
 * The four Phoenix components, as the shipped realm hands them over. Reported
 * live: *sundry items are missing, it says the realm data does not name it* —
 * `acid gland`, `unfertilized eggs`, `double-terminated quartz` and `cave
 * roots` are `giveitem` in blocks reached by a monster's death or a cave's own
 * word, so `neededItems` (exits, levers, shops, drop lists and *room-owned*
 * scripts) held none of the first three and the Reference card said *Named in
 * the world data, with no further detail*.
 */
describe('where a script hands an item over', () => {
  const COMPONENTS = {
    Monsters: [
      {
        Number: 471,
        Name: 'white jelly',
        GreetTXT: 0,
        DeathSpell: 608,
        'Summoned By': 'Room 9/146'
      },
      {
        Number: 500,
        Name: 'Morukai',
        GreetTXT: 1437,
        DeathSpell: 0,
        'Summoned By': 'Room 9/1425'
      }
    ],
    Rooms: [{ 'Map Number': 9, 'Room Number': 500, Name: 'Earthy Cave', CMD: 1446 }],
    TBInfo: [
      // A death's block: no phrase, because nothing is typed at a corpse.
      {
        Number: 1443,
        Action: 'failitem 966:testability 133 5:checkability 133 5:giveitem 966',
        LinkTo: 0
      },
      // A room's: one line per spelling, all handing over the same thing.
      {
        Number: 1446,
        Action: [
          'get roots:failitem 995:checkability 133 5:giveitem 995',
          'pick roots:failitem 995:checkability 133 5:giveitem 995'
        ].join('\n'),
        LinkTo: 0
      },
      // And an asker's keyword table, two words onto one block.
      { Number: 1437, Action: 'components:1447\nbarrier:1447', LinkTo: 0 },
      { Number: 1447, Action: 'checkability 133 5:giveitem 996:giveability 133 6', LinkTo: 0 },
      // An orphan: reachable from nothing, so it places nothing.
      { Number: 9999, Action: 'giveitem 4242', LinkTo: 0 }
    ]
  };
  const JELLY = [
    { id: 608, n: 'white jelly temp', ab: [[151, 609]] as Array<[number, number]> },
    { id: 609, n: 'white jelly text', ab: [[148, 1443]] as Array<[number, number]> }
  ];
  const read = (): ReturnType<typeof itemsInReach> =>
    itemsInReach(blocksInReach(fake(COMPONENTS), JELLY));

  it('names every item a reached block refers to', () => {
    // 966 and 995 are `giveitem`, and each is `failitem` on the same line —
    // both verbs are the realm referring to a thing somebody will be holding.
    expect([...read().named].sort((a, b) => a - b)).toEqual([966, 995, 996]);
  });

  it('places a death’s item on the monster, in the room the realm summons it to', () => {
    expect(read().from.get(966)).toEqual([{ k: 'death', w: 'white jelly', at: '9/146' }]);
  });

  it('gathers a room’s spellings into one place rather than one place each', () => {
    expect(read().from.get(995)).toEqual([
      { k: 'room', at: '9/500', say: ['get roots', 'pick roots'] }
    ]);
  });

  it('gives an asker’s item the words the keyword table reached it with', () => {
    expect(read().from.get(996)).toEqual([
      { k: 'npc', w: 'Morukai', at: '9/1425', say: ['components', 'barrier'] }
    ]);
  });

  /*
   * A block nothing can run is not a place to go. The realm keeps blocks its
   * own editor orphaned, and offering one as an errand would be the client
   * inventing a way to get something.
   */
  it('places nothing for a block the realm can never run', () => {
    const answer = read();
    expect(answer.from.has(4242)).toBe(false);
    expect(answer.named.has(4242)).toBe(false);
  });
});

/*
 * The roll and the delay the runner needs (todo 106): the red book's own
 * shape, a step that rolls after the server holds the block ten seconds.
 */
describe('a step that rolls after a delay', () => {
  const BOOKS = {
    Rooms: [{ 'Map Number': 12, 'Room Number': 2248, Name: 'Secret Library', CMD: 2605 }],
    TBInfo: [
      {
        Number: 2605,
        Action: [
          'read red : checkability 134 6 : adddelay 10 : testskill intellect 30 2607 : giveability 134 7',
          'read blue : checkability 134 5 : giveability 134 6'
        ].join('\n'),
        LinkTo: 0
      },
      {
        Number: 2700,
        Action: 'ask seeress head : checkability 134 7 : giveability 134 8',
        LinkTo: 0
      }
    ]
  };

  it('carries the roll as a gate and the delay onto the step, and neither onto a step without them', () => {
    const quest = indexQuests(fake(BOOKS), naming).find((each) => each.id === 134);
    const red = quest?.steps.find((step) => step.to === 7);
    expect(red?.needs).toContainEqual({ kind: 'skill', stat: 'intellect', value: 30 });
    expect(red?.delaySeconds).toBe(10);
    const blue = quest?.steps.find((step) => step.to === 6);
    expect(blue?.needs.some((gate) => gate.kind === 'skill')).toBe(false);
    expect(blue?.delaySeconds).toBeUndefined();
  });
});
