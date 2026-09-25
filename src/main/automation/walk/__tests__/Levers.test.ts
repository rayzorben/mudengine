import { describe, expect, it, vi } from 'vitest';

import { Levers, type LeversWalk } from '../Levers';
import { DEFAULT_INTERNAL } from '../../../../shared/internal';
import type { RemoteLever, Requirement } from '../../../../shared/world';
import { ROUTE, at, moves, settle, routeOf, stepOf, wire, useRigs } from './walking';

/*
 * The lever errand left `Walker` in todo 740. What it remembers — the pulls
 * spent at a step, the gates it has made the errand for, whether it has said
 * a lever is out of reach — is let go by the walk's own events, and each test
 * here is red under the mutation named beside it (recorded in the todo's
 * write-up).
 */

const TUNING = DEFAULT_INTERNAL.tuning;

const walkerOn = useRigs();

/** A gate no character here can force, as the realm records the Inner Gate. */
const GATE: Requirement = {
  kind: 'door',
  raw: 'Door [301 picklocks/strength]',
  pickDifficulty: 301
};

/** A hidden exit whose one lever is in its own room. */
const LEVERED: Requirement = {
  kind: 'hidden',
  raw: 'Hidden/Needs 1 Actions, any order',
  searchable: false,
  actionsNeeded: 1,
  actions: [{ say: ['pull lever'] }]
};

/** The lever that opens the gate, one room west. */
const LEVER: RemoteLever = { at: '1/9', roomName: 'Guardroom', say: 'pull lever' };

describe('the order the ladder asks the lever rungs in', () => {
  /*
   * Mutant: the errand asked before the levers in this room. They pull the
   * same room's levers in two orders — `Requirement.actions`, the realm's own
   * lever numbering, and `leversFor`, the order the rooms were read — which
   * differ at two exits of each shipped realm (measured 2026-09-24): `6/2361`
   * south, `Needs 2 Actions, specific order`, whose index reads the panel
   * before the button, and `17/2235` west, whose first phrase differs.
   */
  it('pulls this room’s levers in the realm’s stated order, not the index’s', () => {
    const ordered: Requirement = {
      kind: 'hidden',
      raw: 'Hidden/Needs 2 Actions, specific order',
      searchable: false,
      actionsNeeded: 2,
      actionsOrdered: true,
      actions: [{ say: ['push button'] }, { say: ['slide open panel'] }]
    };
    const { walker, sent } = walkerOn({
      leversFor: () => [
        { at: '1/1', roomName: 'Room 1', say: 'slide open panel' },
        { at: '1/1', roomName: 'Room 1', say: 'push button' }
      ],
      stateNow: () => at(1, 1)
    });
    walker.start(routeOf(stepOf(1, 2, 's', { requirement: ordered })), at(1, 1));
    walker.onBlock(wire('direction-failed'));
    settle();
    expect(moves(sent)).toEqual(['s', 'push button', 'slide open panel', 's']);
  });
});

