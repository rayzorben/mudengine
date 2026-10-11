import { describe, expect, it } from 'vitest';

import type { Block } from '../../../shared/blocks';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import type { MobEntity } from '../../../shared/entities';
import { Classifier } from '../Classifier';
import { keepsProcBinding } from '../proc';
import { readsAsShield } from '../shield';

/*
 * A monster's damage shield on the wire (todo 56). The sentences are the
 * `ShockMsg` rows' second lines in resources/world/messages.csv; the binding
 * is this character's last named blow (`FightTracker.struckJustNow`).
 */

const AT = 1_700_000_000_000;

function line(text: string): Block {
  return new Classifier().classify({ seq: 1, at: AT, text, plain: text, terminator: 'newline' })
    .block;
}

function standingWith(name: string, abilities: Array<[number, number]>): CharacterState {
  const mob = { name, rawName: name, abilities } as unknown as MobEntity;
  const occupant = { name, kind: 'mob', mob } as unknown as RoomOccupant;
  return { ...EMPTY_CHARACTER, room: { ...EMPTY_CHARACTER.room, occupants: [occupant] } };
}

const struck = (key: string | null) => ({ struckJustNow: () => key });

describe('a damage shield line', () => {
  it('is damage taken, not this character’s blow on a monster named for the effect', () => {
    const block = line('You are shocked for 3 damage!');
    expect(block.type).toBe('user-takes-damage');
    expect(block.groups?.['damage']).toBe('3');
  });

  it('is the struck monster’s where the realm gives it a shield', () => {
    const boar = standingWith('razor boar', [[72, 3]]);
    expect(readsAsShield(line('You are shocked for 3 damage!'), boar, struck('razor boar'))).toBe(
      'razor boar'
    );
    expect(
      readsAsShield(line('The armour spikes stabs you for 2 damage!'), boar, struck('razor boar'))
    ).toBe('razor boar');
    // wraith knight: 72 = 10 and no ShockMsg, so the server's own default line.
    const knight = standingWith('wraith knight', [[72, 10]]);
    expect(line('You take 4 damage!').type).toBe('user-takes-damage');
    expect(readsAsShield(line('You take 4 damage!'), knight, struck('wraith knight'))).toBe(
      'wraith knight'
    );
  });

  it('is nobody’s where the monster has no shield or nothing was just struck', () => {
    const rat = standingWith('rat', [[34, 5]]);
    expect(readsAsShield(line('You are shocked for 3 damage!'), rat, struck('rat'))).toBeNull();
    const boar = standingWith('razor boar', [[72, 3]]);
    expect(readsAsShield(line('You are shocked for 3 damage!'), boar, struck(null))).toBeNull();
    // A line that names its attacker is that attacker's blow.
    expect(
      readsAsShield(line('Rend chops you for 9 damage!'), boar, struck('razor boar'))
    ).toBeNull();
  });

  /* The server writes the shield inside `Hit`, before the blow's hit spell (`PlayerAttackType.cs:269`, `:288`). */
  it('leaves the blow’s proc binding in place, where any other line breaks it', () => {
    const boar = standingWith('razor boar', [[72, 3]]);
    expect(
      keepsProcBinding(line('You are shocked for 3 damage!'), boar, struck('razor boar'))
    ).toBe(true);
    const rat = standingWith('rat', []);
    expect(keepsProcBinding(line('You are shocked for 3 damage!'), rat, struck('rat'))).toBe(false);
  });
});
