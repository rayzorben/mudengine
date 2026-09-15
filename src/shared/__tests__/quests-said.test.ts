import { describe, expect, it } from 'vitest';

import { stepKilled, stepSaid, type Quest } from '../quests';

/**
 * The book moving as the character plays.
 *
 * Nothing on the wire announces a quest counter moving — that is what `abil` is
 * for — so the only fact available at the moment it happens is the player's own
 * line. These are the rules that make acting on it safe without a capture of
 * what a refused ask looks like.
 */
const quest = (over: Partial<Quest> = {}): Quest => ({
  id: 126,
  name: 'GoodQuest',
  steps: [
    {
      block: 1,
      who: 'Markus',
      say: ['letter', 'quest'],
      from: 0,
      to: 1,
      needs: [],
      takes: [],
      gives: []
    }
  ],
  ...over
});

describe('the step a typed line reaches', () => {
  it('takes the asker and the word together', () => {
    expect(stepSaid([quest()], 'ask markus letter')?.step.to).toBe(1);
    expect(stepSaid([quest()], 'ask Markus about the QUEST')?.step.to).toBe(1);
  });

  it('refuses the word on its own', () => {
    // `quest`, `box` and `return` are real `say` entries and all things
    // somebody says in conversation. The keyword alone is far too loose.
    expect(stepSaid([quest()], 'gossip anyone doing this quest')).toBeNull();
    expect(stepSaid([quest()], 'letter')).toBeNull();
  });

  it('refuses the asker on its own, which says nothing about which step', () => {
    expect(stepSaid([quest()], 'look markus')).toBeNull();
  });

  it('never matches a step the realm could trace to neither an asker nor a room', () => {
    const untraced = quest({
      steps: [{ block: 2, say: ['letter'], to: 1, needs: [], takes: [], gives: [] }]
    });
    expect(stepSaid([untraced], 'ask somebody letter')).toBeNull();
    expect(stepSaid([untraced], 'ask somebody letter', '7/142')).toBeNull();
  });

  /*
   * The other anchor (todo 12). A step the realm scripts onto a room has no
   * asker to name — the altar answers `touch gem` to whoever stands on it —
   * and the room is every bit as tight a pair: the phrase does nothing
   * anywhere else. Without this the whole kind was unmatchable, which is how
   * somebody did the Dark Druid quest and the book said nothing.
   */
  describe('a step the realm scripts onto a room', () => {
    const altar = quest({
      id: 129,
      name: 'DarkDruidQuest',
      steps: [
        { block: 4703, room: '7/142', say: ['touch gem'], to: 2, needs: [], takes: [], gives: [] }
      ]
    });

    it('is reached by the phrase, in the room', () => {
      expect(stepSaid([altar], 'touch gem', '7/142')?.step.to).toBe(2);
    });

    it('is not reached from anywhere else', () => {
      expect(stepSaid([altar], 'touch gem', '7/20')).toBeNull();
      expect(stepSaid([altar], 'touch gem')).toBeNull();
    });

    /* The phrase, not a word of it: `gem` alone is a word somebody says. */
    it('takes the whole phrase and nothing looser', () => {
      expect(stepSaid([altar], 'gem', '7/142')).toBeNull();
      expect(stepSaid([altar], 'gos anyone know about the gem', '7/142')).toBeNull();
    });
  });

  it('reads a multi-word asker by any word long enough to be a name', () => {
    const annora = quest({
      steps: [
        {
          block: 3,
          who: 'Annora the Healer',
          say: ['return'],
          to: 2,
          needs: [],
          takes: [],
          gives: []
        }
      ]
    });
    expect(stepSaid([annora], 'ask annora return')?.step.to).toBe(2);
    // `the` is too short to be a name, so it cannot anchor a keyword on its own.
    expect(stepSaid([annora], 'say the return')).toBeNull();
  });

  it('says nothing about a line with only one word in it', () => {
    expect(stepSaid([quest()], 'markus')).toBeNull();
  });

  it('finds the step across several quests', () => {
    const other = quest({
      id: 200,
      name: 'EvilQuest',
      steps: [{ block: 9, who: 'Grimm', say: ['skull'], to: 3, needs: [], takes: [], gives: [] }]
    });
    expect(stepSaid([quest(), other], 'give grimm skull')?.quest.id).toBe(200);
  });
});

/**
 * One asker and one phrase routinely reach several steps, and taking the first
 * is how a player standing in front of the old man in the padded cell had the
 * *Good* quest credited at rank 25 while the Phoenix quest said nothing
 * (reported 2026-09-15). What tells them apart is what the realm states:
 * where the step is, and which counters it gates on.
 */
