import { describe, expect, it } from 'vitest';

import {
  asksHere,
  earlierHandover,
  packHolds,
  planAct,
  planSpan,
  questBars,
  questExperience,
  questGroup,
  questLevel,
  questSide,
  rollChance,
  stepDone,
  stepRoll,
  stepsDone,
  QUEST_GROUPS,
  type Quest,
  type QuestDoer,
  type QuestGate,
  type QuestReward,
  type QuestStep
} from '../quests';

function step(part: Partial<QuestStep> = {}): QuestStep {
  return { block: 1, say: [], needs: [], takes: [], gives: [], ...part };
}

function quest(steps: QuestStep[]): Quest {
  return { id: 126, name: 'TestQuest', steps };
}

/**
 * Which alignment band a quest is for, off the realm's own bounds.
 *
 * `goodaligned L` is `alignment <= L` and `evilaligned L` is `>= L`: one bound
 * names an end of the axis, and both name the span between them. The two used
 * to be read as independent flags, so a gate stating both set good *and* evil
 * and fell through to `any` — which is how the realm's own `NeutralQuest`, on
 * every one of its 47 alignment gates, came to be offered to a paladin.
 */
describe('which side of the line a quest is for', () => {
  const gate = (part: Partial<Extract<QuestGate, { kind: 'alignment' }>>): QuestGate => ({
    kind: 'alignment',
    ...part
  });

  it('reads an upper bound alone as the good end', () => {
    expect(questSide(quest([step({ needs: [gate({ atMost: -51 })] })]))).toBe('good');
  });

  it('reads a lower bound alone as the evil end', () => {
    expect(questSide(quest([step({ needs: [gate({ atLeast: 30 })] })]))).toBe('evil');
  });

  it('reads a gate bounded at both ends as the middle', () => {
    // The shipped realm's own numbers for `NeutralQuest`.
    const banded = quest([step({ needs: [gate({ atLeast: -50, atMost: 29 })] })]);
    expect(questSide(banded)).toBe('neutral');
  });

  it('holds the band across every step that states one', () => {
    const chain = quest([
      step({ needs: [gate({ atLeast: -50, atMost: 29 })] }),
      step({ needs: [gate({ atLeast: -50, atMost: 29 })] }),
      step({ needs: [{ kind: 'level', min: 15 }] })
    ]);
    expect(questSide(chain)).toBe('neutral');
  });

  it('refuses rather than picks when the steps name two bands', () => {
    const split = quest([
      step({ needs: [gate({ atMost: -51 })] }),
      step({ needs: [gate({ atLeast: 30 })] })
    ]);
    expect(questSide(split)).toBe('any');
  });

  it('is anybody’s when no step states an alignment at all', () => {
    expect(questSide(quest([step({ needs: [{ kind: 'level', min: 35 }] })]))).toBe('any');
  });
});

/**
 * A step's per-class routes carry gates too, and the summaries have to see
 * them. `Smash`, `PerfectStealth` and `Meditate` state their level on every
 * route and nothing on the line the routes share, so a reader of `needs` alone
 * drew all three as quests with **no level requirement at all** — unknown as
 * the reassuring answer, which is the one this project refuses.
 */
describe('summaries read a step’s routes as well as what it shares', () => {
  const routed = quest([
    step({
      needs: [{ kind: 'ability-absent', id: 32 }],
      ways: [
        {
          needs: [
            { kind: 'class', id: 1 },
            { kind: 'level', min: 22 }
          ],
          takes: [],
          gives: []
        },
        {
          needs: [
            { kind: 'class', id: 2 },
            { kind: 'level', min: 20 }
          ],
          takes: [],
          gives: []
        }
      ]
    })
  ]);

  it('finds a level no step states outside its routes', () => {
    expect(questLevel(routed)).toBe(20);
  });

  it('finds an alignment band a route states', () => {
    const banded = quest([
      step({
        ways: [
          { needs: [{ kind: 'alignment', atLeast: -50, atMost: 29 }], takes: [], gives: [] },
          { needs: [{ kind: 'alignment', atLeast: -50, atMost: 29 }], takes: [], gives: [] }
        ]
      })
    ]);
    expect(questSide(banded)).toBe('neutral');
  });
});

