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
import type { BuyingPlace, RouteStep } from '../../../shared/world';
import { noticeLog, type NoticeLog } from './noticeLog';

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
const CAVE: RouteStep[] = [step('1/2'), step('1/3', -175), step('1/4')];

const LOOP: Loop = { name: 'crypt', stops: [{ room: 'Crypt 1/3' }] };

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
let collected: Array<readonly Wanted[]>;
let collectRefusal: string | null;
let collecting: boolean;
let sold: RealmLight[];
let counters: Array<BuyingPlace & { item: number }>;
let lap: readonly RouteStep[];
let notices: string[];
let log: NoticeLog;
let decisions: SafetyDecision[];

const planner: LightPlanner = {
  lights: () => sold,
  counters: (items) => counters.filter((place) => items.includes(place.item)),
  lapSteps: () => lap,
  collect: (items) => {
    collected.push(items);
    return collectRefusal;
  },
  collecting: () => collecting
};

const ahead = (): LightAhead =>
  new LightAhead(() => settings, planner, {
    notice: log.notice,
    decided: (decision) => decisions.push(decision)
  });

/** One lap over `steps` starting with `state`. */
const loopOver = (steps: readonly RouteStep[], state: CharacterState, light = ahead()): void => {
  lap = steps;
  light.beforeLap(LOOP, state);
};

beforeEach(() => {
  settings = config();
  collected = [];
  collectRefusal = null;
  collecting = false;
  sold = [TORCH, LANTERN];
  counters = [shop(176), shop(175)];
  lap = [];
  log = noticeLog();
  notices = log.notices;
  decisions = [];
});

