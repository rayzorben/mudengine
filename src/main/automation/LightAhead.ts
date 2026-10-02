/**
 * Buying a light before the dark (todo 11, the user's ask 2026-10-01).
 *
 * Before a route, a loop or the trip to a trainer, the way's dark steps
 * (`darkWay`, the realm's level against this character's sight) are weighed
 * against the inventory and the realm's lights (`planLight`); short of one,
 * the item trip buys it at the counter least out of the way and walks on, as
 * it fetches a key for a door. Every reason it is not bought is said, and the
 * walk goes on without. `AutoLight` lights what this buys. See
 * `mudengine-automation` › *A light is bought before the dark*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { carriedLights } from '../../shared/light';
import { darkWay, lightsToCarry, planLight, type RealmLight } from '../../shared/lightPlan';
import type { Loop } from '../../shared/loops';
import { carriedCount } from '../../shared/supplies';
import type { BuyingPlace, RoomId, Route, RouteStep } from '../../shared/world';
import type { Wanted } from './ItemErrand';

export interface LightPlanner {
  /** The realm's lights a shop stocks, with their reach and uses. */
  lights(): readonly RealmLight[];
  /** The counters stocking any of `items`, least out of the way of the trip to `to` first. */
  counters(
    items: readonly number[],
    to: RoomId | null
  ): ReadonlyArray<BuyingPlace & { item: number }>;
  /** The steps of one lap of `loop`, stop to stop, as its legs are planned. */
  lapSteps(loop: Loop): readonly RouteStep[];
  /** Fetch `items`, then walk `owes` (null walks nothing). Its refusal, or null once under way. */
  collect(items: readonly Wanted[], owes: Route | null, run: boolean): string | null;
  /** Whether the item trip is already fetching something. */
  collecting(): boolean;
}

export interface LightAheadEvents {
  notice?(message: string): void;
  decided?(decision: SafetyDecision): void;
}

/** What to buy and the sentence that says why, said once the item trip answers (`settle`). */
export interface LightFetch {
  items: Wanted[];
  said: string;
}

const ACTION = 'buy light';

export class LightAhead {
  constructor(
    private readonly config: () => AutomationConfig,
    private readonly planner: LightPlanner,
    private readonly events: LightAheadEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Before the player's route: true when the item trip has taken it over and
   * walks it once the light is bought, false when the caller walks it now.
   */
  beforeRoute(route: Route, state: CharacterState, run: boolean): boolean {
    const fetch = this.plan(route.steps, route.steps.at(-1)?.to ?? null, state);
    return fetch !== null && this.collect(fetch, route, run);
  }

  /** A lap just started: buy the light its rooms want, the lap held while the shop is walked to. */
  beforeLap(loop: Loop, state: CharacterState): void {
    // The item trip's own lap round a lair: it is the trip, and has nothing to spare.
    if (this.planner.collecting()) return;
    const fetch = this.plan(this.planner.lapSteps(loop), null, state);
    if (fetch !== null) this.collect(fetch, null, false);
  }

  /**
   * What a trip that fetches before it walks (`TrainErrand`) adds to its list
   * for `route`, or null. The trip hands its fetch's answer to `settle`.
   */
  wanted(route: Route, state: CharacterState): LightFetch | null {
    return this.plan(route.steps, route.steps.at(-1)?.to ?? null, state);
  }

  /** Say what became of `fetch`: being bought, or `refused` and walked on without. */
  settle(fetch: LightFetch, refused: string | null): void {
    if (refused === null) this.say(fetch.said, true);
    else this.say(t('automation.lightAhead.refusalCollect', { why: refused }), false);
  }

  private collect(fetch: LightFetch, owes: Route | null, run: boolean): boolean {
    const refused = this.planner.collect(fetch.items, owes, run);
    this.settle(fetch, refused);
    return refused === null;
  }

  /** The light this way wants bought, or null: said where one is wanted and none can be had. */
  private plan(
    steps: readonly RouteStep[],
    to: RoomId | null,
    state: CharacterState
  ): LightFetch | null {
    const config = this.config();
    const movement = config.movement;
    if (!config.enabled || !movement.provideLight || !movement.buyLight) return null;
    const way = darkWay(steps, state.sight?.vision ?? 0, movement.lightDimRooms);
    if (way === null) return null;
    const dark = way.reaches.length;
    // Unread is not empty: the light may be in it, so nothing is bought on a guess.
    if (state.inventory.listedAt === null) {
      return this.refuse(t('automation.lightAhead.refusalUnlisted', { dark }));
    }
    const sold = this.planner.lights();
    const answer = planLight(way, carriedLights(state.inventory.items), sold);
    switch (answer.kind) {
      case 'carried':
        return null;
      case 'none':
        return this.refuse(
          answer.reason === 'nothing sold'
            ? t('automation.lightAhead.refusalNothingSold', { dark })
            : t('automation.lightAhead.refusalNothingReaches', { dark })
        );
      case 'buy':
        break;
      default: {
        const unhandled: never = answer;
        return unhandled;
      }
    }
    const place = this.planner.counters(
      answer.lights.map((light) => light.id),
      to
    )[0];
    const light = answer.lights.find((each) => each.id === place?.item);
    if (place === undefined || light === undefined) {
      const items = answer.lights.map((each) => each.name).join(', ');
      return this.refuse(t('automation.lightAhead.refusalNoShop', { dark, items }));
    }
    const count = lightsToCarry(
      way.span,
      tuning().hunting.stepMs,
      light.uses,
      tuning().light.carryAtLeast
    );
    const item: Wanted = {
      id: light.id,
      name: light.name,
      count: carriedCount(state, light.name) + count,
      dark: true
    };
    const said =
      answer.unlit === 0
        ? t('automation.lightAhead.buying', { dark, item: light.name, count })
        : t('automation.lightAhead.buyingShort', {
            dark,
            item: light.name,
            count,
            unlit: answer.unlit
          });
    return { items: [item], said };
  }

  private refuse(why: string): null {
    this.say(why, false);
    return null;
  }

  private say(sentence: string, acted: boolean): void {
    this.events.notice?.(sentence);
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.lightAhead.because'),
      acted,
      ...(acted ? {} : { refused: sentence })
    });
  }
}