describe('what a quest asks and pays', () => {
  it('takes the lowest level any step demands, not the first', () => {
    const chain = quest([
      step({ needs: [{ kind: 'level', min: 35 }] }),
      step({ needs: [{ kind: 'level', min: 15 }] })
    ]);
    expect(questLevel(chain)).toBe(15);
  });

  // Null is not zero: a quest the realm gates on no level is open to everybody.
  it('says nothing rather than zero when no step names a level', () => {
    expect(questLevel(quest([step()]))).toBeNull();
  });

  it('adds the experience across every step', () => {
    const paid: QuestReward[] = [{ kind: 'exp', amount: 250_000 }];
    const chain = quest([step({ gives: paid }), step({ gives: paid }), step()]);
    expect(questExperience(chain)).toBe(500_000);
  });
});

/**
 * Which steps a counter leaves behind, and the zero that is not an absence.
 *
 * The realm's `giveability <id> 0` grants a counter at rank **zero** — a flag,
 * gated by `failability` — and a complete `abil` listing that never names an
 * id reads it as zero too, correctly, because that is the sum the server gates
 * on. So the rank alone cannot tell the two apart, and `to <= rank` marked
 * PerfectStealth's one step done for every character alive. Reported
 * 2026-09-15; the shipped realms hold exactly one step of this shape each,
 * which is why it went unseen.
 */
describe('which steps a counter leaves behind', () => {
  it('leaves a step behind once the rank reaches the rank it sets', () => {
    expect(stepDone(step({ to: 3 }), 3, true)).toBe(true);
    expect(stepDone(step({ to: 4 }), 3, true)).toBe(false);
  });

  // The realm writes alternatives as separate steps with the same `to`, so
  // doing either does both and position in the list decides nothing.
  it('counts by rank and never by position', () => {
    const chain = quest([step({ to: 2 }), step({ to: 2 }), step({ to: 3 })]);
    expect(stepsDone(chain, 2, true)).toBe(2);
  });

  it('refuses a step the realm sets no rank for', () => {
    expect(stepDone(step(), 9, true)).toBe(false);
  });

  it('holds a rank-zero step until the counter is held at all', () => {
    // PerfectStealth's whole shape: never had it, then granted at zero.
    const flag = quest([step({ to: 0, needs: [{ kind: 'ability-absent', id: 186 }] })]);
    expect(stepsDone(flag, 0, false)).toBe(0);
    expect(stepsDone(flag, 0, true)).toBe(1);
  });

  it('holds every step of an unheld counter, whatever rank is claimed', () => {
    expect(stepDone(step({ to: 1 }), 5, false)).toBe(false);
  });
});

/**
 * The steps a plan carries: one per rank, from the counter to the target.
 *
 * Alternatives share a rank and the first the client could tell somebody to
 * do is taken; what is behind the character is left out; a target the realm
 * sets no rank for, or one already reached, plans nothing.
 */
describe('the span of a plan', () => {
  const chain = quest([
    step({ block: 1, to: 1, who: 'elder', say: ['traders'] }),
    step({ block: 2, from: 1, to: 2, who: 'sergeant', say: ['head'] }),
    // Two ways to rank 3: a Warrior's asker and a Mage's, the first actable
    // one is the plan's.
    step({ block: 3, from: 2, to: 3, who: 'Meia', say: ['box'] }),
    step({ block: 4, from: 2, to: 3, who: 'Other', say: ['box'] }),
    step({ block: 5, from: 3, to: 4, who: 'Tolgard', say: ['return'] })
  ]);

  it('plans every rank after the character’s up to the target, in rank order', () => {
    expect(planSpan(chain, 5, 1).map((s) => s.block)).toEqual([2, 3, 5]);
  });

  it('plans from the start where nothing has stated the counter', () => {
    expect(planSpan(chain, 2, null).map((s) => s.block)).toEqual([1, 2]);
  });

  it('takes one step per rank, the first the client can place', () => {
    const traced = quest([
      step({ block: 9, to: 1 }),
      step({ block: 10, to: 1, who: 'elder', say: ['x'] })
    ]);
    expect(planSpan(traced, 10, null).map((s) => s.block)).toEqual([10]);
  });

  it('plans nothing for a step already behind the character', () => {
    expect(planSpan(chain, 2, 2)).toEqual([]);
    expect(planSpan(chain, 2, 5)).toEqual([]);
  });

  it('plans nothing for a block the realm sets no rank for, or does not hold', () => {
    expect(planSpan(quest([step({ block: 7 })]), 7, null)).toEqual([]);
    expect(planSpan(chain, 99, null)).toEqual([]);
  });
});

