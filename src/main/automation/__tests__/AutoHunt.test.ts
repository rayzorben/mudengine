import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AutoHunt, type HuntPlanner } from '../AutoHunt';
import { t } from '../../app/i18n';
import { setTuning } from '../../app/tuning';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { DEFAULT_CONFIG, type HuntingAutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { SafetyDecision } from '../../../shared/automation';
import {
  NO_EXCLUSIONS,
  huntStop,
  type HuntingAdvice,
  type HuntOrder,
  type HuntingSpot,
  type SpotEstimate
} from '../../../shared/hunting';
import { sameWalk, type Loop } from '../../../shared/loops';
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
    via: 'lair',
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

const advice = (
  spots: HuntingSpot[],
  refusal: string | null = null,
  unsimulated = 0
): HuntingAdvice =>
  ({
    from: { id: '1/1', name: 'Town Gates' },
    spots,
    refusal,
    excluded: { ...NO_EXCLUSIONS, unsimulated }
  }) as unknown as HuntingAdvice;

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
/** The lap running, as the runner holds it: its clocks are what `retimeLoop` changes. */
let lap: Loop | null;
/** Every reason a lap was stopped with. */
let stops: string[];
let clock: number;
/** Every rate the hunt measured and kept. */
let noted: Array<{ key: string; perHour: number }>;
/** The laps whose monsters the hunt asked combat to fight, null for none, in order. */
let fought: string[][];

function hunt(over: Partial<HuntPlanner> = {}, over2: Partial<HuntingAutomationConfig> = {}) {
  const planner: HuntPlanner = {
    here: () => here,
    survey: () => {
      surveys += 1;
      return answer;
    },
    routeTo: () => ROUTE,
    noteRate: (key, rate) => void noted.push({ key, perHour: rate.perHour }),
    walk: (route) => {
      walked.push(route);
      return null;
    },
    runLoop: (loop) => {
      started.push(loop);
      running = loop.name;
      lap = loop;
      return null;
    },
    runningLoop: () => running,
    stopLoop: (reason) => {
      stops.push(reason);
      running = null;
      lap = null;
    },
    retimeLoop: (loop) => {
      if (lap === null || !sameWalk(lap, loop)) return false;
      lap = { ...lap, stops: loop.stops };
      return true;
    },
    moveInFlight: () => false,
    walking: () => false,
    busy: () => false,
    fightFor: (names) => void fought.push([...names]),
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
  lap = null;
  stops = [];
  noted = [];
  fought = [];
  clock = 1_000_000;
  answer = advice([spot('lair:a', 12_000)]);
});
afterEach(() => {
  setTuning(DEFAULT_INTERNAL.tuning);
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

  /* 2026-10-04: a level 1 Mage walked past the drunken gamblers he was sent for; the realm does not say they attack first. */
  it("has the spot's monsters fought while it is hunted, and puts them down when it stops", () => {
    const auto = hunt();
    auto.onCharacter(ready());
    expect(fought).toEqual([]);
    here = '1/816';
    auto.onWalkEnded(true, null, ready());
    const mobs = answer.spots[0]!.mobs.map((mob) => mob.name);
    expect(mobs.length).toBeGreaterThan(0);
    expect(fought).toEqual([mobs]);
    auto.noteStopped();
    expect(fought).toEqual([mobs, []]);
  });

  it("puts the spot's monsters down when hunting is switched off mid-lap", () => {
    const auto = hunt();
    auto.onCharacter(ready());
    here = '1/816';
    auto.onWalkEnded(true, null, ready());
    auto.configure(
      config({ enabled: false }),
      DEFAULT_CONFIG.automation.walk,
      DEFAULT_CONFIG.automation.health,
      true
    );
    expect(fought.at(-1)).toEqual([]);
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

  /*
   * A reconnect resets every module, and the lap carries over it. Soul hunted
   * a lap the hunt no longer knew as its own for six hours (2026-10-01).
   */
  it('keeps a lap carried over a reconnect, measured from the first line back', () => {
    const auto = hunting();
    auto.reset();
    clock += 900_000;
    // The anchor is taken here, so the time offline is not counted as time earning nothing.
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_500 } }));
    expect(auto.hunting).toBe(true);
    expect(stops).toHaveLength(0);
    // Still kept honest: 2,000 an hour from there, and a better lair elsewhere.
    answer = advice([spot('lair:a', 12_000), spot('lair:b', 30_000, 'Sewer', 920)]);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 2_000 } }));
    expect(stops).toHaveLength(1);
    expect(walked).toHaveLength(2);
  });

  it('lets go after a reconnect when the lap did not carry', () => {
    const auto = hunting();
    auto.reset();
    running = null;
    // In a fight, so nothing new is set off on the same line.
    auto.onCharacter(ready({ inCombat: true }));
    expect(auto.hunting).toBe(false);
  });

  /* Todo 64: under a cash floor the spot paying it is chosen over more exp. */
  it('goes where the copper an hour is paid, under a cash floor', () => {
    const paying = (s: HuntingSpot, copper: number): HuntingSpot => ({
      ...s,
      estimate: { ...s.estimate, copperPerHour: copper }
    });
    answer = advice([
      paying(spot('lair:a', 30_000), 0),
      paying(spot('lair:b', 16_000, 'Sewer', 920), 300)
    ]);
    here = '1/920';
    const auto = hunt({}, { cashPerHour: 200 });
    auto.onCharacter(ready());
    expect(walked).toHaveLength(0);
    expect(started[0]?.name).toContain('Sewer');
  });

  /* Todo 71: copper counts only within `cashExpShare` (a half) of the best exp. */
  it('never goes for copper to a spot paying under half the best exp', () => {
    const paying = (s: HuntingSpot, copper: number): HuntingSpot => ({
      ...s,
      estimate: { ...s.estimate, copperPerHour: copper }
    });
    answer = advice([
      paying(spot('lair:a', 30_000), 0),
      paying(spot('lair:b', 12_000, 'Sewer', 920), 300)
    ]);
    const auto = hunt({}, { cashPerHour: 200 });
    auto.onCharacter(ready());
    expect(walked).toHaveLength(1);
  });

  it('takes the most exp among spots short of the floor by the same copper', () => {
    answer = advice([spot('lair:a', 12_000), spot('lair:b', 30_000, 'Sewer', 920)]);
    here = '1/920';
    const auto = hunt({}, { cashPerHour: 200 });
    auto.onCharacter(ready());
    expect(started[0]?.name).toContain('Sewer');
  });

  it('never leaves a lair paying the cash floor for more exp that does not', () => {
    const auto = hunt({}, { cashPerHour: 200 });
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    const paying = spot('lair:a', 12_000);
    answer = advice([{ ...paying, estimate: { ...paying.estimate, copperPerHour: 300 } }]);
    auto.onCharacter(at);
    here = '1/816';
    auto.onWalkEnded(true, null, at);
    answer = advice([
      { ...paying, estimate: { ...paying.estimate, copperPerHour: 300 } },
      spot('lair:b', 300_000, 'Sewer', 920)
    ]);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_500 } }));
    expect(stops).toHaveLength(0);
    expect(walked).toHaveLength(1);
  });

  it('stays, both short of the floor, where it pays more copper than more exp would', () => {
    const auto = hunt({}, { cashPerHour: 1_000 });
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    const lair = spot('lair:a', 12_000);
    const paying = { ...lair, estimate: { ...lair.estimate, copperPerHour: 300 } };
    answer = advice([paying]);
    auto.onCharacter(at);
    here = '1/816';
    auto.onWalkEnded(true, null, at);
    const rich = spot('lair:b', 300_000, 'Sewer', 920);
    answer = advice([paying, { ...rich, estimate: { ...rich.estimate, copperPerHour: 100 } }]);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_500 } }));
    expect(stops).toHaveLength(0);
  });

  it('moves off a lair short of the cash floor for one paying it, with half the exp or more', () => {
    const auto = hunt({}, { cashPerHour: 200 });
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    auto.onCharacter(at);
    here = '1/816';
    auto.onWalkEnded(true, null, at);
    const thief = spot('lair:b', 12_000, 'Sewer', 920);
    answer = advice([
      spot('lair:a', 12_000),
      { ...thief, estimate: { ...thief.estimate, copperPerHour: 300 } }
    ]);
    clock += 900_000;
    // 20,000 an hour measured here; the thieves pay 12,000 exp, over half of it.
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 6_000 } }));
    expect(stops).toHaveLength(1);
    expect(walked).toHaveLength(2);
  });

  /*
   * Todo 72: Slum Street has no clock in the database, so the survey priced
   * it on the realm's usual regen and planned no filler; once its own regen is
   * timed, the same lair is planned with a lair nearby, and the lap takes it in.
   */
  it('takes in the lairs the survey adds to fill the wait of the lair it hunts', () => {
    const auto = hunt();
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    answer = advice([spot('lair:a', 12_000)]);
    auto.onCharacter(at);
    here = '1/816';
    auto.onWalkEnded(true, null, at);
    expect(started).toHaveLength(1);
    const plain = spot('lair:a', 12_000);
    const beside = { id: '1/817', map: 1, room: 817, name: 'Alley', steps: 5 };
    answer = advice([{ ...plain, filler: [beside], walk: [...plain.walk, beside] }]);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 4_000 } }));
    expect(stops).toHaveLength(1);
    expect(started).toHaveLength(2);
    expect(started[1]?.stops).toHaveLength(2);
  });

  it('keeps a lap paying the cash floor off a filled plan that falls short of it', () => {
    const auto = hunt({}, { cashPerHour: 200 });
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    const paying = spot('lair:a', 12_000);
    answer = advice([{ ...paying, estimate: { ...paying.estimate, copperPerHour: 300 } }]);
    auto.onCharacter(at);
    here = '1/816';
    auto.onWalkEnded(true, null, at);
    const beside = { id: '1/817', map: 1, room: 817, name: 'Alley', steps: 5 };
    answer = advice([
      {
        ...paying,
        filler: [beside],
        walk: [...paying.walk, beside],
        estimate: { ...paying.estimate, copperPerHour: 100 }
      }
    ]);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 4_000 } }));
    expect(stops).toHaveLength(0);
  });

  it('moves on to a better lair before filling the one it hunts', () => {
    const auto = hunt();
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    answer = advice([spot('lair:a', 12_000)]);
    auto.onCharacter(at);
    here = '1/816';
    auto.onWalkEnded(true, null, at);
    const plain = spot('lair:a', 12_000);
    const beside = { id: '1/817', map: 1, room: 817, name: 'Alley', steps: 5 };
    answer = advice([
      { ...plain, filler: [beside], walk: [...plain.walk, beside] },
      spot('lair:b', 90_000, 'Sewer', 920)
    ]);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 4_000 } }));
    expect(stops).toHaveLength(1);
    expect(walked.at(-1)).toBeDefined();
    expect(started).toHaveLength(1);
  });

  /*
   * A correction is this level's: the survey carries a spot's measured ratio to
   * the next level itself (`withMeasured`), and one kept on top counted it twice.
   */
  it('prices a lair afresh at a new level, its correction cleared', () => {
    const level = (at: number, exp: number) =>
      ready({ progress: { ...EMPTY_CHARACTER.progress, level: at, exp } });
    const auto = hunt();
    auto.onCharacter(level(12, 1_000));
    here = '1/816';
    auto.onWalkEnded(true, null, level(12, 1_000));
    // 2,000 an hour against the 12,000 promised: a quarter, and the move to 30,000.
    answer = advice([spot('lair:a', 12_000), spot('lair:b', 30_000, 'Sewer', 920)]);
    clock += 900_000;
    auto.onCharacter(level(12, 1_500));
    expect(walked).toHaveLength(2);
    // The walk there stops short, so the next choice is made fresh.
    auto.onWalkEnded(false, null, level(12, 1_500));
    // Level 13: the survey has the first lair at 12,000 and the other at 5,000.
    answer = advice([spot('lair:a', 12_000), spot('lair:b', 5_000, 'Sewer', 920)]);
    clock += 120_000;
    notices.length = 0;
    auto.onCharacter(level(13, 1_500));
    // Still standing in it, so hunted where it stands, priced at the survey's 12,000 again.
    expect(walked).toHaveLength(2);
    expect(started).toHaveLength(2);
    expect(notices.some((line) => line.includes('12,000'))).toBe(true);
  });

  /* Todo 70: what a stay measured is kept, by spot and level, for the survey and the next session. */
  it('keeps what hunting a lair paid', () => {
    const auto = hunt();
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    auto.onCharacter(at);
    here = '1/816';
    auto.onWalkEnded(true, null, at);
    clock += 900_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 6_000 } }));
    expect(noted).toEqual([{ key: 'lair:a', perHour: 20_000 }]);
  });

  it('keeps nothing from a stay too short to say what a lair pays', () => {
    // A grace shorter than the least stay, so the least stay is what decides.
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      loop: { ...DEFAULT_INTERNAL.tuning.loop, expRateGraceMs: 60_000 }
    });
    const auto = hunt();
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    auto.onCharacter(at);
    here = '1/816';
    auto.onWalkEnded(true, null, at);
    clock += 300_000;
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 6_000 } }));
    expect(noted).toEqual([]);
  });

  it('stays on a lair short of the cash floor when the one paying it earns under half the exp', () => {
    const auto = hunt({}, { cashPerHour: 200 });
    const at = ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 1_000 } });
    auto.onCharacter(at);
    here = '1/816';
    auto.onWalkEnded(true, null, at);
    const thief = spot('lair:b', 12_000, 'Sewer', 920);
    answer = advice([
      spot('lair:a', 12_000),
      { ...thief, estimate: { ...thief.estimate, copperPerHour: 300 } }
    ]);
    clock += 900_000;
    // 36,000 an hour measured here, three times what the thieves pay in exp.
    auto.onCharacter(ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp: 10_000 } }));
    expect(stops).toHaveLength(0);
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

