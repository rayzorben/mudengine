/**
 * What the character was doing when the app last saw it: the lap and the
 * route the player asked for, kept in the character's own record so a quit
 * and a relaunch carry them as a dropped connection does (todo 01,
 * 2026-09-30). See `mudengine-session` › *Every close carries the loop and
 * the route*.
 *
 * Dependency-free like everything in `shared/`.
 */
import { asLoops, type Loop } from './loops';
import { isRecord } from './values';
import { asRoomIds, type RoomId } from './world';

/** A lap and its place round it, as `LoopRunner` holds them. */
export interface CarriedLap {
  /** Whole, because a hunt's loop is filed nowhere and its name alone could not bring it back. */
  loop: Loop;
  index: number;
  forward: boolean;
  laps: number;
  /** False for a stopped lap, which is carried with its place kept and walks nothing. */
  running: boolean;
  reason: string | null;
  startedAt: number | null;
  /** When the lap was reached after the player last started it; see `LoopRunner.beginLap`. */
  lapBegunAt: number | null;
  expAtStart: number | null;
}

/** The route the player asked for, by where it ends. `run` is *Run it*. */
export interface CarriedRoute {
  to: RoomId;
  name: string;
  run: boolean;
}

export interface Underway {
  lap: CarriedLap | null;
  route: CarriedRoute | null;
  /**
   * A run turned auto-combat off and had not given it back. What a run turns
   * off is the run's, so the next dial gives it back (2026-10-08: Soul's run
   * ended short on one launch and the next fought nothing for eight hours).
   */
  combatOffForRun: boolean;
}

export const NOTHING_UNDERWAY: Underway = { lap: null, route: null, combatOffForRun: false };

/** Where `Underway` is kept between launches. Written as it changes, read at `connect`. */
export interface UnderwaySink {
  recallUnderway(): Underway;
  rememberUnderway(underway: Underway): void;
}

/** The sink for a session with nowhere to write: nothing was underway, and nothing is kept. */
export const NO_UNDERWAY: UnderwaySink = {
  recallUnderway: () => NOTHING_UNDERWAY,
  rememberUnderway: () => {}
};

/** Whether two readings say the same; the lap's loop is compared by reference, as the runner holds one. */
export function sameUnderway(a: Underway, b: Underway): boolean {
  return (
    sameLap(a.lap, b.lap) && sameRoute(a.route, b.route) && a.combatOffForRun === b.combatOffForRun
  );
}

function sameLap(a: CarriedLap | null, b: CarriedLap | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.loop === b.loop &&
    a.index === b.index &&
    a.forward === b.forward &&
    a.laps === b.laps &&
    a.running === b.running &&
    a.reason === b.reason &&
    a.startedAt === b.startedAt &&
    a.lapBegunAt === b.lapBegunAt &&
    a.expAtStart === b.expAtStart
  );
}

function sameRoute(a: CarriedRoute | null, b: CarriedRoute | null): boolean {
  if (a === null || b === null) return a === b;
  return a.to === b.to && a.name === b.name && a.run === b.run;
}

/** Parses a record read off disk. A part that does not parse is nothing carried, never a guess. */
export function asUnderway(value: unknown): Underway {
  if (!isRecord(value)) return NOTHING_UNDERWAY;
  return {
    lap: asLap(value['lap']),
    route: asCarriedRoute(value['route']),
    combatOffForRun: value['combatOffForRun'] === true
  };
}

function asLap(value: unknown): CarriedLap | null {
  if (!isRecord(value)) return null;
  const loop = asLoops([value['loop']])[0];
  const index = value['index'];
  if (loop === undefined || !Number.isInteger(index)) return null;
  if ((index as number) < 0 || (index as number) >= loop.stops.length) return null;
  if (typeof value['forward'] !== 'boolean' || typeof value['running'] !== 'boolean') return null;
  const laps = value['laps'];
  return {
    loop,
    index: index as number,
    forward: value['forward'],
    laps: Number.isInteger(laps) && (laps as number) >= 0 ? (laps as number) : 0,
    running: value['running'],
    reason: typeof value['reason'] === 'string' ? value['reason'] : null,
    startedAt: clock(value['startedAt']),
    lapBegunAt: clock(value['lapBegunAt']),
    expAtStart: clock(value['expAtStart'])
  };
}

function asCarriedRoute(value: unknown): CarriedRoute | null {
  if (!isRecord(value)) return null;
  const to = asRoomIds([value['to']], 1)?.[0];
  const { name, run } = value;
  if (to === undefined || typeof name !== 'string' || typeof run !== 'boolean') return null;
  return { to, name, run };
}

/** A figure the runner may not have had: null stays null, never zero. */
function clock(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
