import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { GUARD_FIELDS, parseGuard } from '../../../shared/config';
import { readField } from '../RuleEngine';
import { EMPTY_CHARACTER } from '../../../shared/character';
import type { CharacterState, RoomOccupant } from '../../../shared/character';
import { wireItem } from '../../../shared/entities';

/**
 * A guard field is a **closed union with three halves**, and they only work
 * together:
 *
 * 1. the `GuardField` type in `shared/rules.ts`, which is what a caller writes;
 * 2. `GUARD_FIELDS` in `shared/config.ts`, which is what `parseGuard` accepts;
 * 3. the `case` labels in `readField`, which is what actually answers.
 *
 * A field in the type and the reader but not in the list type-checks, then
 * fails to *load* — the rule is dropped by the parser and the only symptom is
 * that it never fires. That is not hypothetical: `target`, `attackers`,
 * `players`, `hostiles` and `hangUpClean` were all added that way once, and
 * `realm` stayed that way for four phases, documented in the skill and
 * unusable in an options file.
 *
 * The type is erased at runtime, so both other halves are read out of their own
 * source rather than restated here. A third place to keep in step is the thing
 * this test exists to remove.
 */
function unionMembers(): string[] {
  const source = fs.readFileSync(path.resolve('src/shared/rules.ts'), 'utf8');
  const start = source.indexOf('export type GuardField =');
  const end = source.indexOf('export type Comparison');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/^\s*\|\s*'([\w.]+)'/gm)].map((match) => match[1]!);
}

function readerCases(): string[] {
  const source = fs.readFileSync(path.resolve('src/main/automation/RuleEngine.ts'), 'utf8');
  const start = source.indexOf('export function readField');
  const end = source.indexOf('export function testGuard');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/^\s*case '([\w.]+)':/gm)].map((match) => match[1]!);
}

describe('guard fields', () => {
  const declared = unionMembers();

  it('reads back as a non-trivial list', () => {
    expect(declared.length).toBeGreaterThan(15);
    expect(declared).toContain('hp.percent');
    expect(declared).toContain('realm');
  });

  it('declares, accepts and answers exactly the same set', () => {
    expect([...GUARD_FIELDS].sort()).toEqual([...declared].sort());
    expect(readerCases().sort()).toEqual([...declared].sort());
  });

  /*
   * The half a source scan cannot prove: that the parser really does take each
   * one. `parseGuard` returning null is how a rule vanishes silently.
   */
  it('parses a guard naming every field', () => {
    for (const field of GUARD_FIELDS) {
      expect(parseGuard(`${field} == 1`), field).not.toBeNull();
    }
  });

  /*
   * And that the reader answers with something rather than `undefined`, which
   * `testGuard` treats as "nobody has said" and fails every comparison but
   * `!=`. A field the reader cannot answer is a guard that never fires.
   */
  it('answers every field from a state that has all of them', () => {
    const state: CharacterState = {
      ...EMPTY_CHARACTER,
      realm: 'greatermud',
      stealth: 'sneaking',
      vitals: { ...EMPTY_CHARACTER.vitals, hp: 20, hpMax: 40, mana: 5, manaMax: 10 },
      progress: { ...EMPTY_CHARACTER.progress, level: 6 },
      combat: { ...EMPTY_CHARACTER.combat, target: 'giant rat' },
      inventory: { ...EMPTY_CHARACTER.inventory, wealth: 100 },
      /*
       * A room the realm has placed and said things about, because five of the
       * fields answer *only* from a placed room — `undefined` there is the
       * honest "the realm has not said", and this test is about a state that
       * has every fact rather than about the absences.
       */
      room: {
        ...EMPTY_CHARACTER.room,
        map: 1,
        number: 2,
        // The server's own light phrase, so `dark` has something to answer
        // from — it is unknown until the server or the realm says.
        light: 'pitch black',
        shop: { id: 3, kind: 'shop', name: 'Village Store', items: [] },
        lair: { max: 2, mobs: [] },
        occupants: [
          {
            name: 'giant rat',
            kind: 'mob',
            disposition: 'hostile',
            uncertain: false,
            costly: 'never',
            charmed: false,
            hidden: false,
            free: false,
            mob: {
              name: 'giant rat',
              rawName: 'giant rat',
              source: 'hybrid',
              charmed: false,
              disposition: 'hostile',
              uncertain: false,
              costly: 'never',
              hp: 12,
              undead: true,
              deathSpell: 99
            }
          }
        ]
      }
    };
    for (const field of GUARD_FIELDS) {
      expect(readField(field, state, { hangUpClean: true }), field).not.toBeUndefined();
    }
  });
});

/*
 * The five the room's entities made askable (2026-09-02).
 *
 * Each was already in the client's memory and unreachable from a rule: the
 * shop and the lair were IPC calls a card made, and the monster facts were
 * fields on a `WorldMob` that nothing joined to the occupant list — so a guard
 * could count how many things were in the room and could not ask whether any
 * of them was undead.
 */