describe('a spot an outside plan names (todo 54)', () => {
  it('walks to the named spot even where another pays more', () => {
    answer = advice([spot('lair:a', 20_000), spot('lair:b', 5_000, 'Sewer', 900)]);
    const auto = hunt();
    auto.steer('lair:b');
    here = '1/900';
    auto.onCharacter(ready());
    expect(started).toHaveLength(1);
    expect(started[0]!.name).toContain('Sewer');
  });

  it('stops a lap it did not start, then sets off for the named spot', () => {
    answer = advice([spot('lair:b', 5_000, 'Sewer', 900)]);
    running = 'old lap';
    const auto = hunt();
    auto.steer('lair:b');
    auto.onCharacter(ready());
    expect(stops).toHaveLength(1);
    expect(auto.waiting).toBe('lap');
    here = '1/900';
    auto.onCharacter(ready());
    expect(started).toHaveLength(1);
    expect(auto.waiting).toBeNull();
  });

  it('waits on a lap the player started after the steer, and stops none', () => {
    answer = advice([spot('lair:b', 5_000, 'Sewer', 900)]);
    const auto = hunt();
    auto.steer('lair:b');
    running = 'my own lap';
    auto.onCharacter(ready());
    expect(stops).toEqual([]);
    expect(auto.waiting).toBe('lap');
  });

  it('says what holds it while steered, and nothing while not', () => {
    answer = advice([spot('lair:b', 5_000, 'Sewer', 900)]);
    const busy = hunt({ busy: () => true });
    busy.onCharacter(ready());
    expect(busy.waiting).toBeNull();
    busy.steer('lair:b');
    busy.onCharacter(ready());
    expect(busy.waiting).toBe('busy');
  });

  it('walks to the named spot where the realm states no rate for it', () => {
    answer = advice([spot('lair:b', null, 'Sewer', 900)]);
    const auto = hunt();
    auto.steer('lair:b');
    here = '1/900';
    auto.onCharacter(ready());
    expect(started).toHaveLength(1);
  });

  it('asks again when the same spot is planned again after a refusal', () => {
    answer = advice([spot('lair:b', 5_000, 'Sewer', 900)]);
    const auto = hunt();
    auto.steer('lair:gone');
    auto.onCharacter(ready());
    expect(auto.refusal).not.toBeNull();
    auto.steer('lair:gone');
    expect(auto.refusal).toBeNull();
  });

  it('hunts nowhere while the plan says so', () => {
    const auto = hunt();
    auto.steer(null);
    auto.onCharacter(ready());
    expect(walked).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  /*
   * 2026-10-01: the plan laid `kic` over `aa`, the attack is part of what every
   * fight is run on, so every lair waited on the simulator again and the spot
   * just chosen was refused as gone. It waits for its fight instead.
   */
  it('waits for the simulator when the named spot is missing while lairs are not yet run', () => {
    answer = advice([], null, 40);
    here = '1/816';
    const auto = hunt();
    auto.steer('lair:a');
    auto.onCharacter(ready());
    expect(auto.refusal).toBeNull();
    expect(auto.waiting).toBe('simulating');
    answer = advice([spot('lair:a', 5_000)]);
    auto.onCharacter(ready());
    expect(started).toHaveLength(0);
    clock += DEFAULT_INTERNAL.tuning.hunting.simulatingMs;
    auto.onCharacter(ready());
    expect(started).toHaveLength(1);
    expect(auto.waiting).toBeNull();
  });

  it('refuses the named spot once every lair is run and it is still missing, and waits again when re-steered', () => {
    answer = advice([], null, 40);
    const auto = hunt();
    auto.steer('lair:a');
    auto.onCharacter(ready());
    expect(auto.waiting).toBe('simulating');
    answer = advice([]);
    clock += DEFAULT_INTERNAL.tuning.hunting.simulatingMs;
    auto.onCharacter(ready());
    expect(auto.refusal).toBe(t('automation.hunt.refusalSteeredGone'));
    expect(auto.waiting).toBeNull();
    answer = advice([], null, 40);
    auto.steer('lair:b');
    auto.onCharacter(ready());
    expect(auto.refusal).toBeNull();
    expect(auto.waiting).toBe('simulating');
  });

  it('refuses out loud when the named spot is no longer surveyed', () => {
    const auto = hunt();
    auto.steer('lair:gone');
    auto.onCharacter(ready());
    expect(walked).toHaveLength(0);
    expect(decisions.at(-1)).toMatchObject({ action: 'hunt', acted: false });
  });

  it('ends its own lap when the plan moves to another spot', () => {
    here = '1/816';
    const auto = hunt();
    auto.onCharacter(ready());
    expect(started).toHaveLength(1);
    auto.steer('lair:b');
    expect(stops).toHaveLength(1);
    expect(auto.hunting).toBe(false);
  });
});

/* An extension's own plan: a loop it built, run as given and never moved off. */
describe('a hunt order', () => {
  const order = (key = 'joined:a+b'): HuntOrder => {
    const a = spot('lair:a', 12_000);
    const b = spot('lair:b', 9_000, 'Sewer', 920);
    return {
      key,
      loop: {
        name: 'Graveyard and Sewer',
        stops: [...a.walk, ...b.walk].map((room) => huntStop(room, 60))
      },
      start: a.walk[0]!,
      spot: a,
      expPerHour: 18_000,
      copperPerHour: 400
    };
  };
  const at = (exp: number) => ready({ progress: { ...EMPTY_CHARACTER.progress, level: 12, exp } });

  it('walks to its first room and runs its loop, without a survey', () => {
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    expect(walked).toHaveLength(1);
    here = '1/816';
    auto.onWalkEnded(true, null, at(1_000));
    expect(started.map((loop) => loop.name)).toEqual(['Graveyard and Sewer']);
    expect(surveys).toBe(0);
    expect(auto.heading).toEqual({ walking: false, place: 'Graveyard and Sewer' });
  });

  it('stays put where the survey has a better spot, and keeps no rate of its own', () => {
    here = '1/816';
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    expect(started).toHaveLength(1);
    answer = advice([spot('lair:c', 90_000, 'Crypt', 930)]);
    clock += 900_000;
    auto.onCharacter(at(6_000));
    expect(noted).toEqual([]);
    expect(stops).toEqual([]);
    expect(walked).toHaveLength(0);
  });

  it("keeps a single spot's order measured under the spot's key", () => {
    here = '1/816';
    const auto = hunt();
    const a = spot('lair:a', 12_000);
    auto.steer({
      ...order('lair:a'),
      spot: a,
      loop: { name: 'Graveyard', stops: a.walk.map((room) => huntStop(room, 60)) }
    });
    auto.onCharacter(at(1_000));
    clock += 900_000;
    auto.onCharacter(at(6_000));
    expect(noted).toEqual([{ key: 'lair:a', perHour: 20_000 }]);
    expect(stops).toEqual([]);
  });

  it('refuses an order with no stops, and says so', () => {
    const auto = hunt();
    auto.steer({ ...order(), loop: { name: 'nowhere', stops: [] } });
    auto.onCharacter(at(1_000));
    expect(walked).toHaveLength(0);
    expect(auto.refusal).toBe(t('automation.hunt.refusalNoRooms'));
  });

  it('is kept honest again once the order is handed back', () => {
    here = '1/816';
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    auto.steer(undefined);
    answer = advice([spot('lair:c', 90_000, 'Crypt', 930)]);
    clock += 900_000;
    auto.onCharacter(at(6_000));
    expect(stops).toHaveLength(1);
    expect(walked).toHaveLength(1);
  });

  it('ends its lap when steered to another order, and keeps it for the same key', () => {
    here = '1/816';
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    auto.steer(order());
    expect(stops).toEqual([]);
    auto.steer(order('joined:a+c'));
    expect(stops).toHaveLength(1);
    expect(auto.hunting).toBe(false);
  });

  /* 2026-10-06, run 13: the same spot ordered again at the realm's speed, on new clocks and more rooms. */
  it('takes the same key’s new clocks in place, and sets off again where its rooms change', () => {
    here = '1/816';
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    const quicker = order();
    quicker.loop = {
      ...quicker.loop,
      stops: quicker.loop.stops.map((stop) => ({ ...stop, every: 12 }))
    };
    auto.steer(quicker);
    expect(stops).toEqual([]);
    expect(lap?.stops.map((stop) => stop.every)).toEqual(quicker.loop.stops.map(() => 12));
    expect(auto.hunting).toBe(true);
    const fewer = order();
    fewer.loop = { ...fewer.loop, stops: fewer.loop.stops.slice(0, 1) };
    auto.steer(fewer);
    expect(stops).toEqual([t('automation.hunt.reordered')]);
    auto.onCharacter(at(1_000));
    expect(started.at(-1)?.stops).toEqual(fewer.loop.stops);
  });

  it('stops a walk to another start for the same key, and sets off on the new order', () => {
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    expect(walked).toHaveLength(1);
    const elsewhere = order();
    const b = spot('lair:b', 9_000, 'Sewer', 920);
    elsewhere.start = b.walk[0]!;
    elsewhere.loop = { ...elsewhere.loop, stops: [...elsewhere.loop.stops].reverse() };
    auto.steer(elsewhere);
    expect(stops).toEqual([t('automation.hunt.reordered')]);
    auto.onCharacter(at(1_000));
    expect(walked).toHaveLength(2);
  });

  it('leaves a lap that is not its own alone when the same key is ordered again', () => {
    here = '1/816';
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    // The player starts a lap of their own.
    running = 'their own';
    lap = { name: 'their own', stops: [{ room: 'Elsewhere' }] };
    const fewer = order();
    fewer.loop = { ...fewer.loop, stops: fewer.loop.stops.slice(0, 1) };
    auto.steer(fewer);
    expect(stops).toEqual([]);
    expect(lap.name).toBe('their own');
  });

  it('stops a walk to a spot steered away from, so it does not start that spot on arrival', () => {
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    expect(walked).toHaveLength(1);
    auto.steer(order('joined:a+c'));
    expect(stops).toEqual([t('automation.hunt.steeredAway')]);
    here = '1/816';
    auto.onWalkEnded(true, null, at(1_000));
    expect(started).toEqual([]);
  });

  /* A stop that ends the walk at once reports it: the phase is idle by then, so no refusal is said. */
  it('says nothing of a walk its own reorder stopped', () => {
    let made: AutoHunt | null = null;
    const auto = hunt({
      stopLoop: (reason) => {
        stops.push(reason);
        made?.onWalkEnded(false, reason, at(1_000));
      }
    });
    made = auto;
    auto.steer(order());
    auto.onCharacter(at(1_000));
    const elsewhere = order();
    elsewhere.start = spot('lair:b', 9_000, 'Sewer', 920).walk[0]!;
    auto.steer(elsewhere);
    expect(stops).toHaveLength(1);
    expect(notices).not.toContain(
      t('automation.hunt.refusalNotReached', {
        room: order().start.name,
        why: t('automation.hunt.reordered')
      })
    );
    expect(auto.refusal).toBeNull();
  });

  it('keeps a walk to the spot named again after a hand-back, and starts the order on arrival', () => {
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    expect(walked).toHaveLength(1);
    auto.steer(undefined);
    const quicker = order();
    quicker.loop = {
      ...quicker.loop,
      stops: quicker.loop.stops.map((stop) => ({ ...stop, every: 12 }))
    };
    auto.steer(quicker);
    expect(stops).toEqual([]);
    here = '1/816';
    auto.onWalkEnded(true, null, at(1_000));
    expect(started.at(-1)?.stops).toEqual(quicker.loop.stops);
  });

  it('sets off on the newest loop for its key where it was walking there', () => {
    const auto = hunt();
    auto.steer(order());
    auto.onCharacter(at(1_000));
    expect(walked).toHaveLength(1);
    const quicker = order();
    quicker.loop = {
      ...quicker.loop,
      stops: quicker.loop.stops.map((stop) => ({ ...stop, every: 12 }))
    };
    auto.steer(quicker);
    here = '1/816';
    auto.onWalkEnded(true, null, at(1_000));
    expect(started.at(-1)?.stops).toEqual(quicker.loop.stops);
  });
});
