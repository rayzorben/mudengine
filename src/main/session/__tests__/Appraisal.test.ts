import { describe, expect, it, vi } from 'vitest';

import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { FightSimulator } from '../../../shared/simulator';
import type { Survival } from '../../../shared/survival';
import { Appraisal, type AppraisalParts } from '../Appraisal';

// The arithmetic is `verdict.test.ts`'s; this is when the room's fight is run and what is drawn meanwhile.
vi.mock('../../../shared/verdict', async (actual) => ({
  ...(await actual<typeof import('../../../shared/verdict')>()),
  appraiseRoom: () => ({ monsters: [], cost: null }),
  prowessSheetOf: () => ({}),
  wieldedWeapon: () => null
}));

const survival = (survives: number) => ({ survives }) as unknown as Survival;

/** A simulator that answers only when told, as a worker answers a moment later. */
function heldSimulator() {
  const runs: Array<{ input: unknown; done: (s: Survival | null) => void; dropped: boolean }> = [];
  const simulator: FightSimulator = {
    run: (input, done) => {
      const run = { input, done, dropped: false };
      runs.push(run);
      return () => {
        run.dropped = true;
      };
    }
  };
  return { simulator, runs };
}

function appraisalOf(simulator: FightSimulator) {
  const base = structuredClone(EMPTY_CHARACTER);
  const tracker = { current: base as CharacterState };
  const ran = vi.fn();
  const parts = {
    tracker,
    world: undefined,
    errands: { realmClass: () => ({}), menacePlayer: () => null },
    // The input carries the health, so a blow is a new fight to run.
    setup: {
      character: (state: CharacterState) => ({ hp: state.vitals.hp }),
      foes: (_s: unknown, _c: unknown, met: Array<{ name: string }>) => ({ foes: met })
    },
    odds: { mob: () => undefined },
    simulator
  } as unknown as AppraisalParts;
  const appraisal = new Appraisal(parts, {
    config: () => ({ combat: { mobRules: [] } }) as never,
    watched: () => ({}) as never,
    ran
  });
  const stand = (hp: number, foe = 'orc') => {
    tracker.current = {
      ...base,
      phase: 'in-game',
      vitals: { ...base.vitals, hp },
      room: {
        ...base.room,
        map: 1,
        number: 2,
        occupants: [{ name: foe, kind: 'mob' } as CharacterState['room']['occupants'][number]]
      }
    };
  };
  return { appraisal, ran, stand };
}

describe("the room's fight, run by the simulator", () => {
  it('is drawn once it comes back, and the verdict is read again then', () => {
    const { simulator, runs } = heldSimulator();
    const { appraisal, ran, stand } = appraisalOf(simulator);
    stand(50);
    expect(appraisal.verdict.survival).toBeNull();
    expect(runs).toHaveLength(1);
    runs[0]!.done(survival(0.8));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(appraisal.verdict).toMatchObject({ survival: survival(0.8), survivalNow: true });
    // A status line that moves nothing it was run on runs nothing.
    expect(runs).toHaveLength(1);
  });

  it('draws the last answer for the same foes as last known, one run out at a time', () => {
    const { simulator, runs } = heldSimulator();
    const { appraisal, stand } = appraisalOf(simulator);
    stand(50);
    void appraisal.verdict;
    runs[0]!.done(survival(0.8));
    stand(40);
    expect(appraisal.verdict).toMatchObject({ survival: survival(0.8), survivalNow: false });
    // The run for 40 is still out: the newest state waits behind it, the ones between are skipped.
    stand(35);
    void appraisal.verdict;
    stand(30);
    void appraisal.verdict;
    expect(runs).toHaveLength(2);
    runs[1]!.done(survival(0.6));
    expect(runs).toHaveLength(3);
    expect(appraisal.verdict).toMatchObject({ survival: survival(0.6), survivalNow: false });
    runs[2]!.done(survival(0.5));
    expect(appraisal.verdict).toMatchObject({ survival: survival(0.5), survivalNow: true });
    expect(runs.some((run) => run.dropped)).toBe(false);
  });

  it('draws nothing from a fight against other foes, and ignores a run the dial dropped', () => {
    const { simulator, runs } = heldSimulator();
    const { appraisal, ran, stand } = appraisalOf(simulator);
    stand(50);
    void appraisal.verdict;
    runs[0]!.done(survival(0.8));
    stand(50, 'troll');
    expect(appraisal.verdict.survival).toBeNull();
    appraisal.reset();
    expect(runs[1]!.dropped).toBe(true);
    runs[1]!.done(survival(0.1));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(appraisal.verdict.survival).toBeNull();
    appraisal.dispose();
    expect(runs[2]!.dropped).toBe(true);
  });
});
