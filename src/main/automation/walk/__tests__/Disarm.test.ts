import { describe, expect, it, vi } from 'vitest';

import { t } from '../../../app/i18n';
import { DEFAULT_INTERNAL } from '../../../../shared/internal';
import { disarmOdds, disarmTries, disarmWorth, trapHurt } from '../../../../shared/walk';
import type { CharacterState, PartyMember } from '../../../../shared/character';
import { DisarmBeforeStep } from '../Disarm';
import { PartyHands } from '../PartyHands';
import { at, moves, routeOf, settle, stepOf, useRigs, wire } from './walking';

const TUNING = DEFAULT_INTERNAL.tuning;

/*
 * Todo 53, from `TrapExit.TryDisarm` (source): success when
 * `Traps >= rand(1,100)`, and a failure fires the trap for its full damage.
 */
describe('the disarm arithmetic', () => {
  it('reads the sheet as a percentage, unknown as unknown', () => {
    expect(disarmOdds(null)).toBeNull();
    expect(disarmOdds(0)).toBe(0);
    expect(disarmOdds(176)).toBe(1);
  });

  it('disarms alone above 50 Traps, and lower the more walk behind', () => {
    expect(disarmWorth(0.5, 1)).toBe(false);
    expect(disarmWorth(0.51, 1)).toBe(true);
    expect(disarmWorth(0.3, 3)).toBe(true);
    expect(disarmWorth(0.2, 3)).toBe(false);
    expect(disarmWorth(null, 4)).toBe(false);
  });

  it('prices a trap at the failed disarms where that costs less', () => {
    expect(trapHurt(400, 0.75)).toBe(133);
    expect(trapHurt(400, 0.4)).toBe(400);
    expect(trapHurt(400, null)).toBe(400);
    expect(trapHurt(null, 0.9)).toBeNull();
  });

  it('gives up where the run of failures is under the doubt', () => {
    expect(disarmTries(0.75, 0.01)).toBe(4);
    expect(disarmTries(1, 0.01)).toBe(1);
  });
});

const rigOn = useRigs();

/** One step east through a 36-damage trap, on a character with `traps`. */
const TRAPPED = routeOf(
  stepOf(1, 2, 'e', {
    name: 'Second Room',
    requirement: { kind: 'trap', raw: 'Trap, 36 damage', damage: 36 }
  })
);
const thief = (traps: number | null, over: Partial<CharacterState> = {}): CharacterState => {
  const state = at(1, 1, over);
  state.progress = { ...state.progress, traps };
  state.vitals = { ...state.vitals, hp: 165, hpMax: 165 };
  return state;
};
const member = (name: string): PartyMember => ({ name }) as PartyMember;

