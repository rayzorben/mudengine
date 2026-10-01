/**
 * What each stat's next points are worth in exp an hour (todo 83): the
 * hunting survey run for the character as it is, and again for the same
 * character with each stat raised, at the best place each one can safely
 * hunt. A stat is worth what it changes there (swings, accuracy, crits, the
 * blow, dodge), and health only for what the extra hit points let the
 * character hunt; a point that changes nothing there is worth nothing.
 */
import type { CharacterState } from './character';
import type { HuntingSpot } from './hunting';
import {
  raisedBy,
  statSteps,
  wantedByGain,
  type StatGain,
  type StatLimits,
  type TrainedAttribute
} from './training';

/**
 * The best exp an hour the arithmetic gives any spot offered, or null where
 * none has one: the estimate, never what was measured there, since a
 * measured rate does not move with a stat.
 */
function bestRate(spots: readonly HuntingSpot[]): number | null {
  let best: number | null = null;
  for (const spot of spots) {
    const rate = spot.estimate.expPerHour;
    if (rate !== null && (best === null || rate > best)) best = rate;
  }
  return best;
}

/**
 * Each step weighed against the character as it is. A step that opens a
 * place to hunt where none was offered gains that place's whole rate; where
 * neither sheet is offered one, the gain is unknown.
 */
export function statGains(
  state: CharacterState,
  steps: ReadonlyArray<{ attribute: TrainedAttribute; points: number; cost: number }>,
  survey: (as: CharacterState) => readonly HuntingSpot[]
): StatGain[] {
  const base = bestRate(survey(raisedBy(state, null, 0)));
  return steps.map((step) => {
    const rate = bestRate(survey(raisedBy(state, step.attribute, step.points)));
    return { ...step, gain: rate === null ? null : rate - (base ?? 0) };
  });
}

/**
 * Where this visit's points go (`train.pick: exp`): each stat's next
 * `horizon` points weighed by the survey, the best per CP aimed at.
 */
export function chooseByExp(
  state: CharacterState,
  current: Record<TrainedAttribute, number>,
  limits: Record<TrainedAttribute, StatLimits>,
  horizon: number,
  survey: (as: CharacterState) => readonly HuntingSpot[]
): { wanted: Record<TrainedAttribute, number>; chose: StatGain | null } {
  return wantedByGain(current, statGains(state, statSteps(current, limits, horizon), survey));
}
