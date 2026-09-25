import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { blockOf } from '../../../shared/__tests__/blocks';
import { isProcHousekeeping, readsAsProc } from '../proc';

/*
 * The order a proc is decided in (todo 700: *order is a decision*): the line's
 * own evidence first, then the realm's (the equipped kit), and the fight's
 * binding last and only when both allow it. The tracker's tests play whole
 * rounds and read the ledger, which cannot see which of the three was asked
 * first. So these hand `readsAsProc` a binding that writes down each time it
 * is asked.
 */

const T = 1_700_000_000_000;
const SPARK = 'A shining spark strikes cave worm for 3 damage!';

/** `PercentSpell` 40 then `CastsSp` 12: a weapon that fires one proc. */
const PROC_WEAPON: CarriedItem = {
  name: 'shimmering longsword',
  count: 1,
  equipped: true,
  slot: 'Weapon',
  abilities: [
    [114, 40],
    [43, 12]
  ]
} as CarriedItem;

/** Carrying `items`. */
function holding(...items: CarriedItem[]): CharacterState {
  const s = structuredClone(EMPTY_CHARACTER);
  return { ...s, phase: 'in-game', inventory: { ...s.inventory, items } };
}

/** A fight binding that answers `struck`, and the questions it was asked. */
function binding(struck: boolean): {
  asked: string[];
  fight: { justStruck(name: string, at: number, allowance: number): boolean };
} {
  const asked: string[] = [];
  return {
    asked,
    fight: {
      justStruck: (name, at, allowance) => {
        asked.push(`${name} @${at} ×${allowance}`);
        return struck;
      }
    }
  };
}

describe('the order a proc is decided in', () => {
  it('asks the binding last, with the kit’s allowance, for a line that names nobody', () => {
    const { asked, fight } = binding(true);
    const line = blockOf('user-hits', SPARK, { target: 'cave worm', damage: '3' }, T);
    expect(readsAsProc(line, holding(PROC_WEAPON), fight)).toBe(true);
    expect(asked).toEqual([`cave worm @${T} ×1`]);
  });

  it('never asks the binding about a line that names its attacker, or lands on this character', () => {
    const { asked, fight } = binding(true);
    const named = blockOf('user-hits', SPARK, { attacker: 'Vulcan', target: 'cave worm' }, T);
    const onMe = blockOf('user-hits', 'A shining spark strikes you!', { target: 'you' }, T);
    const other = blockOf('mob-hits', SPARK, { target: 'cave worm' }, T);
    for (const line of [named, onMe, other]) {
      expect(readsAsProc(line, holding(PROC_WEAPON), fight)).toBe(false);
    }
    expect(asked).toEqual([]);
  });

  it('never asks the binding when nothing equipped fires one', () => {
    const { asked, fight } = binding(true);
    const line = blockOf('user-hits', SPARK, { target: 'cave worm' }, T);
    const sheathed = { ...PROC_WEAPON, equipped: false };
    expect(readsAsProc(line, holding(sheathed), fight)).toBe(false);
    expect(readsAsProc(line, holding(), fight)).toBe(false);
    expect(asked).toEqual([]);
  });

  it('declines when the binding does', () => {
    const { fight } = binding(false);
    const line = blockOf('user-hits', SPARK, { target: 'cave worm' }, T);
    expect(readsAsProc(line, holding(PROC_WEAPON), fight)).toBe(false);
  });
});

describe('what may sit between a blow and its proc', () => {
  it('is the prompt and a blank line, and nothing with words in it', () => {
    expect(isProcHousekeeping(blockOf('status-line', '[HP=10/20]:', {}, T))).toBe(true);
    expect(isProcHousekeeping(blockOf('unknown', '  ', {}, T))).toBe(true);
    expect(isProcHousekeeping(blockOf('unknown', 'Vulcan makes a gesture!', {}, T))).toBe(false);
    expect(isProcHousekeeping(blockOf('room-exits', 'Obvious exits: none', {}, T))).toBe(false);
  });
});
