import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Holds, type HoldsWalk } from '../Holds';
import { WalkClock } from '../clock';
import { t } from '../../../app/i18n';
import { NO_AFFLICTIONS } from '../../../../shared/character';
import { AFFLICTION_HOLDS } from '../../../../shared/walk';
import { DEFAULT_INTERNAL } from '../../../../shared/internal';
import {
  CONFIG,
  ROUTE,
  at,
  configWith,
  hurt,
  moves,
  routeOf,
  stepOf,
  wire,
  useRigs
} from './walking';

/*
 * The holds left `Walker` in todo 740. `Walker` still decides the order they
 * are asked in, and every test here is the consequence of one of those
 * orders, or of one clearing of the state the holds own: each is red under
 * the mutation named beside it (recorded in the todo's write-up).
 */

const TUNING = DEFAULT_INTERNAL.tuning;

const walkerOn = useRigs();

describe('the order Walker asks the holds in', () => {
  // Mutant: health asked before the rest.
  it('stands still for a rest on the wire before the health that asked for it', () => {
    const tired = hurt(at(1, 1), 10);
    const { walker, sent, notices } = walkerOn(
      { restInFlight: () => true, stateNow: () => tired },
      configWith({ health: { restBelow: 0.5 } })
    );
    walker.start(ROUTE, tired);

    expect(sent).toEqual([]);
    expect(walker.progress.hold).toBe('resting');
    expect(notices).toContain(t('automation.walk.restHolding'));
  });

  // Mutant: the affliction asked before the health.
  it('stands still for the health before a stated blindness', () => {
    const blindAndHurt = hurt(at(1, 1, { afflictions: { ...NO_AFFLICTIONS, blind: 'yes' } }), 10);
    const { walker, sent, notices } = walkerOn(
      { stateNow: () => blindAndHurt },
      configWith({ health: { restBelow: 0.5 }, movement: { walkWhileBlind: false } })
    );
    walker.start(ROUTE, blindAndHurt);

    expect(sent).toEqual([]);
    expect(walker.progress.hold).toBe('health');
    expect(notices).not.toContain(t('automation.walk.holdingBlind'));
  });

  // Mutant: the trap asked before the affliction.
  it('stands still for a stated blindness before the trap ahead', () => {
    const trapped = routeOf(
      stepOf(1, 2, 'e', { requirement: { kind: 'trap', raw: 'Trap, 36 damage', damage: 36 } })
    );
    const blind = hurt(at(1, 1, { afflictions: { ...NO_AFFLICTIONS, blind: 'yes' } }), 40, 165);
    const { walker, sent, notices } = walkerOn(
      { stateNow: () => blind },
      configWith({
        health: { restBelow: 0, restBeforeTraps: 0.45 },
        movement: { walkWhileBlind: false }
      })
    );
    walker.start(trapped, blind);

    expect(sent).toEqual([]);
    expect(walker.progress.hold).toBe('blind');
    expect(notices).toContain(t('automation.walk.holdingBlind'));
  });

  // Mutant: the draw's `rm` asked after the fight hold.
  it('asks where a draw landed before it holds for the fight it landed in', () => {
    const landing = { spell: 596, name: 'asylum', map: 9, low: 10, high: 12 };
    const drawn = routeOf(
      stepOf(1, 99, 'w', {
        to: '9/99',
        requirement: {
          kind: 'cast',
          raw: 'Cast: pre-0, post-596',
          castPost: 596,
          spellEffect: 'scatters',
          landing
        },
        scatter: { landing, rooms: 3, moves: 1 }
      })
    );
    let asked = 0;
    const { walker } = walkerOn({ locate: () => (asked += 1), willFight: () => true });
    walker.start(drawn, at(1, 1));
    walker.onCharacter(at(null, null, { inCombat: true }));

    expect(asked).toBe(1);
    expect(walker.progress.hold).toBe('fight');
  });

  // Mutant: the dark hold released only once off the room the step left.
  it('lets the dark hold go the moment the room can be read, even the one it left', () => {
    const { walker, notices } = walkerOn({ lightComing: () => true });
    walker.start(ROUTE, at(1, 1));
    const dark = at(null, null);
    dark.room.light = 'pitch black';
    walker.onCharacter(dark);
    // Positive control: the dark hold was taken.
    expect(walker.progress.hold).toBe('dark');

    walker.onCharacter(at(1, 1));
    expect(walker.progress.hold).toBeNull();
    expect(notices).toContain(t('automation.walk.lightResumed'));
  });

  // Mutant: the exemption that expired on landing asked after the holds.
  it('answers the fight a landing still stands in before the health it left', () => {
    let fights = false;
    const { walker } = walkerOn(
      { willFight: () => fights },
      configWith({ health: { restBelow: 0.5 } })
    );
    // Asked for mid-fight with nothing that will end it: the walk leaves.
    walker.start(ROUTE, at(1, 1, { inCombat: true }));
    fights = true;
    walker.onCharacter(hurt(at(1, 2, { inCombat: true }), 10));

    expect(walker.progress.hold).toBe('fight');
  });

  // Mutant: the landing keeps the exemption.
  it('does not walk on through a fight the landing ended the exemption for', () => {
    let fights = false;
    const { walker, sent } = walkerOn({ willFight: () => fights });
    walker.start(ROUTE, at(1, 1, { inCombat: true }));
    expect(moves(sent)).toEqual(['e']);
    fights = true;
    walker.onCharacter(at(1, 2, { inCombat: true }));
    expect(walker.progress.hold).toBe('fight');

    // The fight goes on: the walk holds, it does not step into it.
    walker.onCharacter(at(1, 2, { inCombat: true }));
    vi.advanceTimersByTime(TUNING.walk.holdMs + 100);
    expect(moves(sent)).toEqual(['e']);
    expect(walker.progress.hold).toBe('fight');
  });
});

