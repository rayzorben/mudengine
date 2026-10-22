import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobFinder, type MobFinderPlanner } from '../MobFinder';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import type { SafetyDecision } from '../../../shared/automation';
import type { MobFindPlan } from '../../../shared/mobFind';
import type { RoomId, Route } from '../../../shared/world';
import { noticeLog, type NoticeLog } from './noticeLog';

const state = (mobs: string[] = []): CharacterState => ({
  ...structuredClone(EMPTY_CHARACTER),
  phase: 'in-game',
  room: {
    ...structuredClone(EMPTY_CHARACTER.room),
    occupants: mobs.map((name): RoomOccupant => ({
      name,
      kind: 'mob',
      disposition: null,
      uncertain: false,
      costly: 'never',
      charmed: false,
      hidden: false,
      free: false
    }))
  }
});

/** A corridor 1/1 - 1/2 - 1/3 - 1/4, the character in 1/1, the gravedigger lairing in 1/2 and 1/4. */
const PLAN: MobFindPlan = {
  mob: 'gravedigger',
  regenHours: 1,
  rooms: ['1/2', '1/4'],
  steps: 3,
  unreached: []
};

/** A route of single steps along the corridor, from where the character stands. */
function routeTo(from: RoomId, to: RoomId): Route {
  const at = (room: RoomId): number => Number(room.split('/')[1]);
  const steps = [];
  for (let room = at(from); room !== at(to); room += Math.sign(at(to) - at(from))) {
    const next = room + Math.sign(at(to) - at(from));
    steps.push({ from: `1/${room}`, to: `1/${next}` });
  }
  return { steps, cost: steps.length, blocked: false } as unknown as Route;
}

let log: NoticeLog;
let decisions: SafetyDecision[];
let here: RoomId;
let walks: RoomId[];
let stops: string[];
let walking: boolean;
let fighting: boolean;
let switchedOn: number;

const planner = (over: Partial<MobFinderPlanner> = {}): MobFinderPlanner => ({
  here: () => here,
  routeTo: (room) => routeTo(here, room),
  walk: (route) => {
    walks.push(route.steps.at(-1)?.to ?? here);
    walking = true;
    return null;
  },
  stopWalk: (reason) => {
    stops.push(reason);
    walking = false;
  },
  switchedOnFor: (start) => {
    switchedOn += 1;
    return start();
  },
  plan: () => PLAN,
  nameOf: (room) => `room ${room}`,
  // The monster's realm name is what the occupant carries; a bare name is not it.
  present: (mob, state) => state.room.occupants.some((who) => who.name === mob),
  fightsBack: () => true,
  moveInFlight: () => false,
  walking: () => walking,
  looping: () => false,
  busy: () => false,
  escaping: () => false,
  fighting: () => fighting,
  ...over
});

