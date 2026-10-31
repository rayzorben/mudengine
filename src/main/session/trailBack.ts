/**
 * One room back down the trail (`CharacterTracker.trail`), as a route to the
 * room the newest move came from, never the opposite direction: a one-way
 * exit has none, a text exit is not a direction and a door may have shut.
 * Read by the back press (`Travel.stepBack`) and the walk back for a member
 * (`ComeBack`), each wording its own refusals.
 */
import { t } from '../app/i18n';
import type { RoomId, Route, TrailStep } from '../../shared/world';

export type BackLeg =
  /** No confirmed move to go back over. */
  | { kind: 'nothing' }
  /** No way back: the planner's sentence, or the blocked route's. */
  | { kind: 'refused'; reason: string }
  /** Standing in it already: the entry is given up and nothing walked. */
  | { kind: 'there'; step: TrailStep }
  | { kind: 'walk'; step: TrailStep; route: Route };

/** A plan from here to one room: no way there, standing in it already, or the route to walk. */
export type Planned =
  { kind: 'refused'; reason: string } | { kind: 'there' } | { kind: 'walk'; route: Route };

/** What `planFromHere` answered, sorted: the planner's sentence, the blocked route's, or the way. */
export function planned(route: Route | string): Planned {
  if (typeof route === 'string') return { kind: 'refused', reason: route };
  if (route.blocked) return { kind: 'refused', reason: route.reason ?? t('session.back.noRoute') };
  return route.steps.length === 0 ? { kind: 'there' } : { kind: 'walk', route };
}

export function backLeg(
  trail: readonly TrailStep[],
  plan: (to: RoomId) => Route | string
): BackLeg {
  const step = trail.at(-1);
  if (step === undefined) return { kind: 'nothing' };
  const leg = planned(plan(step.from));
  return leg.kind === 'refused' ? leg : { ...leg, step };
}

/**
 * A leg back ended: only an arrival in the room it went back to gives the
 * entry up, so a leg cut short leaves the trail true. Whether it was given up.
 */
export function settleBack(
  step: TrailStep,
  arrived: boolean,
  here: RoomId | null,
  retraced: (step: TrailStep) => void
): boolean {
  if (!arrived || here !== step.from) return false;
  retraced(step);
  return true;
}
