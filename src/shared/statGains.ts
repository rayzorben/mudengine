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
 * The spots offered with an exp an hour the arithmetic gives, best first: the
 * estimate, never what was measured there, since a measured rate does not
 * move with a stat.
 */
function ranked(spots: readonly HuntingSpot[]): Array<{ key: string; rate: number }> {
  return spots
    .flatMap((spot) =>
      spot.estimate.expPerHour === null ? [] : [{ key: spot.key, rate: spot.estimate.expPerHour }]
    )
    .sort((a, b) => b.rate - a.rate);
}

/**
 * What a stat changes at the places the character hunts: the best rate's
 * change, or the mean change over the `places` best spots, whichever is
 * more. On a realm whose lairs fill on a clock the best spot is the one that
 * waits on its clock, and no blow or dodge moves a
 * wait, so every stat weighed nothing there and the points were kept level
 * after level (2026-10-03). A spot the raised survey leaves out counts as
 * unchanged.
 */
function change(
  base: ReadonlyArray<{ key: string; rate: number }>,
  raised: ReadonlyArray<{ key: string; rate: number }>,
  places: number
): number {
  const best = (raised[0]?.rate ?? 0) - (base[0]?.rate ?? 0);
  const top = base.slice(0, Math.max(1, places));
  if (top.length === 0) return best;
  const by = new Map(raised.map((each) => [each.key, each.rate]));
  const mean =
    top.reduce((sum, each) => sum + (by.get(each.key) ?? each.rate) - each.rate, 0) / top.length;
  return Math.max(best, mean);
}

/**
 * Each step weighed against the character as it is. A step that opens a
 * place to hunt where none was offered gains that place's whole rate; where
 * neither sheet is offered one, the gain is unknown.
 */
export function statGains(
  state: CharacterState,
  steps: ReadonlyArray<{ attribute: TrainedAttribute; points: number; cost: number }>,
  survey: (as: CharacterState) => readonly HuntingSpot[],
  places: number
): StatGain[] {
  const base = ranked(survey(raisedBy(state, null, 0)));
  return steps.map((step) => {
    const raised = ranked(survey(raisedBy(state, step.attribute, step.points)));
    return {
      ...step,
      gain: base.length === 0 && raised.length === 0 ? null : change(base, raised, places)
    };
  });
}

/**
 * Where this visit's points go (`train.pick: exp`): each stat's next
 * `horizon` points weighed by the survey over its `places` best spots, the
 * best per CP aimed at.
 */
export function chooseByExp(
  state: CharacterState,
  current: Record<TrainedAttribute, number>,
  limits: Record<TrainedAttribute, StatLimits>,
  weigh: { horizon: number; places: number },
  survey: (as: CharacterState) => readonly HuntingSpot[]
): { wanted: Record<TrainedAttribute, number>; chose: StatGain | null } {
  return wantedByGain(
    current,
    statGains(state, statSteps(current, limits, weigh.horizon), survey, weigh.places)
  );
}
