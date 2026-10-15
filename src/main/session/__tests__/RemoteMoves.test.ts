import { describe, expect, it } from 'vitest';

import { RemoteMoves, type RemoteMovesSession, type RemoteRooms } from '../RemoteMoves';
import { asLoops, NO_LOOP, type Loop, type LoopProgress } from '../../../shared/loops';
import type { Movement, MovementStart } from '../../../shared/movement';
import { formatPath, parseRemoteReply } from '../../../shared/remotes';
import type { CarriedLap } from '../../../shared/underway';
import { IDLE_WALK, type WalkProgress } from '../../../shared/walk';
import type { RoomId } from '../../../shared/world';
import type { DecisionKind } from '../../../shared/decisionSettings';

/* Todo 32: `@path` says what `@loop` and `@goto` read back. */
const [caveworm, mine] = asLoops([
  {
    name: 'Sewers: CaveWorm',
    pathFile: 'DCCWLOOP.mp',
    stops: ['Dark Cave 1/866', 'Dark Cave 1/865']
  },
  { name: 'Sewer circuit', stops: ['Sewer Tunnel 1/766', 'Sewer Tunnel'] }
]) as [Loop, Loop];

const lapOf = (loop: Loop, running: boolean): CarriedLap => ({
  loop,
  index: 0,
  forward: true,
  laps: 0,
  running,
  reason: null,
  startedAt: null,
  lapBegunAt: null,
  expAtStart: null
});

interface Fake {
  movement: Movement;
  walk: WalkProgress;
  lap: LoopProgress;
  place: CarriedLap | null;
  started: string[];
  through: RoomId[][];
  /** The decision each notice reported. */
  kinds: Array<DecisionKind | undefined>;
}

function moves(fake: Fake, own: Loop[] = [], shelf: Loop[] = []): RemoteMoves {
  const session: RemoteMovesSession = {
    get movement() {
      return fake.movement;
    },
    walker: {
      get progress() {
        return fake.walk;
      }
    },
    loops: {
      get progress() {
        return fake.lap;
      },
      get place() {
        return fake.place;
      }
    },
    stopMoving: () => undefined,
    startMoving: (name, confirmed): MovementStart => {
      fake.started.push(`resume ${name} ${confirmed}`);
      return confirmed === null ? ({ confirm: { steps: 9 } } as MovementStart) : { started: true };
    },
    startLoop: (loop) => (fake.started.push(`start ${loop.name}`), { started: true }),
    walkRoute: () => null
  };
  const rooms: RemoteRooms = {
    matchStop: (stop) => (stop.at === null ? { kind: 'none' } : { kind: 'one', at: stop.at }),
    planFromHere: () => 'unplaced',
    stepsThrough: (list) => (fake.through.push([...list]), 3 * list.length)
  };
  const notice = (_message: string, decision?: DecisionKind): void =>
    void fake.kinds.push(decision);
  return new RemoteMoves(session, rooms, notice, { own: () => own, shelf: () => shelf });
}

const fake = (over: Partial<Fake> = {}): Fake => ({
  movement: { kind: null, moving: false, resumable: false },
  walk: IDLE_WALK,
  lap: NO_LOOP,
  place: null,
  started: [],
  through: [],
  kinds: [],
  ...over
});