describe('when one line reaches several steps', () => {
  /** The realm's own old man: three chains in 17/2020, and Phoenix in 9/1259. */
  const oldMan = (): Quest[] => [
    {
      id: 126,
      name: 'GoodQuest',
      steps: [
        {
          block: 1,
          who: 'old man',
          room: '17/2020',
          say: ['prophecy'],
          from: 24,
          to: 25,
          needs: [
            { kind: 'ability-absent', id: 127 },
            { kind: 'ability-absent', id: 128 },
            { kind: 'ability', id: 126, atLeast: 24, atMost: 24 }
          ],
          takes: [],
          gives: []
        }
      ]
    },
    {
      id: 128,
      name: 'EvilQuest',
      steps: [
        {
          block: 2,
          who: 'old man',
          room: '17/2020',
          say: ['prophecy'],
          from: 20,
          to: 21,
          needs: [
            { kind: 'ability-absent', id: 126 },
            { kind: 'ability-absent', id: 127 },
            { kind: 'ability', id: 128, atLeast: 20, atMost: 20 }
          ],
          takes: [],
          gives: []
        }
      ]
    },
    {
      id: 133,
      name: 'PhoenixQuest',
      steps: [
        {
          block: 3,
          who: 'old man',
          room: '9/1259',
          say: ['phoenix', 'prophecy'],
          to: 1,
          needs: [{ kind: 'level', min: 15 }],
          takes: [],
          gives: []
        }
      ]
    }
  ];

  it('takes the one whose room the character is standing in', () => {
    const said = stepSaid(oldMan(), 'ask old man prophecy', '9/1259');
    expect(said?.quest.id).toBe(133);
    expect(said?.step.to).toBe(1);
  });

  /*
   * A step whose room the realm names and the character is not in cannot have
   * run, so a line reaching only those reaches nothing. Falling back to them
   * would be the original bug with an extra step in front of it.
   */
  it('says nothing where every step it reaches is somewhere else', () => {
    expect(stepSaid(oldMan(), 'ask old man prophecy', '1/1')).toBeNull();
  });

  /*
   * And nothing while the client cannot place the character: three of these
   * are in one room and there is no honest way to choose. Refusing is the
   * answer a counter that never walks backwards deserves.
   */
  it('says nothing while it cannot place the character', () => {
    expect(stepSaid(oldMan(), 'ask old man prophecy', null)).toBeNull();
  });

  /*
   * Inside 17/2020 the two chains share a room as well as an asker, and what
   * separates them is the counters `abil` states: `failability` on each
   * other's, and an exact rank on their own.
   */
  it('takes the one the stated counters allow', () => {
    const evil = stepSaid(oldMan(), 'ask old man prophecy', '17/2020', {
      sums: { 128: 20 },
      complete: true,
      at: 1
    });
    expect(evil?.quest.id).toBe(128);

    const good = stepSaid(oldMan(), 'ask old man prophecy', '17/2020', {
      sums: { 126: 24 },
      complete: true,
      at: 1
    });
    expect(good?.quest.id).toBe(126);
  });

  it('says nothing for a character on neither chain', () => {
    expect(
      stepSaid(oldMan(), 'ask old man prophecy', '17/2020', { sums: {}, complete: true, at: 1 })
    ).toBeNull();
  });

  /*
   * An incomplete listing settles nothing — an id it omits is unknown rather
   * than zero — so it narrows nothing and the ambiguity stands.
   */
  it('will not narrow on a listing that did not run to its end', () => {
    expect(
      stepSaid(oldMan(), 'ask old man prophecy', '17/2020', {
        sums: { 128: 20 },
        complete: false,
        at: 1
      })
    ).toBeNull();
  });

  /*
   * And two rows that name one quest and one rank are one answer, however many
   * lines the realm wrote them on — `greasy thief` and `bishop` are each
   * written twice in the shipped realm.
   */
  it('takes a repeated step that agrees with itself', () => {
    const twice: Quest[] = [
      {
        id: 130,
        name: 'BloodChampQuest',
        steps: [
          {
            block: 1,
            who: 'greasy thief',
            room: '2/2561',
            say: ['return'],
            to: 2,
            needs: [],
            takes: [],
            gives: []
          },
          {
            block: 2,
            who: 'greasy thief',
            room: '2/2561',
            say: ['return'],
            to: 2,
            needs: [],
            takes: [],
            gives: []
          }
        ]
      }
    ];
    expect(stepSaid(twice, 'ask greasy thief return', '2/2561')?.step.to).toBe(2);
  });
});