describe('what a plan step does', () => {
  it('asks the asker the first word', () => {
    expect(planAct(step({ who: 'seeress', say: ['accept', 'yes'] }))).toEqual({
      verb: 'ask',
      who: 'seeress',
      say: 'accept'
    });
  });

  it('says the phrase where a room owns the step', () => {
    expect(planAct(step({ room: '12/2248', say: ['peruse red book'] }))).toEqual({
      verb: 'say',
      phrase: 'peruse red book'
    });
  });

  it('kills where a death owns it, whatever else the step says', () => {
    expect(planAct(step({ kill: 'Dao Lord', who: 'x', say: ['y'] }))).toEqual({
      verb: 'kill',
      mob: 'Dao Lord'
    });
  });

  it('refuses a step traced to nobody, nowhere and no death', () => {
    expect(planAct(step({ say: ['word'] }))).toBeNull();
    expect(planAct(step({ who: 'elder' }))).toBeNull();
  });
});

describe('an earlier step that hands the item over', () => {
  const chain = quest([
    step({ block: 1, to: 1, gives: [{ kind: 'item', id: 50, name: 'heavy box' }] }),
    step({ block: 2, to: 2, ways: [{ needs: [], takes: [], gives: [{ kind: 'item', id: 51 }] }] }),
    step({ block: 3, to: 3, takes: [{ id: 50 }] })
  ]);

  it('names the rank of the step that gives it, only ahead of the asker', () => {
    expect(earlierHandover(chain, 2, 50)).toBe(1);
    expect(earlierHandover(chain, 0, 50)).toBeNull();
  });

  it('reads every route of the earlier step', () => {
    expect(earlierHandover(chain, 2, 51)).toBe(2);
  });

  it('answers null for an item nothing earlier gives', () => {
    expect(earlierHandover(chain, 2, 99)).toBeNull();
  });
});

/**
 * Which shelf of the book a quest is on: open, done, or shut.
 *
 * Done is decided first because it is the stronger statement, and the two
 * cannot both hold — `questBars` asks about the rank after the character's.
 */
describe('which shelf a quest is on', () => {
  const shut = [{ kind: 'level' as const, level: 20 }];

  it('shelves a quest with nothing done and nothing in the way as open', () => {
    expect(questGroup(0, 12, [])).toBe('open');
  });

  it('keeps a quest under way on the open shelf', () => {
    expect(questGroup(3, 12, [])).toBe('open');
  });

  it('shelves a finished quest as done', () => {
    expect(questGroup(12, 12, [])).toBe('done');
  });

  it('shelves a barred quest as shut, however far along it is', () => {
    expect(questGroup(0, 52, shut)).toBe('barred');
    expect(questGroup(9, 52, shut)).toBe('barred');
  });

  it('never calls a quest of no steps finished', () => {
    expect(questGroup(0, 0, [])).toBe('open');
  });

  it('reads the shelves in the order the book draws them', () => {
    expect(QUEST_GROUPS).toEqual(['open', 'done', 'barred']);
  });
});

/**
 * What shuts a character out of a quest, from the realm's own gates.
 *
 * Three facts the realm gates on and the client holds a matching one for, and
 * three refusals: an unknown sheet bars nothing, a gate the realm names no
 * word for settles nothing, and alignment is not asked at all — the gate is a
 * number and the roster's standing is a word.
 */
