import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../config';
import {
  asGearWeights,
  GEAR_WEIGHT_FIELDS,
  gearFiguresOf,
  gearTrade,
  tradeWords,
  weighedWorth,
  type GearWeighing,
  type GearWeights
} from '../gearWeighing';

/** gmud.zip item 499 and 1067, as the world format carries them (todo 117). */
const CHALICE = {
  abilities: [
    [135, 10],
    [4, 2],
    [24, 5],
    [69, 10],
    [145, 10],
    [111, 0]
  ] as const
};
const SHIELD = {
  armour: { ac: 75, dr: 7 },
  abilities: [
    [27, -5],
    [137, 3051],
    [72, 3],
    [135, 25]
  ] as const
};

const weighing = (over: Partial<GearWeighing> = {}): GearWeighing => ({
  weights: DEFAULT_CONFIG.automation.loot.gearWeights,
  casts: true,
  sneaks: false,
  ...over
});

describe('an item weighed by its abilities as well as its AC', () => {
  it('puts the golden chalice above the crimson spiked shield for a caster', () => {
    const chalice = weighedWorth(gearFiguresOf(CHALICE), weighing());
    const shield = weighedWorth(gearFiguresOf(SHIELD), weighing());
    expect(chalice).toBe(50 + 20 + 20 + 20);
    expect(shield).toBe(75 + 7 + 15);
    expect(chalice).toBeGreaterThan(shield);
  });

  it('counts mana only for a class that casts, and Stealth only while sneaking', () => {
    expect(weighedWorth(gearFiguresOf(CHALICE), weighing({ casts: false }))).toBe(70);
    expect(weighedWorth(gearFiguresOf(SHIELD), weighing({ sneaks: true }))).toBe(97 - 50);
  });

  it('with every weight at 0 ranks by AC alone, as before', () => {
    const none = Object.fromEntries(GEAR_WEIGHT_FIELDS.map((field) => [field, 0])) as GearWeights;
    expect(weighedWorth(gearFiguresOf(CHALICE), weighing({ weights: none }))).toBe(0);
    expect(weighedWorth(gearFiguresOf(SHIELD), weighing({ weights: none }))).toBe(75);
  });

  it('says what a swap gains and gives up, in the realm ability names', () => {
    const trade = gearTrade(gearFiguresOf(SHIELD), gearFiguresOf(CHALICE), weighing());
    expect(tradeWords(trade.gained)).toBe('AC +75, DR +7, ShockShield +3');
    expect(tradeWords(trade.lost)).toBe('ProtEvil -5, MaxDamage -2, MaxMana -10, ManaRgn -10');
  });

  it('reads a weight the file breaks as the fallback, and bounds the rest', () => {
    const read = asGearWeights(
      { maxDamage: 'lots', stealth: -4, maxHp: 99999 },
      DEFAULT_CONFIG.automation.loot.gearWeights
    );
    expect(read.maxDamage).toBe(DEFAULT_CONFIG.automation.loot.gearWeights.maxDamage);
    expect(read.stealth).toBe(0);
    expect(read.maxHp).toBe(1000);
  });
});
