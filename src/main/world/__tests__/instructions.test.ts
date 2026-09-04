import { describe, expect, it } from 'vitest';

import { parseInstruction } from '../instructions';

/**
 * Every string here was taken from the realm database, not invented. The
 * vocabulary was surveyed with a `SELECT DISTINCT` over all ten exit columns
 * before any of this was written.
 */
describe('parseInstruction', () => {
  it('returns null for no instruction', () => {
    expect(parseInstruction(undefined)).toBeNull();
    expect(parseInstruction('')).toBeNull();
    expect(parseInstruction('   ')).toBeNull();
  });

  it('reads a plain door', () => {
    expect(parseInstruction('Door')).toMatchObject({ kind: 'door', raw: 'Door' });
  });

  it('reads a door with a pick difficulty', () => {
    const r = parseInstruction('Door [1000 picklocks/strength]');
    expect(r).toMatchObject({ kind: 'door', pickDifficulty: 1000 });
  });

  it('reads a door pickable by any skill at all', () => {
    expect(parseInstruction('Door [any picklocks/strength]')?.pickDifficulty).toBe(0);
    expect(parseInstruction('Door [any picklocks/strength]')?.bashDifficulty).toBe(0);
  });

  /*
   * The bracket comes in two shapes and they are not the same fact. 89 exits
   * in the shipped realm say `[or N picklocks]` with no `/strength` at all —
   * every one of them read as *no skill substitutes for the key*, because the
   * pattern that looked for them required the word the realm had left out.
   */
  it('separates a lock only picklocks open from one strength opens too', () => {
    const both = parseInstruction('Door [41 picklocks/strength]');
    expect(both).toMatchObject({ pickDifficulty: 41, bashDifficulty: 41 });

    const pickOnly = parseInstruction('Key: 2126 [or 157 picklocks]');
    expect(pickOnly).toMatchObject({ kind: 'key', keyId: 2126, pickDifficulty: 157 });
    expect(pickOnly?.bashDifficulty).toBeUndefined();

    expect(parseInstruction('Key: 1416 [or any picklocks]')?.pickDifficulty).toBe(0);
    expect(parseInstruction('Key: 1416 [or any picklocks]')?.bashDifficulty).toBeUndefined();
  });

  it('reads a keyed door and the skill that substitutes for the key', () => {
    const r = parseInstruction('Key: 1124 [or 301 picklocks/strength]');
    expect(r).toMatchObject({ kind: 'key', keyId: 1124, pickDifficulty: 301, bashDifficulty: 301 });
  });

  /*
   * Both ends can be written as "unset", with two different sentinels, and
   * taking either literally is a routing bug rather than a wording one: a
   * maximum of 0 refuses everybody, and four exits in the shipped realm say
   * `Level: 37 to 0`. See the note in `instructions.ts` for the whole survey.
   */
  it('reads a level range, and both ways of writing no limit', () => {
    expect(parseInstruction('Level: 66 to 255')).toMatchObject({
      kind: 'level',
      minLevel: 66,
      maxLevel: 255
    });
    // `999` at the top is no ceiling — seven exits in the shipped realm.
    expect(parseInstruction('Level: 10 to 999')).toEqual({
      kind: 'level',
      raw: 'Level: 10 to 999',
      minLevel: 10
    });
    // A zero at either end is the realm leaving it unset.
    expect(parseInstruction('Level: 0 to 5')).toEqual({
      kind: 'level',
      raw: 'Level: 0 to 5',
      maxLevel: 5
    });
    expect(parseInstruction('Level: 37 to 0')).toEqual({
      kind: 'level',
      raw: 'Level: 37 to 0',
      minLevel: 37
    });
    // And `0 to 0` is no gate at all, which is what two exits in the shipped
    // realm mean by it — read literally they admitted nobody.
    expect(parseInstruction('Level: 0 to 0')).toEqual({ kind: 'level', raw: 'Level: 0 to 0' });
  });

  it('reads the command list from a Text exit', () => {
    // The most important case: these exits are not walked with a direction at
    // all, so a route that emits `w` here simply does not work.
    const r = parseInstruction('Text: go crimson, enter crimson, go crimson portal');
    expect(r?.kind).toBe('text');
    expect(r?.commands).toEqual(['go crimson', 'enter crimson', 'go crimson portal']);
  });

  it('reads trap damage', () => {
    expect(parseInstruction('Trap, 30 damage')).toMatchObject({ kind: 'trap', damage: 30 });
  });

  it('distinguishes a searchable hidden exit from one that needs actions', () => {
    expect(parseInstruction('Hidden/Searchable')).toMatchObject({
      kind: 'hidden',
      searchable: true
    });
    expect(parseInstruction('Hidden/Needs 2 Actions, any order')).toMatchObject({
      kind: 'hidden',
      searchable: false
    });
    expect(parseInstruction('Hidden/Unknown')?.searchable).toBe(false);
  });

  it('classifies the remaining kinds seen in the data', () => {
    const cases: Array<[string, string]> = [
      ['Toll', 'toll'],
      ['Item', 'item'],
      ['Ticket/Item', 'item'],
      ['Class', 'class'],
      ['Race', 'race'],
      ['Alignment', 'alignment'],
      ['Ability', 'ability'],
      ['Cast', 'cast'],
      ['Spell', 'spell'],
      ['Timed', 'timed']
    ];
    for (const [raw, kind] of cases) {
      expect(parseInstruction(raw)?.kind, raw).toBe(kind);
    }
  });

  it('keeps an unrecognised instruction rather than dropping it', () => {
    // Dropping it would turn a gated exit into a free one, which is the more
    // dangerous error: a route would walk the player into a wall and stall.
    const r = parseInstruction('Something The Exporter Invented');
    expect(r?.kind).toBe('unknown');
    expect(r?.raw).toBe('Something The Exporter Invented');
  });
});

/*
 * The toll's price, and its unit.
 *
 * The realm writes a bare number; the wire says what it means. `Toll: 5` on the
 * Town Gates answered `You do not have enough to cover the toll of 5 gold
 * crowns.` against a purse of `0 copper farthings` (player session log,
 * 2026-08-30), so the number is gold and is stored as copper — the unit
 * `Traveller.wealth` is counted in.
 */
describe('what a toll charges', () => {
  it('reads the amount and converts it out of gold', () => {
    expect(parseInstruction('Toll: 5')?.tollCopper).toBe(500);
    expect(parseInstruction('Toll: 10000')?.tollCopper).toBe(1_000_000);
  });

  /* Zero is an answer, and absent is not: a gate that charges nothing must not
     read as one whose price the realm failed to record. */
  it('keeps a toll of nothing as nothing', () => {
    expect(parseInstruction('Toll: 0')?.tollCopper).toBe(0);
  });

  it('leaves the price absent when the realm states none', () => {
    expect(parseInstruction('Toll')?.tollCopper).toBeUndefined();
  });
});