describe('what a character cannot do', () => {
  /** Nobody has taken a rank of it yet, which is where a reader usually is. */
  const START = { rank: null, held: false };
  const anybody = { className: null, race: null, level: null, counters: null };
  const paladin = { className: 'Paladin', race: 'Human', level: 12, counters: null };
  /*
   * With an asker on it. A step traced to nobody, nowhere and no death is not
   * an act the client can tell anybody to perform, so it bars nothing and
   * opens nothing — the rule the last two cases here are about.
   */
  const asked = (part: Partial<QuestStep> = {}): QuestStep => step({ who: 'Aldreth', ...part });

  it('bars a quest whose one step names another class', () => {
    const only = quest([asked({ to: 1, needs: [{ kind: 'class', id: 8, name: 'Thief' }] })]);
    expect(questBars(only, paladin, START)).toEqual([{ kind: 'class', names: ['Thief'] }]);
  });

  it('bars on race the same way, by the word the realm states', () => {
    const only = quest([asked({ to: 1, needs: [{ kind: 'race', id: 9, name: 'Gaunt One' }] })]);
    expect(questBars(only, paladin, START)).toEqual([{ kind: 'race', names: ['Gaunt One'] }]);
  });

  it('matches the sheet against the realm case-insensitively', () => {
    const mine = quest([asked({ to: 1, needs: [{ kind: 'class', id: 1, name: 'paladin' }] })]);
    expect(questBars(mine, paladin, START)).toEqual([]);
  });

  /*
   * The one thing that must not become a guess. A card is drawn before the
   * stat sheet lands, and a book that dimmed half its rows on connect and
   * filled them back in a second later would be reporting the client's own
   * progress rather than the realm's.
   */
  it('bars nothing at all for a character it knows nothing about', () => {
    const only = quest([
      asked({
        to: 1,
        needs: [
          { kind: 'class', id: 8, name: 'Thief' },
          { kind: 'level', min: 40 }
        ]
      })
    ]);
    expect(questBars(only, anybody, START)).toEqual([]);
  });

  it('says nothing about a gate the realm names no word for', () => {
    const only = quest([asked({ to: 1, needs: [{ kind: 'class', id: 8 }] })]);
    expect(questBars(only, paladin, START)).toEqual([]);
  });

  // Steps that set the same rank are alternatives — `stepDone`'s rule read the
  // other way round — so one of them being open is the quest being open.
  it('keeps a quest whose rank is reachable by one of its alternative steps', () => {
    const chain = quest([
      asked({ block: 1, to: 1, needs: [{ kind: 'class', id: 8, name: 'Thief' }] }),
      asked({ block: 2, to: 1, needs: [{ kind: 'class', id: 1, name: 'Paladin' }] })
    ]);
    expect(questBars(chain, paladin, START)).toEqual([]);
  });

  it('bars a quest when every step setting one rank is shut', () => {
    const chain = quest([
      asked({ block: 1, to: 1, needs: [{ kind: 'class', id: 8, name: 'Thief' }] }),
      asked({ block: 2, to: 1, needs: [{ kind: 'class', id: 7, name: 'Ninja' }] })
    ]);
    expect(questBars(chain, paladin, START)).toEqual([
      { kind: 'class', names: ['Thief', 'Ninja'] }
    ]);
  });

  /*
   * `Meditate`'s exact shape: eleven class lines and the reader's own, gated at
   * a level. Collecting every route's reason said *Cleric, Priest … only* to a
   * Paladin whose own line is right there and wants nothing but the levels.
   */
  it('reports the softest route where the routes are shut for different reasons', () => {
    const routed = quest([
      asked({
        to: 1,
        ways: [
          { needs: [{ kind: 'class', id: 2, name: 'Cleric' }], takes: [], gives: [] },
          {
            needs: [
              { kind: 'class', id: 1, name: 'Paladin' },
              { kind: 'level', min: 27 }
            ],
            takes: [],
            gives: []
          }
        ]
      })
    ]);
    expect(questBars(routed, paladin, START)).toEqual([{ kind: 'level', level: 27 }]);
  });

  // The next rung that changes anything, not what finishing would cost.
  it('names the lowest level that opens something', () => {
    const chain = quest([
      asked({ block: 1, to: 1, needs: [{ kind: 'level', min: 20 }] }),
      asked({ block: 2, to: 2, needs: [{ kind: 'level', min: 45 }] })
    ]);
    expect(questBars(chain, paladin, START)).toEqual([{ kind: 'level', level: 20 }]);
  });

  // A gate every route shares holds whichever route is taken.
  it('bars on a gate the step states outside its routes', () => {
    const routed = quest([
      asked({
        to: 1,
        needs: [{ kind: 'race', id: 9, name: 'Gaunt One' }],
        ways: [
          { needs: [{ kind: 'class', id: 1, name: 'Paladin' }], takes: [], gives: [] },
          { needs: [{ kind: 'class', id: 8, name: 'Thief' }], takes: [], gives: [] }
        ]
      })
    ]);
    expect(questBars(routed, paladin, START)).toEqual([{ kind: 'race', names: ['Gaunt One'] }]);
  });

  /*
   * `Smash`'s exact shape. The realm writes the grant in its own block at the
   * end of the chain — `failability 32 : giveability 32 1`, called from the
   * `text 2949` that ends the asker's own lines — so the traversal builds it as
   * a second step at the same rank with no gates at all. Counted as an
   * alternative, it opened the quest to a level-4 warrior whose one real way in
   * wants level 22 of them.
   */
  it('lets no step it cannot place open a rank every placed one shuts', () => {
    const chain = quest([
      asked({ block: 1, to: 1, needs: [{ kind: 'level', min: 22 }] }),
      step({ block: 2, to: 1 })
    ]);
    expect(questBars(chain, paladin, START)).toEqual([{ kind: 'level', level: 22 }]);
  });

  // And it shuts nothing either: a rank written only in steps with no asker,
  // no room and no death is one the client can say nothing at all about.
  it('bars nothing on a rank written only in steps it cannot place', () => {
    expect(questBars(quest([step({ block: 2, to: 1 })]), paladin, START)).toEqual([]);
  });

  /*
   * The whole point of asking about the *next* step. `GoodQuest`'s first rank
   * asks nothing but that you have started neither of the other two chains;
   * its rank four wants level 10. Read as a claim about the chain, the realm's
   * own storyline came out sunk and dimmed for a level-1 character, saying
   * *needs level 10* — rank four's gate, and no reason at all not to go and
   * start it. All three great chains, in both shipped worlds, until level 60.
   */
  it('asks about the step that is next, not about a gate five ranks ahead', () => {
    const chain = quest([
      asked({ block: 1, to: 1 }),
      asked({ block: 2, to: 2, needs: [{ kind: 'level', min: 40 }] })
    ]);
    expect(questBars(chain, paladin, START)).toEqual([]);
  });

  it('and bars once the character has taken the ranks before it', () => {
    const chain = quest([
      asked({ block: 1, to: 1 }),
      asked({ block: 2, to: 2, needs: [{ kind: 'level', min: 40 }] })
    ]);
    expect(questBars(chain, paladin, { rank: 1, held: true })).toEqual([
      { kind: 'level', level: 40 }
    ]);
  });

  it('bars nothing at all about a quest every rank of which is behind them', () => {
    const chain = quest([asked({ to: 1, needs: [{ kind: 'level', min: 40 }] })]);
    expect(questBars(chain, paladin, { rank: 1, held: true })).toEqual([]);
  });

  /*
   * The realm's exclusivity mechanism, and the one bar in the data that is
   * forever: a character who has taken a rank of NeutralQuest can never do
   * GoodQuest, at any level, in any class.
   */
  it('bars a chain whose counter this character has already spent elsewhere', () => {
    const chain = quest([
      asked({ to: 1, needs: [{ kind: 'ability-absent', id: 127, name: 'NeutralQuest' }] })
    ]);
    const started = { ...paladin, counters: { sums: { 127: 3 }, complete: true, at: 1 } };
    expect(questBars(chain, started, START)).toEqual([
      { kind: 'counter', names: ['NeutralQuest'] }
    ]);
  });

  // The coin rule: only a listing that ran to its end enumerates, so only that
  // one can say a counter the step demands you have never had is one you have.
  it('says nothing from a listing that did not run to its end', () => {
    const chain = quest([
      asked({ to: 1, needs: [{ kind: 'ability-absent', id: 127, name: 'NeutralQuest' }] })
    ]);
    const half = { ...paladin, counters: { sums: {}, complete: false, at: 1 } };
    expect(questBars(chain, half, START)).toEqual([]);
  });

  /*
   * Every step of a chain gates on the counter it advances — that bookkeeping
   * is what makes it a chain — so a quest's own `failability` is never a
   * reason anybody is shut out of it.
   */
  it('never reads a quest own counter as a bar on itself', () => {
    const chain = quest([
      asked({ to: 1, needs: [{ kind: 'ability-absent', id: 126, name: 'TestQuest' }] })
    ]);
    const under = { ...paladin, counters: { sums: { 126: 2 }, complete: true, at: 1 } };
    expect(questBars(chain, under, START)).toEqual([]);
  });

  // An empty class is nobody's class. `ownWay` guards the same field for the
  // same reason: answering *false* would bar every class-gated quest off a blank.
  it('bars nothing off a blank class', () => {
    const only = quest([asked({ to: 1, needs: [{ kind: 'class', id: 8, name: 'Thief' }] })]);
    expect(questBars(only, { ...paladin, className: '  ' }, START)).toEqual([]);
  });

  /*
   * Alignment is deliberately never a bar: `goodaligned` is a number on an axis
   * a realm may put anywhere, and the only standing the client holds is the
   * `who` roster's word. The card's side chips are where that is asked.
   */
  it('never bars on alignment, whose gate is a number and whose fact is a word', () => {
    const good = quest([step({ to: 1, needs: [{ kind: 'alignment', atMost: -51 }] })]);
    expect(questBars(good, paladin, START)).toEqual([]);
  });
});

