import { describe, expect, it } from 'vitest';

import {
  ATTACK_ABILITY,
  CLASS_STEALTH_ABILITY,
  type Capabilities
} from '../../../shared/abilities';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import type { ProwessTarget } from '../../../shared/prowess';
import { fightWords, type FightWordParts } from '../fightWords';

/*
 * Soul, the level 14 Mystic of 2026-10-05, with a staff: before armour the
 * bash's bigger blow wins, and against the tortured spirit (AC 50) the server's
 * own `st a 408` puts punch first and jumpkick last (`attackOptions.test.ts`).
 */
const SOUL: CharacterState = (() => {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    progress: {
      ...base.progress,
      level: 14,
      agility: 90,
      intellect: 50,
      charm: 70,
      willpower: 30,
      health: 53,
      strength: 82
    },
    inventory: {
      ...base.inventory,
      encumbrance: 12,
      encumbranceMax: 100,
      items: [
        {
          name: 'quarterstaff',
          equipped: true,
          kind: 'weapon',
          weapon: { min: 2, max: 11, speed: 1300 }
        } as never
      ]
    }
  };
})();

const MYSTIC_BASHER: Capabilities = {
  abilities: [
    [ATTACK_ABILITY.punch, 1],
    [ATTACK_ABILITY.kick, 1],
    [ATTACK_ABILITY.jumpkick, 1],
    [ATTACK_ABILITY.bash, 1]
  ]
};

const SPIRIT: ProwessTarget = { armourClass: 50, damageResist: 0, dodge: null, health: 150 };

function words(
  combat: { attack: string; opener: string },
  overrides: Partial<FightWordParts> = {}
): { words: ReturnType<typeof fightWords>; state: { current: CharacterState } } {
  const state = { current: SOUL };
  return {
    state,
    words: fightWords({
      combat: () => combat,
      current: () => state.current,
      rows: () => ({ combat: 5, magery: null, crits: 10, family: 'greatermud' }),
      capabilities: () => MYSTIC_BASHER,
      targetOf: (name) => (name === 'tortured spirit' ? SPIRIT : null),
      backstabWeapon: () => null,
      ...overrides
    })
  };
}

describe('the words a fight is fought with', () => {
  it('chooses the round that lands most on the monster, which armour can turn', () => {
    const { words: chosen } = words({ attack: '', opener: '' });
    expect(chosen.attack().verb).toBe('aa');
    const against = chosen.attack(['tortured spirit']);
    expect(against).toMatchObject({ verb: 'pu', why: 'best' });
    const options = chosen.options(SOUL, ['tortured spirit']);
    const round = (verb: string): number =>
      options.find((option) => option.verb === verb)?.perRound?.value ?? Number.NaN;
    expect(round('pu')).toBeGreaterThan(round('ju'));
  });

  it('swings the round chosen before armour at a monster nobody can place', () => {
    const { words: chosen } = words({ attack: '', opener: '' });
    expect(chosen.attack(['a stranger'])).toBe(chosen.attack());
    expect(chosen.attack(['a stranger']).verb).toBe('aa');
  });

  it('keeps a typed word, and the page still hears what blank would choose', () => {
    const { words: typed } = words({ attack: 'kic', opener: 'ju' });
    expect(typed.attack(['tortured spirit'])).toEqual({
      verb: 'kic',
      why: 'typed',
      perRound: null
    });
    expect(typed.opener()).toBe('ju');
    expect(typed.untyped()).toMatchObject({ attack: { verb: 'aa', why: 'best' }, opener: '' });
  });

  it('prices before armour once per state, and again for the next state', () => {
    const { words: chosen, state } = words({ attack: '', opener: '' });
    const first = chosen.attack();
    expect(chosen.attack()).toBe(first);
    state.current = { ...SOUL };
    expect(chosen.attack()).not.toBe(first);
    expect(chosen.attack()).toEqual(first);
  });

  it('opens with a backstab only for a class row that hides', () => {
    const hider: Capabilities = {
      abilities: [...(MYSTIC_BASHER.abilities ?? []), [CLASS_STEALTH_ABILITY, 1]]
    };
    expect(words({ attack: '', opener: '' }).words.opener()).toBe('');
    expect(words({ attack: '', opener: '' }, { capabilities: () => hider }).words.opener()).toBe(
      'bs'
    );
  });

  describe('the backstab opener against a plain round', () => {
    const hider: Capabilities = {
      abilities: [...(MYSTIC_BASHER.abilities ?? []), [CLASS_STEALTH_ABILITY, 1]]
    };
    const knife = (min: number, max: number): CarriedItem =>
      ({
        name: 'knife',
        equipped: false,
        kind: 'weapon',
        weapon: { min, max, speed: 1000, kind: 2 }
      }) as never;
    const sneak = (level: number): CharacterState => ({
      ...SOUL,
      progress: { ...SOUL.progress, level, stealthSkill: 40 }
    });
    const opener = (state: CharacterState, weapon: CarriedItem | null): string => {
      const made = words(
        { attack: '', opener: '' },
        { capabilities: () => hider, backstabWeapon: () => weapon }
      );
      made.state.current = state;
      return made.words.opener();
    };

    it('opens with the weapon worn for the backstab where the hand cannot', () => {
      const club = {
        ...SOUL,
        inventory: {
          ...SOUL.inventory,
          items: [{ ...SOUL.inventory.items[0], weapon: { min: 2, max: 11, speed: 1300, kind: 0 } }]
        }
      } as CharacterState;
      expect(opener({ ...club, progress: sneak(14).progress }, null)).toBe('');
      expect(opener({ ...club, progress: sneak(14).progress }, knife(6, 16))).toBe('bs');
    });

    it('opens with the plain round where one blow is worth less', () => {
      // Soul's best round before armour is a bash of about 51; a 10–30 knife's blow is about 75.
      expect(opener(sneak(14), knife(10, 30))).toBe('bs');
      // A 1–2 knife's blow is about 40.
      expect(opener(sneak(14), knife(1, 2))).toBe('');
    });
  });
});
