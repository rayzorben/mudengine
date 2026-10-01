import { describe, expect, it } from 'vitest';

import type { KonamiBrief, SlotUpgrade } from '../konamiBrief';
import { projectRoad, withoutDeclined, type RoadInput } from '../konamiRoad';
import fixture from './konamiBrief.fixture.json';

const BEAR = { key: 'lair:1:80:', name: 'cave bear', expPerHour: 6000, copperPerHour: 100 };
const THUGS = { key: 'lair:1:6,10:', name: 'thug', expPerHour: 4000, copperPerHour: 6000 };

const robe = (item: number, copper: number, ac: number, minLevel: number) => ({
  item,
  name: `robe ${item}`,
  figure: ac,
  ac,
  dr: null,
  minLevel,
  shop: 'Tailor',
  at: { map: 1, room: 9 },
  moves: 4,
  copper
});

const TORSO: SlotUpgrade = {
  slot: 'Torso',
  worn: null,
  wornFigure: null,
  wornDr: null,
  ranking: 'armour',
  offers: [robe(1, 100, 20, 0), robe(2, 20_000, 60, 4)]
};

/** A level-2 character with nothing, as Soul was: training at 50, then 100, 150… */
function input(over: Partial<RoadInput> = {}): RoadInput {
  return {
    level: 2,
    exp: 900,
    copper: 0,
    thresholds: [
      { level: 3, exp: 1_000 },
      { level: 4, exp: 4_000 },
      { level: 5, exp: 10_000 },
      { level: 6, exp: 20_000 }
    ],
    trainCosts: [2, 3, 4, 5, 6].map((level) => ({ level, copper: (level - 1) * 50 })),
    grounds: [BEAR, THUGS],
    gear: [TORSO],
    declined: new Set(),
    steps: 20,
    ...over
  };
}

const kinds = (road: ReturnType<typeof projectRoad>) =>
  road.steps.map((step) =>
    step.kind === 'train'
      ? `train ${step.level}`
      : step.kind === 'buy'
        ? `buy ${step.goal.name}`
        : `hunt ${step.goal.name} to ${'level' in step.until ? `level ${step.until.level}` : `${step.until.copper} copper`}`
  );

describe('the road ahead', () => {
  it('hunts to each level, trains it, and buys what the level and the purse allow', () => {
    const road = projectRoad(input());
    expect(kinds(road)).toEqual([
      // The robe for 100 and the training after it are owed, more than the bear pays: thugs.
      'hunt thug to level 3',
      'train 3',
      'hunt thug to level 4',
      'train 4',
      // Bought once the training at 4 is still covered after it.
      'buy robe 1',
      // Saving toward the robe for 20,000, wearable from 4.
      'hunt thug to level 5',
      'train 5',
      'hunt thug to level 6',
      'train 6'
    ]);
    expect(road.end).toBe('table');
  });

  it('hunts for the exp alone once nothing wanted is short', () => {
    const road = projectRoad(input({ copper: 100_000, gear: [] }));
    expect(kinds(road)[0]).toBe('hunt cave bear to level 3');
  });

  it('hunts where the coin is while a level is ready and the trainer is not paid for', () => {
    const road = projectRoad(input({ exp: 1_200, grounds: [BEAR, THUGS] }));
    expect(kinds(road).slice(0, 2)).toEqual(['hunt thug to 50 copper', 'train 3']);
  });

  it('counts the hours from now, each goal starting where the last ended', () => {
    const road = projectRoad(input());
    const hunts = road.steps.filter((step) => step.kind === 'hunt');
    expect(hunts[0]!.at).toBe(0);
    expect(hunts[1]!.at).toBeCloseTo(hunts[0]!.hours, 6);
  });

  it('leaves off what the player declined', () => {
    const road = projectRoad(
      input({ copper: 100_000, declined: new Set(['hunt:lair:1:6,10:', 'buy:1']) })
    );
    const names = kinds(road).join(' / ');
    expect(names).not.toContain('thug');
    expect(names).not.toContain('robe 1');
    expect(names).toContain('buy robe 2');
  });

  it('stops at the most steps, at the end of the table, and with nowhere to hunt', () => {
    expect(projectRoad(input({ steps: 3 })).steps).toHaveLength(3);
    expect(projectRoad(input({ grounds: [] })).end).toBe('grounds');
    expect(projectRoad(input({ trainCosts: [] })).end).toBe('trainer');
  });

  it('never buys what is no better than what the road already wears', () => {
    const worse = { ...TORSO, offers: [robe(3, 10, 5, 0), robe(4, 10, 4, 0)] };
    const road = projectRoad(input({ copper: 1_000, gear: [worse] }));
    expect(kinds(road).filter((step) => step.startsWith('buy'))).toEqual(['buy robe 3']);
  });
});

describe('what the road does not know', () => {
  it('never hunts a ground for copper it is not known to pay, and says the copper is unknown', () => {
    const unknown = { ...THUGS, copperPerHour: null };
    const road = projectRoad(input({ exp: 1_200, grounds: [BEAR, unknown] }));
    expect(kinds(road)[0]).toBe('hunt cave bear to 50 copper');
    const level = projectRoad(input({ copper: 100_000, gear: [], grounds: [unknown] }));
    expect(level.steps[0]).toMatchObject({ kind: 'hunt', copper: null });
  });

  it('ends where no ground is known to pay the copper a level needs', () => {
    const road = projectRoad(input({ exp: 1_200, grounds: [{ ...BEAR, copperPerHour: null }] }));
    expect(road).toEqual({ steps: [], end: 'grounds' });
  });
});

describe('what the provider is offered', () => {
  it('leaves out the grounds and items the player declined', () => {
    const brief = fixture as unknown as KonamiBrief;
    const declined = new Set([`hunt:${brief.hunting.spots[0]!.key}`]);
    const item = brief.gear.find((slot) => slot.offers.length > 0)!.offers[0]!.item;
    declined.add(`buy:${item}`);
    const left = withoutDeclined(brief, declined);
    expect(left.hunting.spots.map((spot) => spot.key)).not.toContain(brief.hunting.spots[0]!.key);
    expect(left.gear.flatMap((slot) => slot.offers.map((offer) => offer.item))).not.toContain(item);
    expect(withoutDeclined(brief, new Set())).toBe(brief);
  });
});
