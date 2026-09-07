import { describe, expect, it } from 'vitest';

import {
  questExperience,
  questLevel,
  questSide,
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