describe('what the realm says about this room', () => {
  const mob = (over: Partial<NonNullable<RoomOccupant['mob']>> = {}): RoomOccupant => ({
    name: 'giant rat',
    kind: 'mob',
    disposition: 'hostile',
    uncertain: false,
    costly: 'never',
    charmed: false,
    hidden: false,
    free: false,
    mob: {
      name: 'giant rat',
      rawName: 'giant rat',
      source: 'hybrid',
      charmed: false,
      disposition: 'hostile',
      uncertain: false,
      costly: 'never',
      ...over
    }
  });

  const inRoom = (over: Partial<CharacterState['room']>): CharacterState => ({
    ...EMPTY_CHARACTER,
    room: { ...EMPTY_CHARACTER.room, map: 1, number: 2, ...over }
  });

  it('counts the undead and the things that cast on death', () => {
    const state = inRoom({
      occupants: [mob({ undead: true }), mob({ deathSpell: 99 }), mob()]
    });
    expect(readField('undeadHere', state)).toBe(1);
    expect(readField('deathSpellHere', state)).toBe(1);
  });

  /*
   * Zero would read as an empty room, so `toughestHere < 100` would fire in a
   * room full of things nothing has heard of — the reassuring answer this
   * client refuses. Unknown fails every comparison but `!=`.
   */
  it('answers unknown, never zero, when the realm can place none of them', () => {
    const unplaceable: RoomOccupant = {
      name: 'thing from the deep',
      kind: 'mob',
      disposition: null,
      uncertain: false,
      costly: 'never',
      charmed: false,
      hidden: false,
      free: false
    };
    expect(readField('toughestHere', inRoom({ occupants: [unplaceable] }))).toBeUndefined();
    expect(
      readField('toughestHere', inRoom({ occupants: [mob({ hp: 12 }), mob({ hp: 300 })] }))
    ).toBe(300);
  });

  /* Absent is *the realm has not said*, which is not the same as "no shop". */
  it('answers unknown for a room the realm has said nothing about', () => {
    expect(readField('shopHere', EMPTY_CHARACTER)).toBeUndefined();
    expect(readField('lairHere', EMPTY_CHARACTER)).toBeUndefined();
    expect(
      readField('shopHere', inRoom({ shop: { id: 3, kind: 'shop', name: 'X', items: [] } }))
    ).toBe(true);
    expect(readField('lairHere', inRoom({ lair: { max: 2, mobs: [] } }))).toBe(true);
  });
});

/*
 * Whether the character can see, and what it has to see by.
 *
 * `Walker` warns before stepping into a dark room and deliberately does not
 * act — *"if automatic lighting is wanted it belongs in `automation.rules`"* —
 * and until these two fields existed that was a decision with nowhere to go: a
 * guard could not ask whether it was dark, nor whether a torch was carried.
 */
describe('seeing where you are', () => {
  const lit = (over: Partial<CharacterState['room']>): CharacterState => ({
    ...EMPTY_CHARACTER,
    room: { ...EMPTY_CHARACTER.room, map: 1, number: 2, ...over }
  });

  /* The server's word is what actually happened, so it leads. */
  it('takes the server’s own phrase over the realm’s level', () => {
    expect(readField('dark', lit({ light: 'pitch black', lightLevel: 500 }))).toBe(true);
  });

  it('falls through to the realm’s level when the server printed nothing', () => {
    expect(readField('dark', lit({ lightLevel: -50 }))).toBe(true);
    expect(readField('dark', lit({ lightLevel: 100 }))).toBe(false);
  });

  /* Neither saying anything is unknown, not "lit": a guard must not fire in a
     room the client has merely not been told about. */
  it('answers unknown when neither has said', () => {
    expect(readField('dark', lit({}))).toBeUndefined();
  });

  describe('what there is to see by', () => {
    const carrying = (...items: Array<{ name: string; kind?: string; charges?: number }>) => ({
      ...EMPTY_CHARACTER,
      inventory: {
        ...EMPTY_CHARACTER.inventory,
        items: items.map((item) => ({
          ...wireItem(item.name, { charges: item.charges ?? null }),
          ...(item.kind === undefined ? {} : { kind: item.kind as 'light' })
        }))
      }
    });

    it('answers none with nothing that lights', () => {
      expect(readField('light', carrying({ name: 'rusty sword' }))).toBe('none');
    });

    /* Charges unstated is not zero — the listing simply did not count, and a
       rule fired on an unknown would light a torch that is already lit. */
    it('counts a torch the listing never counted as usable', () => {
      expect(readField('light', carrying({ name: 'torch', kind: 'light' }))).toBe('carried');
    });

    it('answers spent only when nothing usable was found', () => {
      expect(
        readField('light', carrying({ name: 'glowing pearl', kind: 'light', charges: 0 }))
      ).toBe('spent');
      expect(
        readField(
          'light',
          carrying(
            { name: 'glowing pearl', kind: 'light', charges: 0 },
            { name: 'torch', kind: 'light', charges: 79 }
          )
        )
      ).toBe('carried');
    });
  });
});
