import { beforeEach, describe, expect, it } from 'vitest';

import { AutoHunt, type HuntPlanner } from '../AutoHunt';
import { DEFAULT_CONFIG, type HuntingAutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { SafetyDecision } from '../../../shared/automation';
import type { HuntingAdvice, HuntingSpot, SpotEstimate } from '../../../shared/hunting';
import type { Loop } from '../../../shared/loops';
import type { Route } from '../../../shared/world';

const config = (over: Partial<HuntingAutomationConfig> = {}): HuntingAutomationConfig => ({
  ...DEFAULT_CONFIG.automation.hunting,
  enabled: true,
  ...over
});

/** In the realm, whole, with nothing swinging at it. */
function ready(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    room: { ...base.room, map: 1, number: 1, name: 'Town Gates' },
    progress: { ...base.progress, level: 12 },
    vitals: { ...base.vitals, hp: 200, hpMax: 200 },
    ...over
  };
}

const estimate = (expPerHour: number | null): SpotEstimate =>
  ({
    expPerHour,
    deadly: false,
    costly: false,
    trivial: false,
    unknown: []
  }) as unknown as SpotEstimate;

const spot = (key: string, rate: number | null, room = 'Graveyard', at = 816): HuntingSpot => {
  const where = { id: `1/${at}`, map: 1, room: at, name: room, steps: 4 };
  return {
    key,
    mobs: [{ name: 'fierce zombie', experience: 70 }],
    clock: 'delay',
    boss: false,
    respawnSeconds: 60,
    spawns: 2,
    rooms: [where],
    filler: [],
    walk: [where],
    roomCount: 2,
    loopSteps: 2,
    estimate: estimate(rate)
  } as unknown as HuntingSpot;
};

const advice = (spots: HuntingSpot[], refusal: string | null = null): HuntingAdvice =>
  ({ from: { id: '1/1', name: 'Town Gates' }, spots, refusal }) as unknown as HuntingAdvice;

const ROUTE: Route = {
  steps: [{ from: '1/1', to: '1/816' }] as unknown as Route['steps'],
  cost: 1,
  blocked: false
} as Route;

let notices: string[];
let decisions: SafetyDecision[];
let walked: Route[];
let started: Loop[];
let surveys: number;
let answer: HuntingAdvice;
let here: string | null;
/** The name of the lap the fake planner has running, as main answers it. */
let running: string | null;
/** Every reason a lap was stopped with. */
let stops: string[];
let clock: number;

function hunt(over: Partial<HuntPlanner> = {}, over2: Partial<HuntingAutomationConfig> = {}) {
  const planner: HuntPlanner = {
    here: () => here,
    survey: () => {
      surveys += 1;
      return answer;
    },
    routeTo: () => ROUTE,
    walk: (route) => {
      walked.push(route);
      return null;
    },
    runLoop: (loop) => {
      started.push(loop);
      running = loop.name;
      return null;
    },
    runningLoop: () => running,
    stopLoop: (reason) => {
      stops.push(reason);
      running = null;
    },
    moveInFlight: () => false,
    walking: () => false,
    busy: () => false,
    ...over
  };
  return new AutoHunt(
    config(over2),
    DEFAULT_CONFIG.automation.walk,
    DEFAULT_CONFIG.automation.health,
    true,
    planner,
    { notice: (message) => notices.push(message), decided: (d) => decisions.push(d) },
    () => clock
  );
}

beforeEach(() => {
  notices = [];
  decisions = [];
  walked = [];
  started = [];
  surveys = 0;
  here = '1/1';
  running = null;
  stops = [];
  clock = 1_000_000;
  answer = advice([spot('lair:a', 12_000)]);
});

