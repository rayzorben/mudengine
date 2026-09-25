import { describe, expect, it, vi } from 'vitest';

import { Barriers } from '../Barriers';
import { WalkClock } from '../clock';
import { t } from '../../../app/i18n';
import type { CharacterState } from '../../../../shared/character';
import { DEFAULT_INTERNAL } from '../../../../shared/internal';
import type { WalkHold } from '../../../../shared/walk';
import {
  CONFIG,
  ROUTE,
  at,
  configWith,
  moves,
  printing,
  settle,
  routeOf,
  stepOf,
  wire,
  useRigs
} from './walking';

/*
 * The barrier ladder left `Walker` in todo 740. `Walker` still decides when
 * it is asked — the search after the fight, the shut door after the light —
 * and when what it remembers is let go. Each test is red under the mutation
 * named beside it (recorded in the todo's write-up).
 */

const TUNING = DEFAULT_INTERNAL.tuning;

const walkerOn = useRigs();

/** A door the realm records 41 picklocks or strength for, then a plain step. */
const GATED = routeOf(
  stepOf(1, 2, 'e', {
    requirement: {
      kind: 'door',
      raw: 'Door [41 picklocks/strength]',
      pickDifficulty: 41,
      bashDifficulty: 41
    }
  }),
  stepOf(2, 3, 'e')
);

/** Standing in 1/1 with a stat sheet read. */
const skilled = (strength: number, picklocks: number): CharacterState => {
  const state = at(1, 1);
  return { ...state, progress: { ...state.progress, strength, picklocks } };
};

describe('when Walker asks the ladder', () => {
  // Mutant: the search asked before the fight.
  it('answers a fight before searching for an exit the room has not printed', () => {
    const hidden = routeOf(
      stepOf(1, 2, 'e', {
        requirement: { kind: 'hidden', raw: 'Hidden/Searchable', searchable: true }
      })
    );
    const fighting = printing(1, [['n', null]], { inCombat: true });
    const { walker, sent } = walkerOn({ willFight: () => true, stateNow: () => fighting });
    walker.start(hidden, fighting);
    expect(sent).toEqual([]);
    expect(walker.progress.hold).toBe('fight');

    // Positive control: out of the fight, the same room is searched.
    const calm = printing(1, [['n', null]]);
    const other = walkerOn({ stateNow: () => calm });
    other.walker.start(hidden, calm);
    expect(other.sent).toEqual(['search e']);
  });

  // Mutant: the shut door opened before the light is asked for.
  it('readies the light before it opens the door the room says is shut', () => {
    const shut = printing(1, [['e', 'closed door']]);
    const { walker, sent } = walkerOn(
      (queue) => ({
        stateNow: () => shut,
        beforeStep: () => {
          queue.enqueue({ command: 'light torch', priority: 'movement', reason: 'the dark' });
        }
      }),
      configWith({ movement: { openDoors: true, openTries: 1 } })
    );
    walker.start(ROUTE, shut);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['light torch', 'open e']);
  });

  // Mutant: the skills kept only while walking.
  it('grades a door against a sheet read before the walk began', () => {
    const { walker, sent } = walkerOn(
      {},
      configWith({ movement: { bashDoors: true, bashTries: 1 } })
    );
    walker.onCharacter(skilled(60, 0));
    walker.start(GATED, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(moves(sent)).toEqual(['e', 'bas e']);
  });

  // Mutant: configure not handed on to the ladder.
  it('opens doors once the configuration says to', () => {
    const { walker, sent } = walkerOn();
    walker.configure(configWith({ movement: { openDoors: true, openTries: 1 } }));
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(moves(sent)).toEqual(['e', 'open e']);
  });
});