describe('disarming before a trapped step', () => {
  it('sends disarm trap, then the step once the trap is disarmed', async () => {
    const now = thief(75);
    const { walker, sent, notices } = rigOn({ stateNow: () => now });
    walker.start(TRAPPED, now);
    await vi.advanceTimersByTimeAsync(50);
    expect(moves(sent)).toEqual(['disarm trap e']);
    walker.onBlock(wire('trap-disarmed', { direction: 'east' }));
    settle();
    await vi.advanceTimersByTimeAsync(50);
    expect(moves(sent)).toEqual(['disarm trap e', 'e']);
    expect(notices).toContain(t('automation.walk.trapDisarmed', { stepName: 'Second Room' }));
  });

  it('tries again after a failure, through the trap hold', async () => {
    const now = thief(75);
    const { walker, sent } = rigOn({ stateNow: () => now });
    walker.start(TRAPPED, now);
    await vi.advanceTimersByTimeAsync(50);
    expect(moves(sent)).toEqual(['disarm trap e']);
    // No success line by the deadline: the trap fired, and the next try goes.
    settle();
    await vi.advanceTimersByTimeAsync(TUNING.walk.disarmAnswerMs + TUNING.walk.holdMs);
    expect(moves(sent).filter((c) => c === 'disarm trap e').length).toBeGreaterThanOrEqual(2);
    expect(moves(sent)).not.toContain('e');
  });

  /* The positive control is the test above: the same route at 75 sends it. */
  it('walks straight in at 40 Traps alone, and with no Traps read', async () => {
    for (const traps of [40, null]) {
      const now = thief(traps);
      const { walker, sent } = rigOn({ stateNow: () => now });
      walker.start(TRAPPED, now);
      await vi.advanceTimersByTimeAsync(50);
      expect(moves(sent)).toEqual(['e']);
    }
  });

  it('disarms at 40 Traps leading two, who would walk it too', async () => {
    const now = thief(40, {
      name: 'Rayzor',
      party: {
        following: null,
        members: [member('Rayzor'), member('Festus'), member('Baby')],
        engaged: {},
        threatened: {}
      }
    });
    const { walker, sent } = rigOn({ stateNow: () => now });
    walker.start(TRAPPED, now);
    await vi.advanceTimersByTimeAsync(50);
    expect(moves(sent)).toEqual(['disarm trap e']);
  });

  it('gives up after the run the odds make unlikely, and walks in', async () => {
    const now = thief(99);
    const { walker, sent, notices } = rigOn({ stateNow: () => now });
    walker.start(TRAPPED, now);
    const limit = disarmTries(0.99, TUNING.walk.disarmDoubt);
    for (let i = 0; i < limit + 1; i += 1) {
      settle();
      await vi.advanceTimersByTimeAsync(TUNING.walk.disarmAnswerMs + TUNING.walk.holdMs);
    }
    expect(moves(sent).filter((c) => c === 'disarm trap e')).toHaveLength(limit);
    expect(moves(sent)).toContain('e');
    expect(notices).toContain(
      t('automation.walk.disarmGaveUp', { stepName: 'Second Room', count: limit })
    );
  });
});

/** `DisarmBeforeStep` alone, over fakes of its ports and a hand-set clock; `asked` is each `askHand`. */
function unit(step = TRAPPED.steps[0]!) {
  const offers: string[] = [];
  const notices: string[] = [];
  const asked: string[] = [];
  const stepped = vi.fn();
  const timers: (() => void)[] = [];
  const clock = { now: 0, queued: false };
  const events = {
    notice: (message: string) => void notices.push(message),
    askHand: (name: string, job: string, direction: string) =>
      asked.push(`${name} ${job} ${direction}`) > 0
  };
  const walkClock = {
    afterStep: (_ms: number, then: () => void) => void timers.push(then),
    clear: () => void timers.splice(0)
  };
  const inFlight = {
    walking: () => true,
    quiet: () => false,
    step: () => step,
    stepWhenFree: stepped
  };
  const hands = new PartyHands(events, inFlight, walkClock, () => clock.now);
  const disarm = new DisarmBeforeStep(
    {
      offer: (intent) => {
        offers.push(intent.command);
        return 'queued';
      },
      queued: () => clock.queued
    },
    events,
    inFlight,
    walkClock,
    hands,
    () => clock.now
  );
  return { disarm, hands, offers, notices, asked, stepped, timers, clock, step };
}

/** Leading Rand, standing here with `traps` on the sheet his client answered. */
const leadingRand = (own: number | null, traps: number | null): CharacterState =>
  thief(own, {
    name: 'Rayzor',
    room: { ...at(1, 1).room, occupants: [{ name: 'Rand' } as never] },
    party: {
      following: null,
      members: [
        member('Rayzor'),
        {
          ...member('Rand'),
          vitals: { hp: 300, hpMax: 300, mana: null, manaMax: null },
          sheet: { strength: 50, level: 10, traps, picklocks: null }
        }
      ],
      engaged: {},
      threatened: {}
    }
  });