describe('what the errand remembers, let go', () => {
  // Mutants: the landing does not re-arm the notice; `landed` keeps it spent.
  it('says a lever is out of reach once a step, and again at the next', () => {
    let here = 1;
    const { walker, notices } = walkerOn({
      leversFor: (from) => [{ ...LEVER, say: `pull lever in ${from}` }],
      stateNow: () => at(1, here),
      replan: () => 'no way there'
    });
    walker.start(
      routeOf(stepOf(1, 2, 'e', { requirement: GATE }), stepOf(2, 3, 'e', { requirement: GATE })),
      at(1, 1)
    );
    walker.onBlock(wire('direction-failed', { barrier: 'gate' }));
    expect(notices.filter((line) => line.includes('pull lever in 1/1'))).toHaveLength(1);
    // A round at the gate, the step again, and this time it lands.
    vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 200);
    here = 2;
    walker.onCharacter(at(1, 2));
    settle();
    walker.onBlock(wire('direction-failed', { barrier: 'gate' }));
    expect(notices.filter((line) => line.includes('pull lever in 1/2'))).toHaveLength(1);
  });

  // Mutants: a new walk keeps the gates the last one made the errand for.
  it('asks after the lever again on a new walk', () => {
    const asked: string[] = [];
    const gated = routeOf(stepOf(1, 2, 'e', { requirement: GATE }));
    const { walker } = walkerOn({
      leversFor: () => [LEVER],
      stateNow: () => at(1, 1),
      replan: (to) => {
        asked.push(to);
        return 'no way there';
      }
    });
    walker.start(gated, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'gate' }));
    expect(asked).toEqual(['1/9']);
    walker.stop('asked to');
    settle();

    walker.start(gated, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'gate' }));
    expect(asked).toEqual(['1/9', '1/9']);
  });

  // Mutant: forgetting the barrier keeps the pulls.
  it('gives the next step pulls of its own', () => {
    const { walker, sent } = walkerOn();
    walker.start(
      routeOf(
        stepOf(1, 2, 'e', { requirement: LEVERED }),
        stepOf(2, 3, 'e', { requirement: LEVERED })
      ),
      at(1, 1)
    );
    // Refused until the first step's pulls are spent, and then it lands.
    for (let pull = 0; pull < TUNING.walk.leverTries; pull += 1) {
      walker.onBlock(wire('direction-failed'));
      settle();
    }
    walker.onCharacter(at(1, 2));
    settle();
    walker.onBlock(wire('direction-failed'));
    settle();

    expect(moves(sent).filter((command) => command === 'pull lever')).toHaveLength(
      TUNING.walk.leverTries + 1
    );
    expect(walker.progress.status).toBe('walking');
  });
});

describe('Levers, put down', () => {
  /** A walk that records what the errand asked of it. */
  const walkOf = (): LeversWalk & { detours: number } => {
    const walk = {
      detours: 0,
      quiet: () => true,
      stop: () => {},
      stepAgain: () => {},
      shortest: () => false,
      destination: () => ROUTE.steps.at(-1),
      detour: () => {
        walk.detours += 1;
      }
    };
    return walk;
  };

  // Mutant: reset keeps the gates it made the errand for.
  it('asks after a lever again once put down', () => {
    const asked: string[] = [];
    const levers = new Levers(
      { enqueue: () => true },
      {
        leversFor: () => [LEVER],
        stateNow: () => at(1, 1),
        replan: (to) => {
          asked.push(to);
          return 'no way there';
        }
      },
      walkOf()
    );
    const gate = stepOf(1, 2, 'e', { requirement: GATE });
    levers.fetchLever(gate);
    levers.fetchLever(gate);
    // Positive control: once a walk.
    expect(asked).toEqual(['1/9']);
    levers.reset();
    levers.fetchLever(gate);
    expect(asked).toEqual(['1/9', '1/9']);
  });

  // Mutant: reset keeps the pulls.
  it('gives the pulls back once put down', () => {
    const levers = new Levers({ enqueue: () => true }, {}, walkOf());
    const step = stepOf(1, 2, 'e', { requirement: LEVERED });
    for (let pull = 0; pull < TUNING.walk.leverTries; pull += 1) {
      expect(levers.pullLevers(step)).toBe(true);
    }
    expect(levers.pullLevers(step)).toBe(false);
    levers.reset();
    expect(levers.pullLevers(step)).toBe(true);
  });

  // Mutant: drop keeps the errand.
  it('drops the errand in hand when the walk stops', () => {
    /** An errand made for the gate: the walk sent west to the Guardroom. */
    const onAnErrand = (): Levers => {
      const walk = walkOf();
      const levers = new Levers(
        { enqueue: () => true },
        {
          leversFor: () => [LEVER],
          stateNow: () => at(1, 1),
          replan: (to) => routeOf(to === '1/9' ? stepOf(1, 9, 'w') : stepOf(9, 3, 'e'))
        },
        walk
      );
      expect(levers.fetchLever(stepOf(1, 2, 'e', { requirement: GATE }))).toBe(true);
      expect(walk.detours).toBe(1);
      return levers;
    };
    // Positive control: kept, the Guardroom's arrival is the errand's.
    expect(onAnErrand().finishErrand(at(1, 9))).toBe(true);

    const dropped = onAnErrand();
    dropped.drop();
    expect(dropped.finishErrand(at(1, 9))).toBe(false);
  });
});
