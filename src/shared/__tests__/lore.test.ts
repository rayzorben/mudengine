import { describe, expect, it } from 'vitest';

import { emptyLore, learn, learnSlot, loreMaximum } from '../lore';

/**
 * The estimator is a minimum, and the reason is arithmetic: total damage to
 * kill is always at least the monster's maximum health, so every fight gives an
 * upper bound and the least one seen is the tightest. Its one failure mode is
 * an undercount, and `survived` is what corrects one.
 */
describe('learning how much health a monster has', () => {
  const at = 1_000;

  it('takes the first kill as the estimate', () => {
    const entry = learn(undefined, { damage: 120, killed: true, at });
    expect(entry.kill).toBe(120);
    expect(entry.kills).toBe(1);
    expect(loreMaximum(entry)).toBe(120);
  });

  it('tightens towards the truth rather than averaging away from it', () => {
    let entry = learn(undefined, { damage: 160, killed: true, at });
    entry = learn(entry, { damage: 118, killed: true, at });
    entry = learn(entry, { damage: 140, killed: true, at });
    expect(entry.kill).toBe(118);
    expect(entry.kills).toBe(3);
  });

  it('knows nothing until something has actually died', () => {
    const entry = learn(undefined, { damage: 90, killed: false, at });
    // A floor is not a maximum. A card with this shows a damage tally and no
    // bar, which is the honest rendering of "still standing after 90".
    expect(entry.kill).toBeNull();
    expect(entry.survived).toBe(90);
    expect(loreMaximum(entry)).toBeNull();
  });

  /*
   * The undercount, and the correction. Land the last blow on somebody else's
   * fight and the total this client saw is far below the truth — and a minimum
   * estimator keeps it for good. A later fight in which the same monster
   * absorbed more and lived proves the entry wrong, and outranks it.
   */
  it('lets a survival overrule a kill total that was too low', () => {
    let entry = learn(undefined, { damage: 30, killed: true, at });
    expect(loreMaximum(entry)).toBe(30);
    entry = learn(entry, { damage: 210, killed: false, at });
    expect(loreMaximum(entry)).toBe(210);
  });

  it('only ever raises the floor', () => {
    let entry = learn(undefined, { damage: 200, killed: false, at });
    entry = learn(entry, { damage: 40, killed: false, at });
    expect(entry.survived).toBe(200);
  });

  /* Identity is what tells the store whether the disk needs touching. */
  it('returns the entry unchanged when nothing was learned', () => {
    const before = learn(undefined, { damage: 200, killed: false, at });
    expect(learn(before, { damage: 40, killed: false, at })).toBe(before);
    expect(learn(before, { damage: 0, killed: true, at })).toBe(before);
  });

  it('learns nothing from a monster that died without a blow landing', () => {
    // Killed by something this client could not see. A zero is not a bound.
    expect(learn(undefined, { damage: 0, killed: true, at })).toEqual(emptyLore());
  });
});

/*
 * A listing names an item and the slot it sits in; the realm names the item's
 * `Worn` code; together they teach what the server prints for the code. The
 * answer is a word only while every listing has agreed on one — two words for
 * one code is not a majority vote, it is the realm printing differently for
 * items the code alone does not distinguish.
 */
describe('learning what the listing calls a worn slot', () => {
  const at = 1_000;

  it('knows the word after one listing', () => {
    const entry = learnSlot(undefined, 'Feet', at);
    expect(entry?.words).toEqual(['Feet']);
  });

  it('teaches nothing from an empty word, and keeps the entry it was given', () => {
    const entry = learnSlot(undefined, 'Feet', at);
    expect(learnSlot(entry, '   ', at + 1)).toBe(entry);
    expect(learnSlot(undefined, '', at)).toBeUndefined();
  });

  it('returns its input when the word is already known, so nothing is rewritten', () => {
    const entry = learnSlot(undefined, 'Feet', at);
    expect(learnSlot(entry, 'Feet', at + 1)).toBe(entry);
  });

  it('refuses to choose once two listings disagree', () => {
    let entry = learnSlot(undefined, 'Feet', at);
    entry = learnSlot(entry, 'Boots', at + 1);
    expect(entry?.words).toEqual(['Boots', 'Feet']);
  });

  it('knows nothing before any listing', () => {
    expect(learnSlot(undefined, '', at)).toBeUndefined();
  });
});