beforeEach(() => {
  vi.useFakeTimers();
  log = noticeLog();
  decisions = [];
  here = '1/1';
  walks = [];
  stops = [];
  walking = false;
  fighting = false;
  switchedOn = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

const make = (over: Partial<MobFinderPlanner> = {}, enabled = true): MobFinder =>
  new MobFinder(enabled, planner(over), { notice: log.notice, decided: (d) => decisions.push(d) });

/** The walk arrived: the character stands in `room`, with `mobs` there. */
const arrive = (finder: MobFinder, room: RoomId, mobs: string[] = []): void => {
  here = room;
  walking = false;
  finder.onCharacter(state(mobs));
  finder.onWalkEnded(true, null, state(mobs));
};

describe('finding a monster', () => {
  it('walks each lair in order and ends in the first one the monster is in', () => {
    const finder = make();
    expect(finder.start('gravedigger', state())).toBeNull();
    expect(switchedOn).toBe(1);
    expect(walks).toEqual(['1/2']);
    expect(log.kinds).toEqual(['mob-find']);

    arrive(finder, '1/2');
    expect(finder.busy).toBe(true);
    // Not there: the next status line walks on.
    finder.onCharacter(state());
    expect(walks).toEqual(['1/2', '1/4']);

    arrive(finder, '1/4', ['gravedigger']);
    expect(finder.busy).toBe(false);
    expect(log.notices.at(-1)).toContain('room 1/4');
    expect(decisions.at(-1)).toMatchObject({ action: 'find a monster', acted: true });
  });

  it('stops the walk in a room on the way where the monster turns up', () => {
    const finder = make({ plan: () => ({ ...PLAN, rooms: ['1/4', '1/2'] }) });
    finder.start('gravedigger', state());
    // The way to 1/4 passes 1/2, a lair still to see: the walk stops there first.
    expect(walks).toEqual(['1/2']);
    here = '1/3';
    finder.onCharacter(state(['gravedigger']));
    expect(stops).toHaveLength(1);
    expect(finder.busy).toBe(false);
    expect(decisions.at(-1)).toMatchObject({ acted: true });
  });

  it('is over, unfound, once every lair has been looked at', () => {
    const finder = make();
    finder.start('gravedigger', state());
    arrive(finder, '1/2');
    finder.onCharacter(state());
    arrive(finder, '1/4');
    // Looked at: the status line after the last arrival ends it.
    finder.onCharacter(state());
    expect(finder.busy).toBe(false);
    expect(decisions.at(-1)).toMatchObject({ acted: false });
    expect(decisions.at(-1)?.refused).toBeUndefined();
  });

  it('is found where the character already stands, walking nowhere', () => {
    const finder = make();
    finder.start('gravedigger', state(['gravedigger']));
    expect(walks).toEqual([]);
    expect(finder.busy).toBe(false);
    expect(decisions.at(-1)).toMatchObject({ acted: true });
  });

  it('plans a leg that ended short again once, then passes the room over', () => {
    const finder = make();
    finder.start('gravedigger', state());
    walking = false;
    finder.onWalkEnded(false, 'a fight', state());
    finder.onCharacter(state());
    expect(walks).toEqual(['1/2', '1/2']);
    walking = false;
    finder.onWalkEnded(false, 'a fight', state());
    finder.onCharacter(state());
    // Passed over: the next lair is walked to.
    expect(walks).toEqual(['1/2', '1/2', '1/4']);
  });

  it('ends after the tuned number of lairs missed in a row', () => {
    const finder = make({
      routeTo: () => 'no way',
      plan: () => ({ ...PLAN, rooms: ['1/2', '1/3', '1/4'] })
    });
    finder.start('gravedigger', state());
    expect(walks).toEqual([]);
    expect(finder.busy).toBe(false);
    expect(log.notices.filter((line) => line.startsWith('Passed over'))).toHaveLength(3);
  });

  it('waits out a fight and a rest between lairs', () => {
    const finder = make();
    finder.start('gravedigger', state());
    arrive(finder, '1/2');
    fighting = true;
    finder.onCharacter(state());
    expect(walks).toEqual(['1/2']);
    fighting = false;
    const resting = state();
    resting.vitals.resting = true;
    finder.onCharacter(resting);
    expect(walks).toEqual(['1/2']);
    finder.onCharacter(state());
    expect(walks).toEqual(['1/2', '1/4']);
  });
});

describe('what ends or refuses a find', () => {
  it('refuses while fighting, looping, walking or on another trip, and says so', () => {
    expect(make({ fighting: () => true }).start('gravedigger', state())).not.toBeNull();
    expect(make({ looping: () => true }).start('gravedigger', state())).not.toBeNull();
    expect(make({ walking: () => true }).start('gravedigger', state())).not.toBeNull();
    expect(make({ busy: () => true }).start('gravedigger', state())).not.toBeNull();
    expect(make().start('gravedigger', { ...state(), phase: 'authenticating' })).not.toBeNull();
    expect(decisions.every((d) => !d.acted && d.refused !== undefined)).toBe(true);
    expect(walks).toEqual([]);
  });

  it('refuses with the plan’s reason, and with the switch off after the write failed', () => {
    const why = 'gravedigger lairs in one room only';
    expect(make({ plan: () => why }).start('gravedigger', state())).toBe(why);
    const off = make({ switchedOnFor: (start) => start() }, false);
    expect(off.start('gravedigger', state())).not.toBeNull();
    expect(off.busy).toBe(false);
  });

  it('ends on the player’s stop, a death, the switch, leaving the realm and running away', () => {
    const stopped = make();
    stopped.start('gravedigger', state());
    stopped.stop('the player pressed stop');
    expect(stopped.busy).toBe(false);

    const died = make();
    died.start('gravedigger', state());
    died.abandon();
    expect(died.busy).toBe(false);

    const switched = make();
    switched.start('gravedigger', state());
    switched.configure(false);
    expect(switched.busy).toBe(false);

    const left = make();
    left.start('gravedigger', state());
    left.onCharacter({ ...state(), phase: 'authenticating' });
    expect(left.busy).toBe(false);

    let escaping = false;
    const ran = make({ escaping: () => escaping });
    ran.start('gravedigger', state());
    escaping = true;
    ran.onCharacter(state());
    expect(ran.busy).toBe(false);
    expect(decisions.filter((d) => !d.acted)).toHaveLength(5);
  });

  it('ends when attacked with auto-combat off, and walks on through a fight with it on', () => {
    const off = make({ fightsBack: () => false });
    off.start('gravedigger', state());
    fighting = true;
    off.onCharacter(state());
    expect(off.busy).toBe(false);

    fighting = false;
    walking = false;
    const on = make();
    on.start('gravedigger', state());
    fighting = true;
    on.onCharacter(state());
    expect(on.busy).toBe(true);
  });

  it('previews the walk, with the rooms named, or the plan’s refusal', () => {
    expect(make().preview('gravedigger')).toMatchObject({
      mob: 'gravedigger',
      rooms: ['room 1/2', 'room 1/4'],
      steps: 3,
      combatOff: false
    });
    expect(make({ plan: () => 'no such' }).preview('x')).toEqual({ refused: 'no such' });
  });
});
