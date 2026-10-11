import { describe, expect, it } from 'vitest';

import {
  backstabBlow,
  backstabWeapon,
  backstabWorth,
  derivedBackstabWeapon,
  weaponBackstabs,
  withBackstabWeapon
} from '../backstab';
import type { CarriedItem } from '../character';
import { wireItem } from '../entities';
import { NO_PLACE, UNKNOWN_WEARER, kitFor, type GearSet } from '../gear';
import { OFF_HAND, WEAPON_HAND } from '../items';

const weapon = (
  name: string,
  min: number,
  max: number,
  kind: number,
  over: Partial<CarriedItem> = {}
): CarriedItem => ({
  ...wireItem(name),
  kind: 'weapon',
  weapon: { min, max, kind },
  ...over
});

describe('which weapons backstab', () => {
  it('follows Item.CanBackstab: one-handed sharp, or any backstab row', () => {
    expect(weaponBackstabs({ weapon: { kind: 2 } })).toBe(true);
    expect(weaponBackstabs({ weapon: { kind: 0 } })).toBe(false);
    // A negative accuracy row still lets it backstab (`longsword` 116 −10, Paradigm).
    expect(weaponBackstabs({ weapon: { kind: 3 }, abilities: [[116, -10]] })).toBe(true);
    expect(weaponBackstabs({ weapon: {} })).toBeNull();
  });
});

describe('the backstab weapon', () => {
  const none = (): boolean => false;

  it('scores the blow’s range and half the backstab damage rows', () => {
    expect(backstabWorth(weapon('stiletto', 6, 16, 2))).toBe(22);
    expect(
      backstabWorth(
        weapon('kris', 4, 10, 2, {
          abilities: [
            [117, 4],
            [118, 8]
          ]
        })
      )
    ).toBe(20);
    expect(backstabWorth(wireItem('rope'))).toBeNull();
  });

  it('picks the best the character may wield and the server has not refused', () => {
    const pack = [
      weapon('club', 20, 40, 0),
      weapon('stiletto', 6, 16, 2),
      weapon('kris', 4, 10, 2, {
        abilities: [
          [117, 4],
          [118, 8]
        ]
      }),
      weapon('royal dirk', 10, 30, 2, { classes: [99] }),
      weapon('voidstar', 12, 32, 2)
    ];
    const ninja = { ...UNKNOWN_WEARER, classId: 7 };
    expect(backstabWeapon(pack, ninja, none)?.name).toBe('voidstar');
    expect(backstabWeapon(pack, ninja, (name) => name === 'voidstar')?.name).toBe('stiletto');
    // Unknown class refuses nothing.
    expect(backstabWeapon(pack, UNKNOWN_WEARER, (name) => name === 'voidstar')?.name).toBe(
      'royal dirk'
    );
  });

  it('breaks a tie on the backstab accuracy row', () => {
    const pack = [
      weapon('a', 5, 10, 2, { abilities: [[116, -5]] }),
      weapon('b', 5, 10, 2, { abilities: [[116, 5]] })
    ];
    expect(backstabWeapon(pack, UNKNOWN_WEARER, none)?.name).toBe('b');
  });

  it('is none where nothing carried backstabs', () => {
    expect(backstabWeapon([weapon('club', 20, 40, 0)], UNKNOWN_WEARER, none)).toBeNull();
  });
});

describe('laying the backstab weapon into the sets', () => {
  const slotOf = (name: string): string | null =>
    name.endsWith('shield') ? OFF_HAND : name === 'boots' ? 'Feet' : WEAPON_HAND;
  const still = { moving: false, resting: false, fighting: false, backstab: false, target: null };

  it('puts the hands held before back in the base, for the slots it does not name', () => {
    const sets: GearSet[] = [
      { name: 'Kit', when: 'always', mob: '', wear: ['boots', 'buckler shield'] }
    ];
    const laid = withBackstabWeapon(
      sets,
      { set: 'stab', item: 'stiletto' },
      ['broadsword', 'tower shield'],
      slotOf
    );
    expect(laid[0]?.wear).toEqual(['boots', 'buckler shield', 'broadsword']);
    expect(laid.at(-1)).toEqual({ name: 'stab', when: 'backstab', mob: '', wear: ['stiletto'] });
    expect([...kitFor(laid, { ...still, backstab: true }, slotOf).values()]).toContain('stiletto');
    expect([...kitFor(laid, still, slotOf).values()]).toContain('broadsword');
  });

  it('leaves a written backstab set and an absent weapon alone', () => {
    const written: GearSet[] = [{ name: 'Stab', when: 'backstab', mob: '', wear: ['dagger'] }];
    expect(withBackstabWeapon(written, { set: 'stab', item: 'stiletto' }, ['sword'], slotOf)).toBe(
      written
    );
    expect(withBackstabWeapon([], null, ['sword'], slotOf)).toEqual([]);
  });

  it('frees the base’s off-hand for a two-handed overlay weapon', () => {
    const sets: GearSet[] = [
      { name: 'Kit', when: 'always', mob: '', wear: ['sword', 'tower shield'] },
      { name: 'Stab', when: 'backstab', mob: '', wear: ['pike'] }
    ];
    const hands = (name: string): 1 | 2 | null => (name === 'pike' ? 2 : 1);
    const kit = kitFor(sets, { ...still, backstab: true }, slotOf, NO_PLACE, hands);
    expect(kit.get(WEAPON_HAND.toLowerCase())).toBe('pike');
    expect(kit.has(OFF_HAND.toLowerCase())).toBe(false);
    expect(kitFor(sets, still, slotOf, NO_PLACE, hands).get(OFF_HAND.toLowerCase())).toBe(
      'tower shield'
    );
  });
});

describe('one backstab blow', () => {
  const dagger: CarriedItem = {
    ...wireItem('dagger'),
    kind: 'weapon',
    weapon: { min: 1, max: 4, speed: 1000, kind: 2 }
  };
  const figures = { level: 10, stealth: 50 };
  const none = (): boolean => false;

  it('is the mean of CalcBSDamage’s low and high ends for a class that hides', () => {
    // (2·10 + 5 + 2·1) · 110/100 and (2·10 + 5 + 2·4) · 110/100.
    expect(backstabBlow(figures, dagger, [dagger])).toBeCloseTo((29.7 + 36.3) / 2);
    // An empty hand is 1–5, as the server reads fists.
    expect(backstabBlow(figures, null, [])).toBeCloseTo((29.7 + 38.5) / 2);
  });

  it('adds the backstab rows of the weapon and of what else is worn', () => {
    const ring: CarriedItem = {
      ...wireItem('shadow ring'),
      equipped: true,
      slot: 'Finger',
      abilities: [
        [117, 10],
        [118, 10]
      ]
    };
    expect(backstabBlow(figures, dagger, [dagger, ring])).toBeCloseTo(33 + 11);
  });

  it('is unknown while the level or Stealth is unread', () => {
    expect(backstabBlow({ level: null, stealth: 50 }, dagger, [])).toBeNull();
    expect(backstabBlow({ level: 10, stealth: null }, dagger, [])).toBeNull();
  });

  it('is derived only where the player wrote no backstab set', () => {
    const written: GearSet[] = [{ name: 'Stab', when: 'backstab', mob: '', wear: ['knife'] }];
    expect(derivedBackstabWeapon([], [dagger], UNKNOWN_WEARER, none)).toBe(dagger);
    expect(derivedBackstabWeapon(written, [dagger], UNKNOWN_WEARER, none)).toBeNull();
  });
});
