/**
 * Whether a walk needs a light bought before it sets off, and which (todo 11).
 *
 * `light.ts` answers for one room at the step; this answers for the whole way
 * before the first step, by the same arithmetic: a step is dark for this
 * character when `reachWanted` is above zero at the level the realm records.
 * A step with no level is an ordinarily lit room (`WorldRoom.light`).
 * How long a light lasts is the server's (`burnSeconds`). See
 * `mudengine-automation` › *A light is bought before the dark*.
 */
import { abilitySum, LIGHT_REACH_ABILITY, lightIsUsable, reachWanted } from './light';
import type { CarriedLight } from './light';
import type { ItemKind } from './items';

/**
 * Uses a readied light loses each time it burns, and how often it burns:
 * GreaterMUD's `TimedEventManager.TickLightSources` takes 10 off the readied
 * item's `UsesLeft` on every HP tick, which is every other 15-second rest tick
 * (`restTick_Fire`), and poofs it below 1. A torch (800) lasts 40 minutes.
 */
export const USES_BURNT_PER_TICK = 10;
export const BURN_TICK_SECONDS = 30;

/** One light the realm lists as sold somewhere, with what decides buying it. */
export interface RealmLight {
  id: number;
  name: string;
  /** `IlluTarget`: how far it reaches once readied. */
  reach: number;
  /** `Items.Uses`, or null where the realm states none. */
  uses: number | null;
}

/** The realm's lights a shop stocks and whose reach is stated, from its item rows. */
export function realmLights(
  items: Iterable<{
    id: number;
    name: string;
    kind?: ItemKind;
    abilities?: Array<[number, number]>;
    uses?: number;
    shops?: string[];
  }>
): RealmLight[] {
  const lights: RealmLight[] = [];
  for (const item of items) {
    if (item.kind !== 'light' || item.abilities === undefined || item.name.length === 0) continue;
    if ((item.shops ?? []).length === 0) continue;
    const reach = abilitySum(item.abilities, LIGHT_REACH_ABILITY);
    if (reach <= 0) continue;
    const uses = item.uses !== undefined && item.uses > 0 ? item.uses : null;
    lights.push({ id: item.id, name: item.name, reach, uses });
  }
  return lights;
}

/** How long one lasts readied, or null where the realm states no uses. */
export function burnSeconds(uses: number | null): number | null {
  return uses === null ? null : Math.ceil(uses / USES_BURNT_PER_TICK) * BURN_TICK_SECONDS;
}

/** The steps of a way this character cannot see in, as the reach each wants. */
export interface DarkWay {
  /** The reach each dark step wants, in route order. */
  reaches: number[];
  /**
   * Steps from the first dark one to the last, both counted: a light readied
   * for the first burns until the walk is over, since it is put out only while
   * nothing walks (`extinguishInLight`).
   */
  span: number;
}

export function darkWay(
  steps: ReadonlyArray<{ light?: number }>,
  vision: number,
  dim: boolean
): DarkWay | null {
  const reaches: number[] = [];
  let first = -1;
  let last = -1;
  steps.forEach((step, index) => {
    const reach = step.light === undefined ? 0 : reachWanted(step.light, vision, dim);
    if (reach <= 0) return;
    reaches.push(reach);
    if (first === -1) first = index;
    last = index;
  });
  return reaches.length === 0 ? null : { reaches, span: last - first + 1 };
}

export type LightAheadPlan =
  /** A usable light in the pack reaches as far as anything sold would. */
  | { kind: 'carried' }
  /**
   * Buy one of `lights`, each reaching as far as anything sold reaches.
   * `unlit` is how many dark steps stay dark even so.
   */
  | { kind: 'buy'; lights: RealmLight[]; unlit: number }
  | { kind: 'none'; reason: 'nothing sold' | 'nothing reaches' };

/**
 * What to do about `way` with `carried` in the pack and `sold` on the realm's
 * shelves. The reach aimed at is the most the way wants, or the most anything
 * sold gives where that is less; a carried light of unstated reach counts, as
 * `chooseLight` offers one as a guess.
 */
export function planLight(
  way: DarkWay,
  carried: ReadonlyArray<CarriedLight>,
  sold: ReadonlyArray<RealmLight>
): LightAheadPlan {
  const usable = carried.filter(lightIsUsable);
  const want = Math.max(...way.reaches);
  const best = Math.max(0, ...sold.map((light) => light.reach));
  const target = Math.min(want, best);
  const reaches = (light: CarriedLight): boolean => light.reach === null || light.reach >= target;
  if (sold.length === 0 || best < Math.min(...way.reaches)) {
    if (usable.length > 0) return { kind: 'carried' };
    return { kind: 'none', reason: sold.length === 0 ? 'nothing sold' : 'nothing reaches' };
  }
  if (usable.some(reaches)) return { kind: 'carried' };
  return {
    kind: 'buy',
    lights: sold.filter((light) => light.reach >= target),
    unlit: way.reaches.filter((reach) => reach > target).length
  };
}

/**
 * How many of a light to carry for `span` dark steps at `stepMs` a step: as
 * many as burn that long, never under `floor`, and `floor` where the realm
 * states no uses.
 */
export function lightsToCarry(
  span: number,
  stepMs: number,
  uses: number | null,
  floor: number
): number {
  const burn = burnSeconds(uses);
  if (burn === null || burn <= 0) return floor;
  return Math.max(floor, Math.ceil((span * stepMs) / 1000 / burn));
}
