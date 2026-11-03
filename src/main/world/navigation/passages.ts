/**
 * The timed passages a route walks into, for the route's hazards and the
 * quest plan's snags alike: each step's own passage record
 * (`Requirement.corridor`, resolved at load by `WorldGraph.corridorFrom`), so
 * the price, the route and the plan read one fact. A walk whose last room is
 * still under the spell stops inside it, which the next leg does not carry
 * (it has no way-in step), so `ends` is false for it.
 */
import type { Corridor, RoomId, RouteStep } from '../../../shared/world';

export function passagesOn(
  steps: readonly RouteStep[],
  spellOver: (room: RoomId) => Corridor | null
): Corridor[] {
  const last = steps.at(-1)?.to;
  const stopsUnder = last === undefined ? null : spellOver(last);
  return steps.flatMap((step) => {
    const corridor = step.requirement?.corridor;
    if (corridor === undefined) return [];
    const inside = stopsUnder !== null && stopsUnder.spell === corridor.spell;
    return [inside ? { ...corridor, ends: false } : corridor];
  });
}