describe('@path', () => {
  it('is none while going nowhere', () => {
    expect(moves(fake()).events.path()).toBeNull();
  });

  it('names a lap by its path file and title, counted through the stops still owed', () => {
    const state = fake({
      movement: { kind: 'loop', moving: true, resumable: true },
      lap: {
        ...NO_LOOP,
        status: 'running',
        name: caveworm.name,
        stop: 1,
        stops: 2,
        remainingStops: ['1/866', '1/865']
      },
      place: lapOf(caveworm, true)
    });
    const report = moves(state).events.path();
    expect(formatPath(report)).toBe('{DCCWLOOP.mp (Sewers: CaveWorm) - 6 steps to lap end}');
    expect(state.through).toEqual([['1/866', '1/865']]);
  });

  /* `@stop` then `@path`: the map draws nothing for a stopped lap, and the count does not care. */
  it('counts a stopped lap from its kept place', () => {
    const state = fake({
      movement: { kind: 'loop', moving: false, resumable: true },
      lap: { ...NO_LOOP, status: 'stopped', name: caveworm.name, remainingStops: [] },
      place: { ...lapOf(caveworm, false), index: 1 }
    });
    expect(formatPath(moves(state).events.path())).toBe(
      '{DCCWLOOP.mp (Sewers: CaveWorm) - 3 steps to lap end}'
    );
    expect(state.through).toEqual([['1/865']]);
  });

  it('says ? where a stop owed is not placed, and uses the name where there is no file', () => {
    const state = fake({
      movement: { kind: 'loop', moving: false, resumable: true },
      lap: {
        ...NO_LOOP,
        status: 'stopped',
        name: mine.name,
        stop: 1,
        stops: 2,
        remainingStops: ['1/766']
      },
      place: lapOf(mine, false)
    });
    expect(formatPath(moves(state).events.path())).toBe('{Sewer circuit - ? steps to lap end}');
  });

  it('writes a route as a loop stop is written, counted to where it goes', () => {
    const state = fake({
      movement: { kind: 'route', moving: true, resumable: true },
      walk: {
        ...IDLE_WALK,
        status: 'walking',
        done: 3,
        total: 15,
        destination: 'Dark Cave',
        destinationRoom: { map: 1, room: 866 }
      }
    });
    expect(formatPath(moves(state).events.path())).toBe('{Dark Cave 1/866 - 12 steps to go}');
  });

  it('adds the trip a lap is held for', () => {
    const state = fake({
      movement: { kind: 'loop', moving: true, resumable: true },
      walk: {
        ...IDLE_WALK,
        status: 'walking',
        asked: false,
        done: 1,
        total: 8,
        destination: 'General Store',
        destinationRoom: { map: 1, room: 23 }
      },
      lap: { ...NO_LOOP, status: 'running', name: caveworm.name, hold: 'errand' },
      place: lapOf(caveworm, true)
    });
    expect(formatPath(moves(state).events.path())).toBe(
      '{DCCWLOOP.mp (Sewers: CaveWorm) -> General Store 1/23 (detour) - 7 steps to go}'
    );
  });
});

describe('@stop', () => {
  it('says, as a remote move, that nothing was moving', () => {
    const state = fake();
    expect(moves(state).events.stopMoving('Rayzor')).toBe(false);
    expect(state.kinds).toEqual(['remote-moves']);
  });
});

describe('@loop after @path', () => {
  it('starts the shelf loop the path file names, unkept, at its nearest stop', () => {
    const state = fake();
    const sent = parseRemoteReply('{DCCWLOOP.mp (Sewers: CaveWorm) - 4 steps to lap end}');
    if (sent?.kind !== 'path') throw new Error('not a path frame');
    expect(moves(state, [mine], [caveworm]).events.startLoop('Rayzor', sent.report.path)).toEqual({
      kind: 'ok'
    });
    expect(state.started).toEqual(['start Sewers: CaveWorm']);
  });

  it('resumes the stopped lap it names, taking the distance as agreed', () => {
    const state = fake({
      movement: { kind: 'loop', moving: false, resumable: true },
      lap: { ...NO_LOOP, status: 'stopped', name: caveworm.name },
      place: lapOf(caveworm, false)
    });
    expect(moves(state).events.startLoop('Rayzor', 'dccwloop')).toEqual({ kind: 'ok' });
    expect(state.started).toEqual(['resume Sewers: CaveWorm null', 'resume Sewers: CaveWorm 9']);
  });

  it('answers several with the candidates, own loops first, and none as unknown', () => {
    const other = { ...mine, name: 'Sewers: Sewer circuit' };
    expect(moves(fake(), [mine, other]).events.startLoop('Rayzor', 'sewer circuit')).toEqual({
      kind: 'unknown',
      request: 'sewer circuit',
      candidates: ['Sewer circuit', 'Sewers: Sewer circuit']
    });
    expect(moves(fake(), [mine], [caveworm]).events.startLoop('Rayzor', 'nowhere')).toEqual({
      kind: 'unknown',
      request: 'nowhere',
      candidates: []
    });
  });
});