describe('a step a monster’s death hands over', () => {
  /*
   * There is no line to type, so there is nothing for this to match — and the
   * book must not be moved by a player standing over the corpse saying the
   * monster's name to somebody. Structural rather than a guard: the step
   * carries no words at all (`indexQuests.sayOf`), and a step with no words
   * cannot be said.
   */
  const killed = (): Quest => ({
    id: 133,
    name: 'PhoenixQuest',
    steps: [
      {
        block: 1417,
        kill: 'dread mystic',
        room: '9/930',
        say: [],
        from: 1,
        to: 2,
        needs: [],
        takes: [],
        gives: [{ kind: 'item', id: 989, name: 'yellowed note' }]
      }
    ]
  });

  it('is never reached by anything the player types', () => {
    for (const line of [
      'kill dread mystic',
      'ask dread mystic prophecy',
      'dread mystic',
      'a dread mystic dies'
    ]) {
      expect(stepSaid([killed()], line, '9/930')).toBeNull();
    }
  });

  /*
   * Which is why the death itself is the reading (reported 2026-09-15: the
   * dread mystic died in the Meditation Chamber and the book stayed at one of
   * nine). The name is the realm's row, so `rowNameOf` has already folded the
   * modifier the room hangs on it before this is asked.
   */
  it('is reached by the monster dying', () => {
    const found = stepKilled([killed()], 'dread mystic', '9/930');
    expect(found?.quest.id).toBe(133);
    expect(found?.step.to).toBe(2);
  });

  it('says nothing about a monster no step names', () => {
    expect(stepKilled([killed()], 'nasty dark mystic', '9/930')).toBeNull();
    expect(stepKilled([killed()], '', '9/930')).toBeNull();
  });

  /*
   * The room narrows and never refuses, which is the one place this differs
   * from a typed line. A monster walks: it chases a player down a corridor and
   * dies there, and the server casts the death spell wherever the corpse is —
   * so being somewhere else is not evidence the step did not run, while an
   * asker who is not there is.
   */
  it('still reads a kill made outside the room the realm summons it in', () => {
    expect(stepKilled([killed()], 'dread mystic', '9/931')?.step.to).toBe(2);
    expect(stepKilled([killed()], 'dread mystic', null)?.step.to).toBe(2);
  });

  /*
   * The twelve kill steps of Paradigm's 43 that share a monster are the Good,
   * Neutral and Evil chains sharing a boss — told apart by the counters, as
   * they are where they share an asker. The room cannot help: they name one.
   */
  describe('when three chains share a boss', () => {
    const chains = (): Quest[] =>
      [126, 127, 128].map((id, index) => ({
        id,
        name: ['GoodQuest', 'NeutralQuest', 'EvilQuest'][index]!,
        steps: [
          {
            block: 100 + id,
            kill: 'dark phoenix',
            room: '16/2160',
            say: [],
            to: 18,
            needs: [{ kind: 'ability' as const, id, atLeast: 17, atMost: 17 }],
            takes: [],
            gives: []
          }
        ]
      }));

    it('takes the one the stated counters allow', () => {
      const found = stepKilled(chains(), 'dark phoenix', '16/2160', {
        sums: { 127: 17 },
        complete: true,
        at: 1
      });
      expect(found?.quest.id).toBe(127);
    });

    it('says nothing while nothing tells them apart', () => {
      expect(stepKilled(chains(), 'dark phoenix', '16/2160')).toBeNull();
      expect(
        stepKilled(chains(), 'dark phoenix', '16/2160', { sums: {}, complete: false, at: 1 })
      ).toBeNull();
    });
  });

  /*
   * And where two steps name one boss in different rooms, the room is what
   * chooses — the narrowing it is there for.
   */
  it('takes the candidate standing where the death happened', () => {
    const elsewhere: Quest = {
      id: 152,
      name: 'Rune',
      steps: [
        {
          block: 9,
          kill: 'dread mystic',
          room: '3/17',
          say: [],
          to: 4,
          needs: [],
          takes: [],
          gives: []
        }
      ]
    };
    expect(stepKilled([killed(), elsewhere], 'dread mystic', '3/17')?.quest.id).toBe(152);
    expect(stepKilled([killed(), elsewhere], 'dread mystic', '9/930')?.quest.id).toBe(133);
  });
});