/*
 * What the things standing in the room can be asked — reported as *add buttons
 * for mobs in room, `ask Morukai phoenix`, `ask Morukai components`, if and
 * only if the requirements are met*. Morukai answers four words across four
 * ranks of one chain, so the counter is the gate that makes this one chip
 * rather than a menu of three refusals.
 */
describe('what the room’s occupants can be asked', () => {
  const MORUKAI: Quest = {
    id: 133,
    name: 'PhoenixQuest',
    steps: [
      {
        block: 1440,
        who: 'Morukai',
        say: ['phoenix', 'prophecy', 'orfeo'],
        needs: [{ kind: 'ability', id: 133, atLeast: 4, atMost: 4 }],
        takes: [],
        gives: [],
        from: 4,
        to: 5
      },
      {
        block: 1448,
        who: 'Morukai',
        say: ['components'],
        needs: [
          { kind: 'ability', id: 133, atLeast: 5, atMost: 5 },
          { kind: 'item', id: 966, name: 'acid gland' },
          { kind: 'item', id: 995, name: 'cave roots' }
        ],
        takes: [],
        gives: [],
        from: 5,
        to: 6
      }
    ]
  };
  const anybody: QuestDoer = { className: null, race: null, level: null, counters: null };
  const at = (rank: number): QuestDoer => ({
    ...anybody,
    counters: { sums: { 133: rank }, complete: true, at: 1 }
  });

  it('offers only the word this rank is for', () => {
    const asks = asksHere([MORUKAI], ['Morukai'], at(4), null, []);
    expect(asks.map((ask) => ask.say)).toEqual(['phoenix']);
    expect(asks[0]).toMatchObject({ who: 'Morukai', quest: 'PhoenixQuest', counter: 133, to: 5 });
  });

  it('moves on with the rank', () => {
    expect(asksHere([MORUKAI], ['Morukai'], at(5), null, [966, 995]).map((a) => a.say)).toEqual([
      'components'
    ]);
  });

  it('offers nothing about a rank that is behind this character', () => {
    expect(asksHere([MORUKAI], ['Morukai'], at(6), null, [])).toEqual([]);
  });

  /*
   * The rule that keeps this reachable at all: a realm with no `abil` states
   * no counter, and a client that refused on unknown would draw this on
   * GreaterMUD after a command the player may never send, and nowhere else.
   */
  it('offers every word when nothing has stated the counter', () => {
    const asks = asksHere([MORUKAI], ['Morukai'], anybody, null, null);
    expect(asks.map((ask) => ask.say)).toEqual(['phoenix', 'components']);
    // And says nothing about items, because nobody has listed the pack.
    expect(asks[1]?.wants).toBeUndefined();
  });

  /* A watched ask is main's too, and stands in where no listing has been read. */
  it('takes the rank this session watched where the realm has counted nothing', () => {
    expect(
      asksHere([MORUKAI], ['Morukai'], anybody, { 133: { to: 5, at: 1 } }, null).map((a) => a.say)
    ).toEqual(['components']);
  });

  /*
   * A blocked exit is still an exit. What a step wants is an errand — and the
   * client holds, on that very item, where to go and get one (format 39).
   */
  it('names what a listed pack is missing rather than dropping the chip', () => {
    const asks = asksHere([MORUKAI], ['Morukai'], at(5), null, [966]);
    expect(asks[0]?.wants).toEqual(['cave roots']);
  });

  /*
   * The other end of the same question, which the Quest card's ticks read:
   * what a step already has. Three answers, and the third is the whole rule —
   * a pack nobody has listed is neither carrying it nor not carrying it.
   */
  it('answers what a listed pack holds, and refuses to answer for an unlisted one', () => {
    expect(packHolds([966, 995], 966)).toBe(true);
    expect(packHolds([995], 966)).toBe(false);
    expect(packHolds([], 966)).toBe(false);
    expect(packHolds(null, 966)).toBeNull();
  });

  it('says nothing about a monster that is not standing here', () => {
    expect(asksHere([MORUKAI], ['giant rat'], at(4), null, [])).toEqual([]);
  });

  /* The room's own word for the name is what the server will match. */
  it('spells the asker the way the room listed it', () => {
    expect(asksHere([MORUKAI], ['morukai'], at(4), null, [])[0]?.who).toBe('morukai');
  });

  /* What sinks a quest to the bottom of the Quest card keeps a chip off this one. */
  it('offers nothing this character is shut out of', () => {
    const gated: Quest = {
      ...MORUKAI,
      steps: [{ ...MORUKAI.steps[0]!, needs: [{ kind: 'class', id: 1, name: 'Warrior' }] }]
    };
    const mage = { ...anybody, className: 'Mage' };
    expect(asksHere([gated], ['Morukai'], mage, null, [])).toEqual([]);
    // And an unknown class bars nothing: unknown is never the reassuring answer.
    expect(asksHere([gated], ['Morukai'], anybody, null, []).map((a) => a.say)).toEqual([
      'phoenix'
    ]);
  });
});

/*
 * A step that rolls (todo 106): the first `skill` gate on the step's own
 * line, and the odds of one try as the server computes them —
 * `TextBlockPart.cs:1235`, the stat less the value clamped to 2..98.
 */
describe('a step that rolls', () => {
  const rolling: QuestStep = {
    block: 2605,
    who: 'red book',
    say: ['read red'],
    needs: [
      { kind: 'ability', id: 134, atLeast: 6 },
      { kind: 'skill', stat: 'intellect', value: 30 }
    ],
    takes: [],
    gives: [],
    to: 7
  };

  it('names the roll, and none for a step without one', () => {
    expect(stepRoll(rolling)).toEqual({ stat: 'intellect', value: 30 });
    expect(stepRoll({ ...rolling, needs: [] })).toBeNull();
  });

  it('gives the odds off the sheet, clamped as the server clamps them', () => {
    expect(rollChance(45, 30)).toBe(15);
    expect(rollChance(30, 30)).toBe(2);
    expect(rollChance(200, 30)).toBe(98);
    // An unread stat is unknown, never a chance.
    expect(rollChance(null, 30)).toBeNull();
  });
});