describe('the onset the holds read', () => {
  // Mutant: an onset read with no step of the walk's on the wire.
  it('reads an onset only while its own step is out', () => {
    let quarry = true;
    const here = at(1, 1);
    const { walker, sent, notices } = walkerOn({
      holdAt: () => quarry,
      spellsHold: () => null,
      stateNow: () => here
    });
    walker.start(ROUTE, here);
    expect(sent).toEqual([]);
    walker.onBlock(wire('spell-onset', { spells: 'unnamed' }));
    vi.advanceTimersByTime(TUNING.walk.holdMs);
    expect(walker.progress.hold).toBeNull();
    expect(notices).not.toContain(t('automation.walk.holdingHeld'));

    // Positive control: the same onset behind a step that goes unanswered holds.
    quarry = false;
    vi.advanceTimersByTime(TUNING.walk.holdMs * TUNING.walk.maxHolds);
    expect(moves(sent)).toEqual(['e']);
    walker.onBlock(wire('spell-onset', { spells: 'unnamed' }));
    vi.advanceTimersByTime(TUNING.walk.nudgeAfterMs + CONFIG.walk.stepTimeoutMs + 100);
    expect(walker.progress.hold).toBe('held');
  });

  // Mutant: a send keeps the last attempt's onset.
  it('forgets an onset when the step goes out again behind a door', () => {
    const here = at(1, 1);
    const { walker, sent } = walkerOn(
      { spellsHold: () => null, stateNow: () => here },
      configWith({ movement: { openDoors: true, openTries: 1 } })
    );
    walker.start(ROUTE, here);
    walker.onBlock(wire('spell-onset', { spells: 'unnamed' }));
    walker.onBlock(wire('direction-failed', { barrier: 'door' }));
    vi.advanceTimersByTime(200);
    walker.onBlock(wire('door-changed', { barrier: 'door', state: 'open' }));
    vi.advanceTimersByTime(200);
    expect(moves(sent)).toEqual(['e', 'open e', 'e']);

    // Nothing answers the step sent again: that is a lost step, not a hold.
    vi.advanceTimersByTime(TUNING.walk.nudgeAfterMs + CONFIG.walk.stepTimeoutMs + 100);
    expect(walker.progress.status).toBe('stopped');
    expect(walker.progress.reason).toBe(t('automation.walk.reasonTimeout', { command: 'e' }));
  });

  // Mutant: a new walk keeps the last walk's onset.
  it('does not carry an onset into the next walk', () => {
    const here = at(1, 1);
    const { walker, sent } = walkerOn({ spellsHold: () => null, stateNow: () => here });
    walker.start(ROUTE, here);
    walker.onBlock(wire('spell-onset', { spells: 'unnamed' }));
    walker.stop('asked to');
    vi.advanceTimersByTime(CONFIG.pacing.ackTimeoutMs + 100);

    walker.start(ROUTE, here);
    expect(walker.progress.hold).toBeNull();
    expect(moves(sent)).toEqual(['e', 'e']);
  });
});

