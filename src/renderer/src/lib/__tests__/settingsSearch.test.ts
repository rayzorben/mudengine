import { describe, expect, it } from 'vitest';

import { judgeNamed, judgeSection, searches, type UnitText } from '../settingsSearch';

const recover: UnitText = {
  kind: 'group',
  text: 'Recover Rest below % Meditate below %',
  fields: ['Rest below %', 'Meditate below %'],
  settings: ['automation.health.restBelow', 'automation.health.restBelowMana']
};
const heal: UnitText = {
  kind: 'group',
  text: 'Healing Heal spell Heal below %',
  fields: ['Heal spell', 'Heal below %'],
  settings: ['automation.spells.heal', 'automation.spells.healBelow']
};
const loose: UnitText = {
  kind: 'row',
  text: 'Name Theme',
  fields: ['Name', 'Theme'],
  settings: ['', 'automation.loot.items']
};
const note: UnitText = {
  kind: 'other',
  text: 'Buffs and heals live in automation.rules',
  fields: [],
  settings: []
};

describe('finding a setting', () => {
  it('searches only once a word is typed', () => {
    expect(searches('')).toBe(false);
    expect(searches('   ')).toBe(false);
    expect(searches('heal')).toBe(true);
  });

  it('shows a fieldset whole when its words match, and marks the fields named', () => {
    const verdict = judgeSection('Spells', [recover, heal], 'heal');
    expect(verdict.shown).toBe(true);
    expect(verdict.units[0]).toEqual({ shown: false, fields: ['shown', 'shown'], units: [] });
    expect(verdict.units[1]).toEqual({ shown: true, fields: ['hit', 'hit'], units: [] });
  });

  it('keeps every word of the query, in any order and case', () => {
    const verdict = judgeSection('Health', [recover], 'MEDITATE below');
    expect(verdict.units[0]).toEqual({ shown: true, fields: ['shown', 'hit'], units: [] });
    expect(judgeSection('Health', [recover], 'meditate heal').shown).toBe(false);
  });

  it('shows a field outside a fieldset by itself', () => {
    const verdict = judgeSection('Character', [loose], 'theme');
    expect(verdict.units[0]).toEqual({ shown: true, fields: ['hidden', 'hit'], units: [] });
  });

  it('shows the whole section when its own name matches', () => {
    const verdict = judgeSection('Health', [recover, loose, note], 'health');
    expect(verdict.shown).toBe(true);
    expect(verdict.units.map((unit) => unit.shown)).toEqual([true, true, true]);
    expect(verdict.units[1]!.fields).toEqual(['shown', 'shown']);
  });

  it('judges a fieldset behind Advanced whole, and draws the toggle with it', () => {
    const toggle: UnitText = {
      kind: 'other',
      text: 'Advanced: the connection',
      fields: [],
      settings: []
    };
    const advanced: UnitText = { kind: 'nest', units: [toggle, recover, loose] };
    const verdict = judgeSection('Realm', [advanced], 'recover');
    expect(verdict.shown).toBe(true);
    expect(verdict.units[0]!.units.map((unit) => unit.shown)).toEqual([true, true, false]);
    // The toggle's own words name everything behind it.
    const named = judgeSection('Realm', [advanced], 'connection').units[0]!;
    expect(named.units.map((unit) => unit.shown)).toEqual([true, true, true]);
    expect(judgeSection('Realm', [advanced], 'retreat').units[0]!.shown).toBe(false);
  });

  it('hides a section nothing in answers', () => {
    const verdict = judgeSection('Party', [loose, note], 'retreat');
    expect(verdict.shown).toBe(false);
    expect(verdict.units.every((unit) => !unit.shown)).toBe(true);
  });
});

/* A console's gear opens the settings behind one decision (todo 119). */
describe('narrowing to the settings behind a decision', () => {
  it('shows a fieldset holding a named field whole, with only that field marked', () => {
    const verdict = judgeNamed([recover, heal, note], ['automation.spells.healBelow']);
    expect(verdict.shown).toBe(true);
    expect(verdict.units.map((unit) => unit.shown)).toEqual([false, true, false]);
    expect(verdict.units[1]!.fields).toEqual(['shown', 'hit']);
  });

  it('shows a field outside a fieldset only when it is named', () => {
    expect(judgeNamed([loose], ['automation.loot.items']).units[0]!.fields).toEqual([
      'hidden',
      'hit'
    ]);
  });

  it('opens a nest holding a named field, with its toggle, and hides a section holding none', () => {
    const toggle: UnitText = { kind: 'other', text: 'Advanced', fields: [], settings: [] };
    const verdict = judgeNamed(
      [{ kind: 'nest', units: [toggle, recover] }],
      ['automation.health.restBelow']
    );
    expect(verdict.units[0]!.units.map((unit) => unit.shown)).toEqual([true, true]);
    expect(judgeNamed([recover, loose], ['automation.spells.heal']).shown).toBe(false);
  });
});
