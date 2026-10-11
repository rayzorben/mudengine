import { describe, expect, it } from 'vitest';

import { DISPELL_MAGIC_ABILITY, HAZARD_ABILITY } from '../../../shared/abilities';
import { spellNegates, type NegateRow } from '../navigation/scriptNegates';
import { readLines } from '../navigation/textblock';

const blocks = (rows: Record<number, string>) =>
  new Map(
    Object.entries(rows).map(([id, action]) => [
      Number(id),
      { lines: readLines(action), linkTo: null }
    ])
  );

/*
 * Spell 310 is negate magic (`DispellMagic` 0, friendly); 5054 the token of
 * Silvermere's spell, which runs block 3281; 87 cure blindness, which takes
 * off only what grants blindness; 8 a negate cast at monsters.
 */
const ROWS: Record<number, NegateRow> = {
  310: { abilities: [[DISPELL_MAGIC_ABILITY, 0]], targets: 2 },
  5054: { abilities: [[HAZARD_ABILITY.textBlock, 3281]], targets: 1 },
  87: { abilities: [[DISPELL_MAGIC_ABILITY, 107]], targets: 2 },
  8: { abilities: [[DISPELL_MAGIC_ABILITY, 0]], targets: 8 },
  9: { abilities: [[HAZARD_ABILITY.textBlock, 90]], targets: 1 }
};
const rows = (spell: number) => ROWS[spell];

/* gmud.zip and pmud.zip, `TBInfo` 3281. */
const TOKEN =
  'minlevel 25 3507:nomonsters 3509:failroomitem 3391:price 200000 4146:message 3505:' +
  'adddelay 10:cast 310:teleport 1813 1:message 3508';

describe('a spell that takes every spell off whoever it is cast on', () => {
  it('is negate magic itself', () => {
    expect(spellNegates(310, rows, blocks({}))).toBe(true);
  });

  it('is a token whose script casts negate magic ahead of its teleport', () => {
    expect(spellNegates(5054, rows, blocks({ 3281: TOKEN }))).toBe(true);
  });

  it('is not a dispel that takes off only the spells granting one ability', () => {
    expect(spellNegates(87, rows, blocks({}))).toBe(false);
  });

  it('is not a script whose negate is cast at monsters, nor one that casts none', () => {
    expect(spellNegates(9, rows, blocks({ 90: 'cast 8' }))).toBe(false);
    expect(spellNegates(9, rows, blocks({ 90: 'teleport 1813 1' }))).toBe(false);
    // The positive control on the same block id: a negate cast on the player.
    expect(spellNegates(9, rows, blocks({ 90: 'cast 310' }))).toBe(true);
  });

  it('follows a block the script hands the run to', () => {
    expect(spellNegates(9, rows, blocks({ 90: 'random 91', 91: '100:cast 310' }))).toBe(true);
  });
});