describe('going hunting on its own', () => {
  it('walks to the best spot and runs its loop', () => {
    const auto = hunt();
    auto.onCharacter(ready());
    expect(walked).toHaveLength(1);
    // Nothing is looping yet: the loop starts where the walk ends.
    expect(started).toHaveLength(0);

    here = '1/816';
    auto.onWalkEnded(true, null, ready());
    expect(started).toHaveLength(1);
    expect(started[0]!.name).toContain('Graveyard');
    expect(decisions.at(-1)).toMatchObject({ action: 'hunt', acted: true });
  });

  /* The loop is built from the survey, never filed: a lair that stops being
     worth walking must not be left on a shelf under a name promising it is. */
  it('runs the loop where the character already stands', () => {
    here = '1/816';
    const auto = hunt();
    auto.onCharacter(ready());
    expect(walked).toHaveLength(0);
    expect(started).toHaveLength(1);
  });

  /*
   * Off by default and refusing loudly are both settled rules; this is the
   * half that says a refusal is traced as well as said.
   */
  it('refuses out loud when nothing within reach has a rate', () => {
    answer = advice([spot('lair:a', null)]);
    const auto = hunt();
    auto.onCharacter(ready());
    expect(walked).toHaveLength(0);
    expect(decisions.at(-1)).toMatchObject({ action: 'hunt', acted: false });
    expect(notices.some((line) => line.length > 0)).toBe(true);
  });

  /* And one situation is said once, not once per status line. */
  it('says a refusal once', () => {
    answer = advice([]);
    const auto = hunt();
    auto.onCharacter(ready());
    clock += 120_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 13 } }));
    expect(notices).toHaveLength(1);
  });

  /*
   * Nothing else may have the character: the module yields to a fight, a lap,
   * a walk and an escape, which is every errand's rule here.
   */
  it('yields to a fight', () => {
    const auto = hunt();
    auto.onCharacter(ready({ inCombat: true }));
    expect(surveys).toBe(0);
  });

  it('yields to a lap already running', () => {
    running = 'somebody else’s lap';
    const auto = hunt();
    auto.onCharacter(ready());
    expect(surveys).toBe(0);
  });

  /* Too hurt to travel: `automation.health.restBelow` is the floor a route
     already holds at, read here so the journey is never started at 12%. */
  it('does not set off hurt', () => {
    const auto = hunt();
    auto.onCharacter(ready({ vitals: { ...EMPTY_CHARACTER.vitals, hp: 20, hpMax: 200 } }));
    expect(surveys).toBe(0);
  });

  /*
   * A settled answer is re-opened by a level, the kit, or the lap stopping for
   * earning too little — and by nothing else, because a sweep prices every
   * lair the exits reach and a status line arrives every few seconds.
   */
  it('surveys once for an unchanged character', () => {
    const auto = hunt();
    auto.onCharacter(ready());
    clock += 600_000;
    auto.onCharacter(ready());
    auto.onCharacter(ready());
    expect(surveys).toBe(1);
  });

  it('asks again when the character levels, and moves if the answer changed', () => {
    const auto = hunt();
    auto.onCharacter(ready());
    here = '1/816';
    auto.onWalkEnded(true, null, ready());
    expect(started).toHaveLength(1);

    answer = advice([spot('lair:b', 30_000, 'Sewer', 920)]);
    clock += 120_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 13 } }));
    expect(walked).toHaveLength(2);
    expect(notices.some((line) => line.includes('30,000'))).toBe(true);
  });

  /*
   * A stop the player pressed stands the hunt down: starting it again on the
   * next status line would make the stop button do nothing.
   */
  it('stands down when the player stops the lap', () => {
    const auto = hunt();
    auto.onCharacter(ready());
    here = '1/816';
    auto.onWalkEnded(true, null, ready());

    auto.noteStopped();
    running = null;
    clock += 600_000;
    auto.onCharacter(ready());
    expect(started).toHaveLength(1);
    expect(walked).toHaveLength(1);
  });

  /*
   * Todo 06 — keeping a running lap honest. The three things that can make a
   * settled answer wrong: company in the lair, the character changing, and
   * what the lair actually pays.
   */

  /** A lap running at the Graveyard, having been walked to and started. */
  function hunting(): AutoHunt {
    const auto = hunt();
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    auto.onCharacter(at);
    here = '1/816';
    // The experience figure at the moment the lap starts is the measurement's
    // anchor, so the arrival carries it.
    auto.onWalkEnded(true, null, at);
    return auto;
  }

  /*
   * Experience divides among everybody who hit the kill, so a stranger halves
   * what the lair pays. Said once, not once per status line.
   */
  it('says so once when somebody else is working the lair', () => {
    const auto = hunting();
    const withKilla = ready({
      room: {
        ...EMPTY_CHARACTER.room,
        map: 1,
        number: 816,
        occupants: [{ name: 'Killa', kind: 'player', disposition: null, uncertain: false }]
      }
    } as Partial<CharacterState>);
    auto.onCharacter(withKilla);
    auto.onCharacter(withKilla);
    expect(notices.filter((line) => line.includes('Killa'))).toHaveLength(1);
  });

  /* A party member is the arrangement, not the problem. */
  it('says nothing about a party member in the lair', () => {
    const auto = hunting();
    auto.onCharacter(
      ready({
        party: { ...EMPTY_CHARACTER.party, members: [{ name: 'Soul' }] },
        room: {
          ...EMPTY_CHARACTER.room,
          map: 1,
          number: 816,
          occupants: [{ name: 'Soul', kind: 'player', disposition: null, uncertain: false }]
        }
      } as Partial<CharacterState>)
    );
    expect(notices.some((line) => line.includes('Soul'))).toBe(false);
  });

  /*
   * What the lair actually pays outranks what the model said it would, and a
   * move needs a margin and a grace over it.
   */
  it('moves on when the lair pays less than another is worth', () => {
    const auto = hunting();
    // A whole grace later, 500 experience richer: 2,000 an hour against the
    // 12,000 the survey promised, and the alternative is worth 30,000.
    answer = advice([spot('lair:a', 12_000), spot('lair:b', 30_000, 'Sewer', 920)]);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_500 } }));
    expect(walked).toHaveLength(2);
    expect(notices.some((line) => line.includes('2,000'))).toBe(true);
    expect(decisions.at(-1)).toMatchObject({ action: 'hunt', acted: true });
  });

  /* And it stays put where the alternative is within the margin. */
  it('stays where the difference is inside the margin', () => {
    const auto = hunting();
    answer = advice([spot('lair:a', 12_000), spot('lair:b', 11_000, 'Sewer', 920)]);
    clock += 900_000;
    // 10,000 an hour measured; the alternative's 11,000 is under the quarter
    // this client asks for before it walks anywhere.
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 3_500 } }));
    expect(walked).toHaveLength(1);
  });

  /*
   * One movement at a time at every door. `Walker.start` supersedes a leg
   * silently and raises no `ended`, so a lap left running while the character
   * walks somewhere else waits for a leg that never comes and then reads the
   * journey's arrival as its own (on review).
   */
  it('stops the lap before it walks anywhere else', () => {
    const auto = hunting();
    answer = advice([spot('lair:a', 12_000), spot('lair:b', 30_000, 'Sewer', 920)]);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_500 } }));
    expect(stops).toHaveLength(1);
    expect(walked).toHaveLength(2);
  });

  /* And a journey is a journey: the guards that stop one starting stop one
     moving on, which they did not while the hunting branch returned first. */
  it('does not move on out of a fight, or hurt', () => {
    const auto = hunting();
    answer = advice([spot('lair:a', 12_000), spot('lair:b', 30_000, 'Sewer', 920)]);
    clock += 900_000;
    auto.onCharacter(
      ready({ inCombat: true, progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_500 } })
    );
    expect(walked).toHaveLength(1);

    auto.onCharacter(
      ready({
        vitals: { ...EMPTY_CHARACTER.vitals, hp: 20, hpMax: 200 },
        progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_500 }
      })
    );
    expect(walked).toHaveLength(1);
  });

  /*
   * A lap the player starts from the palette is not this module's to reason
   * about: measuring it against the hunt's own prediction would relocate the
   * character off the lap they just chose.
   */
  it('lets go of a hunt when the player starts a lap of their own', () => {
    const auto = hunting();
    running = 'a lap of my own';
    answer = advice([spot('lair:b', 30_000, 'Sewer', 920)]);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_500 } }));
    expect(stops).toHaveLength(0);
    expect(walked).toHaveLength(1);
  });

  /* The walk that never arrived is a refusal, not a loop started somewhere
     the character is not standing. */
  it('does not start the loop when the walk stopped short', () => {
    const auto = hunt();
    auto.onCharacter(ready());
    auto.onWalkEnded(false, 'a fight', ready());
    expect(started).toHaveLength(0);
    expect(decisions.at(-1)).toMatchObject({ acted: false });
  });
});