describe('an escape', () => {
  // Mutant: an escape noted on a walk that is not walking.
  it('takes nothing from a walker that is not walking', () => {
    const { walker, progress } = walkerOn();
    walker.start(ROUTE, at(1, 1));
    walker.stop('asked to');
    const published = progress.length;
    walker.noteEscaped();
    expect(progress).toHaveLength(published);

    // Positive control: noted while walking, the fight hold takes the walk.
    vi.advanceTimersByTime(CONFIG.pacing.ackTimeoutMs + 100);
    walker.start(ROUTE, at(1, 1));
    walker.noteEscaped();
    expect(walker.progress.hold).toBe('fight');
  });
});

describe('Holds, put down', () => {
  /** A walk that records what the holds asked of it, and nothing else. */
  const walkOf = (step = ROUTE.steps[0]): HoldsWalk & { carried: number } => {
    const walk = {
      carried: 0,
      walking: () => true,
      quiet: () => true,
      step: () => step,
      publish: () => {},
      stop: () => {},
      retryAfter: () => {},
      recheck: () => {},
      carryOn: () => {
        walk.carried += 1;
      },
      onward: () => {},
      cancelQueued: () => {}
    };
    return walk;
  };

  let clock: WalkClock;
  beforeEach(() => {
    clock = new WalkClock();
  });
  afterEach(() => clock.dispose());

  // Mutant: reset keeps the slot.
  it('lets the slot go', () => {
    const holds = new Holds(CONFIG, {}, walkOf(), clock);
    holds.noteEscaped();
    expect(holds.current).toBe('fight');
    holds.reset();
    expect(holds.current).toBeNull();
  });

  // Mutant: reset keeps the last walk's options.
  it('gives the next walk the options a route the player asked for has', () => {
    const holds = new Holds(configWith({ health: { restBelow: 0.5 } }), {}, walkOf(), clock);
    holds.begin({ holdWhenHurt: false, resumeAfterFight: false }, false);
    holds.reset();
    // A walk that resumes after a fight is held by an escape…
    holds.noteEscaped();
    expect(holds.current).toBe('fight');
    // …and one that holds when hurt is held by the health.
    holds.take(null);
    expect(holds.holdForHealth(hurt(at(1, 1), 10))).toBe(true);
  });

  // Mutant: the release asks a hand-written list that omits one condition.
  it.each(AFFLICTION_HOLDS)('holds for a stated %s and lets the slot go when it passes', (kind) => {
    const holds = new Holds(CONFIG, {}, walkOf(), clock);
    expect(
      holds.holdForAffliction(at(1, 1, { afflictions: { ...NO_AFFLICTIONS, [kind]: 'yes' } }))
    ).toBe(true);
    expect(holds.current).toBe(kind);
    expect(
      holds.holdForAffliction(at(1, 1, { afflictions: { ...NO_AFFLICTIONS, [kind]: 'no' } }))
    ).toBe(false);
    expect(holds.current).toBeNull();
  });

  // Mutant: reset keeps the escape.
  it('forgets an escape the last walk ran', () => {
    const walk = walkOf();
    const holds = new Holds(CONFIG, { willFight: () => true }, walk, clock);
    holds.noteEscaped();
    holds.reset();
    // A fight auto-combat is fighting takes the slot, and is over where it began.
    expect(holds.answerFight()).toBe(true);
    holds.resumeFromFight(at(1, 1));
    expect(walk.carried).toBe(1);
  });
});

/*
 * Todo 765 (on review): the floor hold remembers it stands still for the read,
 * so the read's close wakes it. A step that has gone out since means nothing
 * stands still any more, and a wake then would send it a second time.
 */
describe('the floor read waking the walk', () => {
  it('wakes a walk held for the read, and nothing once a step has gone out', () => {
    let reading = true;
    const retryAfter = vi.fn();
    const walk: HoldsWalk = {
      walking: () => true,
      quiet: () => false,
      step: () => undefined,
      publish: () => undefined,
      stop: () => undefined,
      retryAfter,
      recheck: () => undefined,
      carryOn: () => undefined,
      onward: () => undefined,
      cancelQueued: () => undefined
    };
    const clock = new WalkClock();
    const holds = new Holds(
      CONFIG,
      { floorInFlight: () => reading, stateNow: () => at(1, 1) },
      walk,
      clock
    );

    // Held, and the close wakes it now.
    expect(holds.holdForFloor(at(1, 1))).toBe(true);
    retryAfter.mockClear();
    reading = false;
    holds.afterBlock();
    expect(retryAfter).toHaveBeenCalledWith(0, expect.anything());

    // Held, then a step out: the close wakes nothing.
    reading = true;
    holds.holdForFloor(at(1, 1));
    retryAfter.mockClear();
    holds.sent();
    reading = false;
    holds.afterBlock();
    expect(retryAfter).not.toHaveBeenCalled();
    clock.dispose();
  });
});
