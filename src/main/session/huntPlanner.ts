/**
 * What going hunting (`AutoHunt`, todo 05) is handed: the survey, routes from
 * here, the walk to the spot as a route the player can see rather than a leg,
 * the lap it runs filed nowhere (through `Travel.startLoop`, so one movement
 * at a time and a light bought for its rooms), and where the rate it paid is
 * kept. Out of `SessionManager`'s constructor whole, as `trainPlanner.ts` is.
 */
import type { HuntPlanner } from '../automation/AutoHunt';
import type { LoopRunner } from '../automation/LoopRunner';
import type { Walker } from '../automation/Walker';
import type { CharacterTracker } from '../parse/CharacterTracker';
import { roomAddress } from '../../shared/world';
import type { Belongings } from './Belongings';
import type { Errands } from './Errands';
import type { Travel } from './Travel';

/** The modules, read when the hunt asks: several are built after it. */
export interface HuntPlannerModules {
  tracker: Pick<CharacterTracker, 'current' | 'pendingMoves'>;
  errands: Pick<Errands, 'huntingGrounds' | 'planFromHere'>;
  belongings: Pick<Belongings, 'rememberHuntRate'>;
  walker: Pick<Walker, 'start' | 'walking'>;
  loops: Pick<LoopRunner, 'progress'>;
  travel: Pick<Travel, 'startLoop'>;
}

export interface HuntPlannerParts {
  modules(): HuntPlannerModules;
  /** Stops the lap and the leg it is walking. */
  stopLap(reason: string): void;
  /** Nothing else in the middle of something: `SessionManager.errandHeld`. */
  busy(): boolean;
}

export function huntPlanner(parts: HuntPlannerParts): HuntPlanner {
  const m = parts.modules;
  return {
    here: () => roomAddress(m().tracker.current.room),
    survey: (radius) => m().errands.huntingGrounds(radius),
    noteRate: (key, rate) => m().belongings.rememberHuntRate(key, rate),
    routeTo: (room) => m().errands.planFromHere(room),
    walk: (route) => m().walker.start(route, m().tracker.current),
    runLoop: (loop) => {
      const answer = m().travel.startLoop(loop);
      return 'refused' in answer ? answer.refused : null;
    },
    // The lap's **name**, so the hunt can tell its own from one the player
    // started while it was running. See `HuntPlanner.runningLoop`.
    runningLoop: () => {
      const { progress } = m().loops;
      return progress.status === 'running' ? (progress.name ?? null) : null;
    },
    stopLoop: parts.stopLap,
    moveInFlight: () => m().tracker.pendingMoves > 0,
    walking: () => m().walker.walking,
    busy: parts.busy
  };
}
