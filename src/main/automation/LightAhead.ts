/**
 * Buying a light before the dark (todo 11, the user's ask 2026-10-01).
 *
 * Before a route, a loop or the trip to a trainer, the way's dark steps
 * (`darkWay`, the realm's level against this character's sight) are weighed
 * against the inventory and the realm's lights (`planLight`); short of one,
 * the item trip buys it at the counter least out of the way and walks on, as
 * it fetches a key for a door. Only rooms too dark to read are bought for; a
 * dim one under `lightDimRooms` is said once, never shopped for. Every reason
 * it is not bought is said, and the walk goes on without. See
 * `mudengine-automation` › *A light is bought before the dark*.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { SafetyDecision } from '../../shared/automation';
import type { NoticeSink } from '../../shared/decisionSettings';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { carriedLights } from '../../shared/light';
import {
  darkWay,
  lightsToCarry,
  planLight,
  type DarkWay,
  type LightAheadPlan,
  type RealmLight
} from '../../shared/lightPlan';
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
  notice?: NoticeSink;
  decided?(decision: SafetyDecision): void;
}

/** What to buy and the sentence that says why, said once the item trip answers (`settle`). */
export interface LightFetch {
  items: Wanted[];
  said: string;
}

const ACTION = 'buy light';

export class LightAhead {
  /** The last dim-rooms sentence said, so a lap after lap does not repeat it. */
  private dimSaid: string | null = null;

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
    const vision = state.sight?.vision ?? 0;
    // A dimly lit room is described whole, so only rooms too dark to read are
    // bought for. Buying for dim ones sent a character 1,816 steps for a
    // 200-reach lamp when the 175 one it carried already read them.
    const way = darkWay(steps, vision, false);
    if (way === null) return this.noteDim(steps, vision, state);
    const dark = way.reaches.length;
    // Unread is not empty: the light may be in it, so nothing is bought on a guess.
    if (state.inventory.listedAt === null) {
      return this.refuse(t('automation.lightAhead.refusalUnlisted', { dark }));
    }
    const answer = planLight(way, carriedLights(state.inventory.items), this.planner.lights());
    switch (answer.kind) {
      case 'carried':
        return this.noteDim(steps, vision, state);
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
      this.config().movement.carryLights
    );
    const item: Wanted = {
      id: light.id,
      name: light.name,
      count: carriedCount(state, light.name) + count,
      dark: true
    };
    const said = this.buyingSentence(answer, way, light.name, count);
    return { items: [item], said };
  }

  /** Why `item` ×`count` is bought: nothing usable carried, or what is carried falls short. */
  private buyingSentence(
    answer: Extract<LightAheadPlan, { kind: 'buy' }>,
    way: DarkWay,
    item: string,
    count: number
  ): string {
    const dark = way.reaches.length;
    const { brightest, unlit, want } = answer;
    if (brightest === null) {
      return unlit === 0
        ? t('automation.lightAhead.buying', { dark, item, count })
        : t('automation.lightAhead.buyingShort', { dark, item, count, unlit });
    }
    const short = {
      dark,
      carried: brightest.name,
      reach: brightest.reach,
      want,
      item,
      count
    };
    return unlit === 0
      ? t('automation.lightAhead.buyingBrighter', short)
      : t('automation.lightAhead.buyingBrighterShort', { ...short, unlit });
  }

  /**
   * Under `lightDimRooms`, say once which rooms on the way stay dimly lit with
   * what is carried and what would light them; nothing is bought for that.
   */
  private noteDim(steps: readonly RouteStep[], vision: number, state: CharacterState): null {
    if (!this.config().movement.lightDimRooms || state.inventory.listedAt === null) return null;
    const dim = darkWay(steps, vision, true);
    if (dim === null) return null;
    const answer = planLight(dim, carriedLights(state.inventory.items), this.planner.lights());
    if (answer.kind !== 'buy') return null;
    const items = answer.lights.map((light) => light.name).join(', ');
    const sentence =
      answer.unlit === 0
        ? t('automation.lightAhead.dimOnly', { dim: dim.reaches.length, items })
        : t('automation.lightAhead.dimOnlyShort', {
            dim: dim.reaches.length,
            items,
            unlit: answer.unlit
          });
    if (sentence === this.dimSaid) return null;
    this.dimSaid = sentence;
    return this.refuse(sentence);
  }

  private refuse(why: string): null {
    this.say(why, false);
    return null;
  }

  private say(sentence: string, acted: boolean): void {
    this.events.notice?.(sentence, 'light-buy');
    this.events.decided?.({
      at: this.now(),
      action: ACTION,
      because: t('automation.lightAhead.because'),
      acted,
      ...(acted ? {} : { refused: sentence })
    });
  }
}
