/**
 * The part every trip's planner shares (todo 05): where the character stands,
 * a route from here through the navigation engine, the walk as a leg, whether
 * a move or a walk is under way, and the lap held for the trip. Spread into
 * `outgrownPlanner`, `collectPlanner` and `trainPlanner`, so a change to how a
 * leg is walked or a lap held is made once.
 */
import type { LoopRunner } from '../automation/LoopRunner';
import type { Walker } from '../automation/Walker';
import type { CharacterTracker } from '../parse/CharacterTracker';
import { roomAddress, type RoomId, type Route } from '../../shared/world';
import type { Errands } from './Errands';
import { ERRAND_LEG } from './Travel';

/** The modules, read when a trip asks: several are built after it. */
export interface LegModules {
  tracker: Pick<CharacterTracker, 'current' | 'pendingMoves'>;
  errands: Pick<Errands, 'planFromHere'>;
  walker: Pick<Walker, 'start' | 'walking'>;
  loops: Pick<LoopRunner, 'progress' | 'noteErrand'>;
}

export interface LegPlanner {
  here(): RoomId | null;
  routeTo(room: RoomId): Route | string;
  walk(route: Route): string | null;
  moveInFlight(): boolean;
  walking(): boolean;
  looping(): boolean;
  hold(): void;
}

export function legPlanner(m: () => LegModules): LegPlanner {
  return {
    here: () => roomAddress(m().tracker.current.room),
    routeTo: (room) => m().errands.planFromHere(room, {}, ERRAND_LEG.kind),
    walk: (route) => m().walker.start(route, m().tracker.current, ERRAND_LEG),
    moveInFlight: () => m().tracker.pendingMoves > 0,
    walking: () => m().walker.walking,
    looping: () => m().loops.progress.status === 'running',
    hold: () => m().loops.noteErrand()
  };
}