describe('a lap through the dark', () => {
  it('buys the light the nearest counter sells', () => {
    loopOver(CAVE, character([]));
    expect(collected).toEqual([[{ id: 176, name: 'lantern', count: 1, dark: true }]]);
    expect(notices).toEqual([
      t('automation.lightAhead.buying', { dark: 1, item: 'lantern', count: 1 })
    ]);
    expect(log.kinds).toEqual(['light-buy']);
    expect(decisions.at(-1)?.acted).toBe(true);
  });

  it('counts what the inventory already holds of it, so a spent one is bought over', () => {
    counters = [shop(175)];
    loopOver(CAVE, character([torchCarried({ charges: 0 })]));
    expect(collected[0]).toEqual([{ id: 175, name: 'torch', count: 2, dark: true }]);
  });

  it('loops with a usable light in the inventory, saying nothing', () => {
    loopOver(CAVE, character([torchCarried()]));
    expect(collected).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('says nothing through rooms the realm records no level for', () => {
    loopOver([step('1/2'), step('1/4')], character([]));
    expect(notices).toEqual([]);
  });

  it('does nothing while switched off, or while nothing readies a light', () => {
    settings = config({ buyLight: false });
    loopOver(CAVE, character([]));
    settings = config({ provideLight: false });
    loopOver(CAVE, character([]));
    expect(collected).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('says why and loops on: an unread inventory, nothing sold, no counter in reach', () => {
    loopOver(CAVE, character([], false));
    sold = [];
    loopOver(CAVE, character([]));
    sold = [TORCH, LANTERN];
    counters = [];
    loopOver(CAVE, character([]));
    expect(collected).toEqual([]);
    expect(notices).toEqual([
      t('automation.lightAhead.refusalUnlisted', { dark: 1 }),
      t('automation.lightAhead.refusalNothingSold', { dark: 1 }),
      t('automation.lightAhead.refusalNoShop', { dark: 1, items: 'torch, lantern' })
    ]);
    expect(decisions.every((decision) => !decision.acted)).toBe(true);
  });

  it('names the carried light that is not bright enough', () => {
    loopOver([step('1/2'), step('1/3', -260)], character([torchCarried()]));
    expect(collected[0]).toEqual([{ id: 176, name: 'lantern', count: 1, dark: true }]);
    expect(notices).toEqual([
      t('automation.lightAhead.buyingBrighter', {
        dark: 1,
        carried: 'torch',
        reach: 100,
        want: 110,
        item: 'lantern',
        count: 1
      })
    ]);
  });

  it('says the item trip refused', () => {
    collectRefusal = 'Auto-Buy is off';
    loopOver(CAVE, character([]));
    expect(notices).toEqual([
      t('automation.lightAhead.refusalCollect', { why: 'Auto-Buy is off' })
    ]);
  });

  it('leaves the item trip its own lap', () => {
    collecting = true;
    loopOver(CAVE, character([]));
    expect(collected).toEqual([]);
  });
});

/**
 * Festus, 2026-11-13: the way to Frozen Cavern, Cave Opening crosses the
 * Dark Hole drop at −375 with a brass lamp (175) carried, and the client went
 * 2,561 steps for a mirrored lantern (225). A room past lighting is left out.
 */
describe('rooms past lighting', () => {
  const MIRRORED: RealmLight = { id: 1200, name: 'mirrored lantern', reach: 225, uses: 2400 };
  const lamp: ItemEntity = { ...wireItem('brass lamp'), kind: 'light', abilities: [[54, 175]] };
  const cavern = [step('10/201', -175), step('10/276', -375), step('10/277', -375)];

  beforeEach(() => {
    sold = [TORCH, LANTERN, MIRRORED];
    counters = [shop(1200), shop(176)];
  });

  it('buys nothing for them when the carried light reads the rest', () => {
    loopOver(cavern, character([lamp]));
    expect(collected).toEqual([]);
    expect(notices).toEqual([]);
  });

  // Positive control: one step brighter than the line, the lantern is bought.
  it('buys for a room at the line', () => {
    loopOver([step('10/201', -175), step('9/1', -350)], character([lamp]));
    expect(collected[0]).toMatchObject([{ id: 1200 }]);
  });

  it('says nothing for a lap with only rooms past lighting', () => {
    loopOver([step('7/1', -999)], character([]));
    expect(collected).toEqual([]);
    expect(notices).toEqual([]);
  });
});

/**
 * Brakkle, 2026-10-10: Musty Grottos at −200 under `lightDimRooms`, a brass
 * lamp (175) carried. It reads every room as dimly lit, so the moon-lamp
 * (200) 1,816 steps off is named, never bought.
 */
describe('rooms a carried light leaves dimly lit', () => {
  const MOON_LAMP: RealmLight = { id: 1153, name: 'moon-lamp', reach: 200, uses: null };
  const lamp: ItemEntity = { ...wireItem('brass lamp'), kind: 'light', abilities: [[54, 175]] };
  const grottos = [step('1/9450', -200), step('1/9459', -200), step('1/9460', -200)];

  beforeEach(() => {
    sold = [TORCH, LANTERN, MOON_LAMP];
    counters = [shop(1153)];
  });

  it('buys nothing for them, and says once what would light them', () => {
    settings = config({ lightDimRooms: true });
    const light = ahead();
    loopOver(grottos, character([lamp]), light);
    loopOver(grottos, character([lamp]), light);
    expect(collected).toEqual([]);
    expect(notices).toEqual([t('automation.lightAhead.dimOnly', { dim: 3, items: 'moon-lamp' })]);
    expect(decisions.map((decision) => decision.acted)).toEqual([false]);
  });

  it('says how many stay dim where nothing sold lights them fully', () => {
    settings = config({ lightDimRooms: true });
    sold = [TORCH, LANTERN];
    loopOver([...grottos, step('1/9461', -150)], character([torchCarried()]));
    expect(collected).toEqual([]);
    expect(notices).toEqual([
      t('automation.lightAhead.dimOnlyShort', { dim: 4, items: 'lantern', unlit: 3 })
    ]);
  });

  it('says nothing about them with the setting off', () => {
    loopOver(grottos, character([lamp]));
    expect(collected).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('still buys where nothing carried reads them', () => {
    settings = config({ lightDimRooms: true });
    loopOver(grottos, character([]));
    expect(collected[0]).toMatchObject([{ id: 1153 }]);
  });
});
