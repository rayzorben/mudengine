import { describe, expect, it } from 'vitest';

import {
  questBars,
  questExperience,
  questLevel,
  questSide,
  stepDone,
  stepsDone,
  type Quest,
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