/* Todo 86: leading, the best hand at the trap goes, and a failure asks the next. */
describe('sending a party member at a trap', () => {
  it('sends @disarm to the member with the better odds, and holds the way on their {ok}', () => {
    const { disarm, hands, asked, offers, stepped, step } = unit();
    expect(disarm.ask(leadingRand(40, 90))).toBe(true);
    expect(asked).toEqual(['Rand disarm e']);
    expect(offers).toEqual([]);
    hands.answered('Rand', 'held');
    expect(stepped).toHaveBeenCalledTimes(1);
    expect(disarm.disarmed(step)).toBe(true);
  });

  it('disarms itself once the member answers {failed}', () => {
    const { disarm, hands, asked, offers } = unit();
    expect(disarm.ask(leadingRand(40, 90))).toBe(true);
    hands.answered('Rand', 'failed');
    expect(disarm.ask(leadingRand(40, 90))).toBe(true);
    expect(asked).toEqual(['Rand disarm e']);
    expect(offers).toEqual(['disarm trap e']);
  });

  it('counts silence past the deadline as a failure, and says so', () => {
    const { disarm, notices, timers, stepped } = unit();
    disarm.ask(leadingRand(40, 90));
    timers.shift()!();
    expect(stepped).toHaveBeenCalledTimes(1);
    expect(notices.some((line) => line.includes('Rand'))).toBe(true);
  });

  /* The positive control is the first test: the same member with a sheet is asked. */
  it('never sends a member with no sheet at a trap', () => {
    const { disarm, asked, offers } = unit();
    expect(disarm.ask(leadingRand(40, null))).toBe(true);
    expect(asked).toEqual([]);
    expect(offers).toEqual(['disarm trap e']);
  });

  it('reads a member’s answer only from the one asked', () => {
    const { disarm, hands, stepped } = unit();
    disarm.ask(leadingRand(40, 90));
    hands.answered('Soul', 'held');
    expect(stepped).not.toHaveBeenCalled();
  });
});

describe('a disarm the walk did not send, and one held by a fight', () => {
  it('records a disarm the player typed and leaves the step to the walk', () => {
    const { disarm, stepped, step, clock } = unit();
    disarm.answered('east');
    expect(disarm.disarmed(step)).toBe(true);
    expect(stepped).not.toHaveBeenCalled();
    clock.now = TUNING.walk.trapRearmMs;
    expect(disarm.disarmed(step)).toBe(false);
  });

  /* `The trap is already disarmed.` says nothing of when; the server re-arms on its own clock. */
  it('takes already disarmed as safe for this send only', () => {
    const { disarm, step, stepped, clock } = unit();
    expect(disarm.ask(thief(75))).toBe(true);
    disarm.answered(undefined);
    expect(stepped).toHaveBeenCalledTimes(1);
    expect(disarm.disarmed(step)).toBe(true);
    clock.now = TUNING.walk.disarmAnswerMs;
    expect(disarm.disarmed(step)).toBe(false);
  });

  /* A fight hold clears the walk's clock; asked again, the disarm out waits again. */
  it('arms the deadline again when asked while one is out, and sends nothing more', () => {
    const { disarm, offers, timers, stepped } = unit();
    expect(disarm.ask(thief(75))).toBe(true);
    expect(offers).toEqual(['disarm trap e']);
    timers.splice(0);
    expect(disarm.ask(thief(75))).toBe(true);
    expect(offers).toEqual(['disarm trap e']);
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(stepped).toHaveBeenCalledTimes(1);
  });

  it('waits while the disarm is queued, and says so when the queue dropped it', () => {
    const { disarm, timers, stepped, notices, clock } = unit();
    clock.queued = true;
    disarm.ask(thief(75));
    timers.shift()!();
    expect(stepped).not.toHaveBeenCalled();
    clock.queued = false;
    timers.shift()!();
    expect(stepped).toHaveBeenCalledTimes(1);
    expect(notices).toContain(t('automation.walk.disarmUnsent', { stepName: 'Second Room' }));
  });
});
