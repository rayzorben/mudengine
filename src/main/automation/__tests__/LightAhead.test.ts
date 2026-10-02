import { beforeEach, describe, expect, it } from 'vitest';

import { LightAhead, type LightPlanner } from '../LightAhead';
import type { Wanted } from '../ItemErrand';
import { t } from '../../app/i18n';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { wireItem, type ItemEntity } from '../../../shared/entities';
import { carriedLights, sightOf } from '../../../shared/light';
import type { RealmLight } from '../../../shared/lightPlan';
import type { Loop } from '../../../shared/loops';
import type { SafetyDecision } from '../../../shared/automation';
import type { BuyingPlace, Route, RouteStep } from '../../../shared/world';

const TORCH: RealmLight = { id: 175, name: 'torch', reach: 100, uses: 800 };
const LANTERN: RealmLight = { id: 176, name: 'lantern', reach: 175, uses: 2400 };

const step = (to: string, light?: number): RouteStep =>
  ({
    from: '1/1',
    to,
    direction: 'n',
    command: 'n',
    name: to,
    requirement: null,
    dark: light !== undefined,
    ...(light === undefined ? {} : { light })
  }) as RouteStep;

/** Two lit rooms and a cave at −175 between them: a torch reads it. */
const CAVE: Route = {
  steps: [step('1/2'), step('1/3', -175), step('1/4')],
  cost: 3,
  blocked: false
} as Route;

const config = (over: Partial<AutomationConfig['movement']> = {}): AutomationConfig => ({
  ...DEFAULT_CONFIG.automation,
  enabled: true,
  movement: { ...DEFAULT_CONFIG.automation.movement, ...over }
});

function character(items: ItemEntity[], listed = true): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    inventory: { ...base.inventory, items, listedAt: listed ? 1 : null },
    sight: sightOf(0, carriedLights(items), true)
  };
}

const torchCarried = (over: Partial<ItemEntity> = {}): ItemEntity => ({
  ...wireItem('torch'),
  kind: 'light',
  abilities: [[54, 100]],
  ...over
});

const shop = (item: number): BuyingPlace & { item: number } => ({
  map: 1,
  room: 9,
  roomName: 'General Store',
  shop: 'General Store',
  markup: 0,
  detour: 2,
  moves: 4,
  item
});

let settings: AutomationConfig;
let collected: Array<{ items: readonly Wanted[]; owes: Route | null; run: boolean }>;
let collectRefusal: string | null;
let collecting: boolean;
let sold: RealmLight[];
let counters: Array<BuyingPlace & { item: number }>;
let lap: RouteStep[];
let notices: string[];
let decisions: SafetyDecision[];

const planner: LightPlanner = {
  lights: () => sold,
  counters: (items) => counters.filter((place) => items.includes(place.item)),
  lapSteps: () => lap,
  collect: (items, owes, run) => {
    collected.push({ items, owes, run });
    return collectRefusal;
  },
  collecting: () => collecting
};

const ahead = (): LightAhead =>
  new LightAhead(() => settings, planner, {
    notice: (message) => notices.push(message),
    decided: (decision) => decisions.push(decision)
  });

beforeEach(() => {
  settings = config();
  collected = [];
  collectRefusal = null;
  collecting = false;
  sold = [TORCH, LANTERN];
  counters = [shop(176), shop(175)];
  lap = [];
  notices = [];
  decisions = [];
});

describe('a route through the dark', () => {
  it('buys the light the counter least out of the way sells, then walks it', () => {
    expect(ahead().beforeRoute(CAVE, character([]), true)).toBe(true);
    expect(collected).toEqual([
      { items: [{ id: 176, name: 'lantern', count: 1, dark: true }], owes: CAVE, run: true }
    ]);
    expect(notices).toEqual([
      t('automation.lightAhead.buying', { dark: 1, item: 'lantern', count: 1 })
    ]);
    expect(decisions.at(-1)?.acted).toBe(true);
  });

  it('counts what the inventory already holds of it, so a spent one is bought over', () => {
    counters = [shop(175)];
    ahead().beforeRoute(CAVE, character([torchCarried({ charges: 0 })]), false);
    expect(collected[0]?.items).toEqual([{ id: 175, name: 'torch', count: 2, dark: true }]);
  });

  it('walks on with a usable light in the inventory, saying nothing', () => {
    expect(ahead().beforeRoute(CAVE, character([torchCarried()]), false)).toBe(false);
    expect(collected).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('walks on, saying nothing, through rooms the realm records no level for', () => {
    const lit = { ...CAVE, steps: [step('1/2'), step('1/4')] } as Route;
    expect(ahead().beforeRoute(lit, character([]), false)).toBe(false);
    expect(notices).toEqual([]);
  });

  it('does nothing while switched off, or while nothing readies a light', () => {
    settings = config({ buyLight: false });
    expect(ahead().beforeRoute(CAVE, character([]), false)).toBe(false);
    settings = config({ provideLight: false });
    expect(ahead().beforeRoute(CAVE, character([]), false)).toBe(false);
    expect(collected).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('says why and walks on: an unread inventory, nothing sold, no counter in reach', () => {
    expect(ahead().beforeRoute(CAVE, character([], false), false)).toBe(false);
    sold = [];
    expect(ahead().beforeRoute(CAVE, character([]), false)).toBe(false);
    sold = [TORCH, LANTERN];
    counters = [];
    expect(ahead().beforeRoute(CAVE, character([]), false)).toBe(false);
    expect(collected).toEqual([]);
    expect(notices).toEqual([
      t('automation.lightAhead.refusalUnlisted', { dark: 1 }),
      t('automation.lightAhead.refusalNothingSold', { dark: 1 }),
      t('automation.lightAhead.refusalNoShop', { dark: 1, items: 'torch, lantern' })
    ]);
    expect(decisions.every((decision) => !decision.acted)).toBe(true);
  });

  it('says the item trip refused, and walks on', () => {
    collectRefusal = 'Auto-Buy is off';
    expect(ahead().beforeRoute(CAVE, character([]), false)).toBe(false);
    expect(notices).toEqual([
      t('automation.lightAhead.refusalCollect', { why: 'Auto-Buy is off' })
    ]);
  });
});

describe('a lap through the dark', () => {
  const loop: Loop = { name: 'crypt', stops: [{ room: 'Crypt 1/3' }] };

  it('buys for one lap, walking nothing after', () => {
    lap = CAVE.steps;
    ahead().beforeLap(loop, character([]));
    expect(collected).toEqual([
      { items: [{ id: 176, name: 'lantern', count: 1, dark: true }], owes: null, run: false }
    ]);
  });

  it('leaves the item trip its own lap', () => {
    lap = CAVE.steps;
    collecting = true;
    ahead().beforeLap(loop, character([]));
    expect(collected).toEqual([]);
  });
});

describe('a trip that fetches before it walks', () => {
  it('hands its list the light, said only once the fetch answers', () => {
    const light = ahead();
    const fetch = light.wanted(CAVE, character([]));
    expect(fetch?.items).toEqual([{ id: 176, name: 'lantern', count: 1, dark: true }]);
    expect(collected).toEqual([]);
    expect(notices).toEqual([]);
    light.settle(fetch!, 'busy');
    expect(notices).toEqual([t('automation.lightAhead.refusalCollect', { why: 'busy' })]);
    expect(decisions.at(-1)).toMatchObject({ acted: false, refused: notices[0] });
    light.settle(fetch!, null);
    expect(notices.at(-1)).toBe(fetch!.said);
    expect(decisions.at(-1)?.acted).toBe(true);
  });
});
