import { describe, expect, it } from 'vitest';

import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import type { MobEntity } from '../../../shared/entities';
import { UNKNOWN_WEARER, type Wearer } from '../../../shared/gear';
import { WEAPON_HAND } from '../../../shared/items';
import type { Errands } from '../Errands';
import { handReach } from '../weaponReach';

/*
 * Festus, a level 47 Paladin on Paradigm, 2026-11-01: a big crowned spider
 * (`Magical 4`), a golden sickle in hand (`Magical 2`), Darkbane (`Magical 5`,
 * `MinLevel 50`, Warrior, Paladin, Missionary) and an ethereal dagger
 * (`Magical 5`, `MinLevel 40`) in the pack. Rows from the realm conversion;
 * the death in `logs/2026-11-01_06-08-34_festus.log:700-2195`.
 */
const MAGICAL = 28;
const weapon = (name: string, rows: Partial<CarriedItem>, equipped = false): CarriedItem => ({
  name,
  source: 'mdb',
  slot: equipped ? WEAPON_HAND : null,
  equipped,
  charges: null,
  kind: 'weapon',
  ...rows
});
const sickle = weapon('golden sickle', { abilities: [[MAGICAL, 2]] }, true);
const darkbane = weapon('Darkbane', {
  abilities: [[MAGICAL, 5]],
  minLevel: 50,
  classes: [1, 3, 6]
});
const dagger = weapon('ethereal dagger', { abilities: [[MAGICAL, 5]], minLevel: 40 });

const spider = { abilities: [[MAGICAL, 4]], source: 'mdb' } as unknown as MobEntity;
const base = structuredClone(EMPTY_CHARACTER);
const festus: CharacterState = {
  ...base,
  inventory: { ...base.inventory, items: [sickle, darkbane, dagger], listedAt: 1 },
  room: {
    ...base.room,
    occupants: [
      {
        name: 'big crowned spider',
        kind: 'mob',
        mob: spider
      } as CharacterState['room']['occupants'][number]
    ]
  }
};

const paladin: Wearer = { ...UNKNOWN_WEARER, classId: 3, level: 47 };

function reach(wearer: Wearer, refused: readonly string[] = []) {
  const errands = {
    capabilities: () => ({ abilities: [] }),
    wearer: () => wearer
  } as unknown as Pick<Errands, 'capabilities' | 'wearer'>;
  return handReach(
    errands,
    () => undefined,
    () => ({
      reads: { wearing: () => ({ worn: [] }), attacks: () => [] } as never,
      refusals: { refusesWield: (name: string) => refused.includes(name) }
    })
  );
}

describe('handReach', () => {
  it('takes up the ethereal dagger, not Darkbane, for a level 47 Paladin', () => {
    expect(reach(paladin)(festus, 'big crowned spider', true)).toEqual({
      kind: 'swap',
      weapon: 'ethereal dagger'
    });
  });

  // Positive control: a character the realm lets wield Darkbane is offered it first.
  it('offers Darkbane at level 50', () => {
    expect(reach({ ...paladin, level: 50 })(festus, 'big crowned spider', true)).toEqual({
      kind: 'swap',
      weapon: 'Darkbane'
    });
  });

  // Unknown never refuses: a character whose sheet is unread is offered Darkbane.
  it('offers Darkbane while the sheet is unread', () => {
    expect(reach(UNKNOWN_WEARER)(festus, 'big crowned spider', true)).toEqual({
      kind: 'swap',
      weapon: 'Darkbane'
    });
  });

  it('passes over a weapon the server refused, whatever the rows say', () => {
    expect(
      reach({ ...paladin, level: 50 }, ['Darkbane'])(festus, 'big crowned spider', true)
    ).toEqual({ kind: 'swap', weapon: 'ethereal dagger' });
  });

  it('cannot when every weapon that would hurt it is ruled out', () => {
    expect(reach(paladin, ['ethereal dagger'])(festus, 'big crowned spider', true)).toEqual({
      kind: 'cannot'
    });
  });
});