describe('what the ladder remembers, let go', () => {
  // Mutants: the landing does not pass the door; passing it keeps the lock.
  it('asks the next door to open after one it was told was locked', () => {
    const { walker, sent } = walkerOn(
      {},
      configWith({ movement: { openDoors: true, openTries: 3 } })
    );
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    walker.onBlock(wire('open-failed', { barrier: 'door', reason: 'locked' }));
    // A round at the door, the step again, and this time it lands.
    vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 200);
    walker.onCharacter(at(1, 2));
    settle();
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(moves(sent)).toEqual(['e', 'open e', 'e', 'e', 'open e']);
  });

  // Mutants: the landing does not pass the door; passing it keeps the rounds.
  it('stands at the next door for rounds of its own, and says so again', () => {
    const { walker, notices } = walkerOn();
    const holding = t('automation.walk.barrierHolding', {
      barrier: 'door',
      detail: t('automation.walk.barrierNotAllowed')
    });
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    expect(notices.filter((line) => line === holding)).toHaveLength(1);
    vi.advanceTimersByTime(TUNING.walk.barrierRetryMs + 200);
    walker.onCharacter(at(1, 2));
    settle();
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    expect(notices.filter((line) => line === holding)).toHaveLength(2);
  });

  // Mutant: a new walk keeps the last one's lock.
  it('asks a door to open on a new walk, whatever the last walk was told', () => {
    const { walker, sent } = walkerOn(
      {},
      configWith({ movement: { openDoors: true, openTries: 3 } })
    );
    walker.start(ROUTE, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    walker.onBlock(wire('open-failed', { barrier: 'door', reason: 'locked' }));
    walker.stop('asked to');
    settle();

    walker.start(ROUTE, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(moves(sent)).toEqual(['e', 'open e', 'e', 'open e']);
  });

  // Mutant: a lever detour keeps the ladder's attempt in flight.
  it('forgets the attempt in flight when a lever takes the walk elsewhere', () => {
    const asked: string[] = [];
    let quarry = false;
    const gated = routeOf(
      stepOf(1, 2, 'e', {
        requirement: { kind: 'door', raw: 'Door [301 picklocks/strength]', pickDifficulty: 301 }
      })
    );
    const { walker, sent } = walkerOn(
      {
        leversFor: () => [{ at: '1/9', roomName: 'Guardroom', say: 'pull lever' }],
        stateNow: () => at(1, 1),
        replan: (to) => {
          asked.push(to);
          return routeOf(stepOf(1, 9, 'w'));
        },
        holdAt: () => quarry
      },
      configWith({ movement: { openDoors: true, openTries: 1 } })
    );
    walker.start(gated, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'gate' }));
    expect(moves(sent)).toEqual(['e', 'open e']);
    // `No exit` while the `open` is out: the lever errand, held on the way.
    quarry = true;
    walker.onBlock(wire('direction-failed'));
    expect(asked).toEqual(['1/9']);
    // The gate's answer to the `open` is nothing to the walk to the lever.
    walker.onBlock(wire('open-failed', { barrier: 'gate', reason: 'locked' }));
    expect(asked).toEqual(['1/9']);
  });

  // Mutants: the walker's reset leaves the ladder; the ladder's reset keeps the sheet.
  it('forgets the stat sheet on a new connection', () => {
    const { walker, sent } = walkerOn(
      {},
      configWith({ movement: { bashDoors: true, bashTries: 1 } })
    );
    walker.onCharacter(skilled(60, 0));
    // Positive control: graded against the sheet, the door is bashed.
    walker.start(GATED, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(moves(sent)).toEqual(['e', 'bas e']);

    walker.reset();
    settle();
    walker.start(GATED, at(1, 1));
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    expect(moves(sent)).toEqual(['e', 'bas e', 'e']);
  });
});

describe('Barriers, put down', () => {
  /** The ladder alone, at a door east, recording what it asked of the walk. */
  const ladder = (
    config = CONFIG
  ): { barriers: Barriers; dispatched: string[]; notices: string[]; clock: WalkClock } => {
    const dispatched: string[] = [];
    const notices: string[] = [];
    const clock = new WalkClock();
    let slot: WalkHold = null;
    const barriers = new Barriers(
      config,
      { enqueue: () => true },
      { notice: (message) => notices.push(message) },
      {
        walking: () => true,
        quiet: () => false,
        step: () => ROUTE.steps[0],
        publish: () => {},
        stop: () => {},
        stepAgain: () => {},
        retry: () => {},
        dispatch: (_step, command) => {
          dispatched.push(command);
        },
        onWire: () => true,
        nudgeAfter: () => TUNING.walk.nudgeAfterMs,
        reprint: () => {}
      },
      clock,
      {
        get current() {
          return slot;
        },
        take: (hold) => {
          slot = hold;
        }
      },
      {
        pullLevers: () => false,
        fetchLever: () => false,
        blameable: () => true,
        forgetPulls: () => {}
      }
    );
    return { barriers, dispatched, notices, clock };
  };

  // Mutant: reset keeps the rounds.
  it('gives the next door its rounds again', () => {
    const { barriers, notices, clock } = ladder();
    barriers.onRefusedStep(wire('direction-failed', { barrier: 'door' }));
    expect(notices).toHaveLength(1);
    barriers.reset();
    barriers.onRefusedStep(wire('direction-failed', { barrier: 'door' }));
    expect(notices).toHaveLength(2);
    clock.dispose();
  });

  // Mutant: reset keeps the lock.
  it('asks the next door to open, the lock forgotten', () => {
    const { barriers, dispatched, clock } = ladder(
      configWith({ movement: { openDoors: true, openTries: 3 } })
    );
    barriers.onRefusedStep(wire('direction-failed', { barrier: 'door' }));
    barriers.onOpenRefused(wire('open-failed', { barrier: 'door', reason: 'locked' }));
    barriers.reset();
    barriers.onRefusedStep(wire('direction-failed', { barrier: 'door' }));
    expect(dispatched).toEqual(['open e', 'open e']);
    clock.dispose();
  });
});
