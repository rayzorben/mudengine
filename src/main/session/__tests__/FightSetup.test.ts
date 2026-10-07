import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { WorldSpell } from '../../../shared/world';
import { FightSetup, type FightCharacter, type FightSetupParts } from '../FightSetup';

// Three rounds kill at 12.5 a round, two mana a round: the answer the book gives for any foe here.
vi.mock('../../../shared/spellchoice', async (actual) => ({
  ...(await actual<typeof import('../../../shared/spellchoice')>()),
  castsToKill: () => ({ rounds: 3, perRound: 12.5, mana: 2, spell: 'magic missile' })
}));

describe('FightSetup.foes', () => {
  /*
   * 2026-10-04: the per-cast mana was divided by the rounds, so a caster's pool lasted three times as long as it does.
   * 2026-10-05: the damage was the health over whole rounds, 70 / ceil(70 / 13.4) = 11.7 for a round worth 13.4.
   */
  it("prices a caster at the spell's own round: its damage and its mana, never the health over whole rounds", () => {
    const setup = new FightSetup(
      {
        world: undefined,
        errands: { castingInput: () => ({}) } as unknown as FightSetupParts['errands'],
        blessings: () => ({ recastFloor: () => null })
      },
      { config: () => DEFAULT_CONFIG.automation }
    );
    const { casting } = setup.foes(EMPTY_CHARACTER, {} as FightCharacter, [
      { name: 'orc rogue', subject: { hp: 30 } as never }
    ]);
    expect(casting).toEqual([{ perRound: 12.5, manaPerRound: 2 }]);
  });

  it('hands on a monster that waits to be struck, and nothing for one that does not', () => {
    const setup = new FightSetup(
      {
        world: undefined,
        errands: { castingInput: () => null } as unknown as FightSetupParts['errands'],
        blessings: () => ({ recastFloor: () => null })
      },
      { config: () => DEFAULT_CONFIG.automation }
    );
    const { foes } = setup.foes(EMPTY_CHARACTER, {} as FightCharacter, [
      { name: 'gambler', subject: { hp: 70 } as never, waits: true },
      { name: 'ogre', subject: { hp: 30 } as never, waits: false }
    ]);
    expect(foes.map((foe) => foe.waits)).toEqual([true, undefined]);
  });
});

/*
 * Todo 10, 2026-10-05: the heal the fight runs with read only `spells.heal`,
 * and a lapsing blessing was charged its mana whoever would recast it, its
 * effect up all fight either way.
 */
describe('FightSetup.character', () => {
  const SPELLS: Record<string, WorldSpell> = {
    shield: { id: 1, name: 'shield', level: 1, mana: 5, targets: 1, abilities: [[2, 30]] },
    'minor healing': {
      id: 2,
      name: 'minor healing',
      level: 1,
      mana: 2,
      targets: 2,
      power: [10, 20],
      abilities: [[18, 0]]
    },
    'major healing': {
      id: 3,
      name: 'major healing',
      level: 1,
      mana: 10,
      targets: 2,
      power: [40, 60],
      abilities: [[18, 0]]
    }
  };
  const state = (over: Partial<CharacterState> = {}): CharacterState => ({
    ...EMPTY_CHARACTER,
    phase: 'in-game',
    vitals: { ...EMPTY_CHARACTER.vitals, hp: 80, hpMax: 150, mana: 40, manaMax: 40 },
    progress: { ...EMPTY_CHARACTER.progress, level: 10, armourClass: 40 },
    spellbook: [
      { name: 'minor healing', short: 'mihe', level: 1, cost: 2 },
      { name: 'major healing', short: 'mahe', level: 1, cost: 10 }
    ],
    ...over
  });
  const setup = (
    recasts: (spell: string) => number | null,
    spells: Partial<AutomationConfig['spells']> = {},
    retreat: Partial<AutomationConfig['safety']['retreat']> = {}
  ): FightSetup =>
    new FightSetup(
      {
        world: { spellNamed: (name: string) => SPELLS[name] ?? null } as FightSetupParts['world'],
        errands: {
          realmClass: () => ({
            combat: 3,
            magery: 1,
            mageryType: 1,
            family: 'greatermud',
            attack: 'a'
          }),
          menacePlayer: (s: CharacterState) => ({
            armourClass: s.progress.armourClass,
            damageResist: 0,
            magicRes: 0,
            dodge: 5
          }),
          castingInput: () => null,
          noEffectsKey: () => ''
        } as unknown as FightSetupParts['errands'],
        blessings: () => ({ recastFloor: recasts })
      },
      {
        config: () => ({
          ...DEFAULT_CONFIG.automation,
          spells: {
            ...DEFAULT_CONFIG.automation.spells,
            heal: 'minor healing',
            healBelow: 0.5,
            healTo: 0.9,
            ...spells
          },
          safety: {
            ...DEFAULT_CONFIG.automation.safety,
            retreat: { ...DEFAULT_CONFIG.automation.safety.retreat, ...retreat }
          }
        })
      }
    );
  const shieldUp = (): CharacterState =>
    state({ buffs: [{ spell: 'shield', by: null, appliedAt: 0, expiresAt: Date.now() + 12_000 }] });

  it('recasts a lapsing blessing this character keeps up, at its cost, carrying its effect', () => {
    const [recast] = setup(() => 0.2).character(shieldUp(), 'now')!.recasts;
    expect(recast?.cost).toBe(5);
    expect(recast?.minMana).toBe(0.2);
    expect(recast?.effect?.armourClass).toBe(3);
  });

  it('lets a blessing nobody here recasts lapse for good', () => {
    const [recast] = setup(() => null).character(shieldUp(), 'now')!.recasts;
    expect(recast?.cost).toBeNull();
    expect(recast?.effect?.armourClass).toBe(3);
  });

  it('counts what is up on the formula sheet, and not again on the printed armour', () => {
    const blessed = setup(() => 0).character(shieldUp(), 'rested')!;
    const bare = setup(() => 0).character(state(), 'rested')!;
    // Armour is printed with the shield in it, so it is not added again.
    expect(blessed.player.armourClass).toBe(40);
    expect(blessed.sheet.effects?.armourClass).toBe(3);
    expect(bare.sheet.effects ?? null).toBeNull();
  });

  it('runs the heal Auto Choose Best Heal would cast, not the configured one', () => {
    expect(setup(() => null).character(state(), 'rested')!.heal?.restores).toEqual([10, 20]);
    const chosen = setup(() => null, { autoChooseHeal: true }).character(state(), 'rested')!;
    expect(chosen.heal?.restores).toEqual([40, 60]);
    expect(chosen.heal?.cost).toBe(10);
  });

  /* todo 16: the fight runs at the retreat line, and the odds book's key holds still as the pack fills. */
  it('runs at the retreat line, rested with the pack priced full, and keys the odds on the line alone', () => {
    const on = setup(() => null, {}, { enabled: true, belowHealth: 0.3 });
    const light = state({
      inventory: { ...EMPTY_CHARACTER.inventory, encumbrance: 0, encumbranceMax: 1000 }
    });
    const heavy = state({
      inventory: { ...EMPTY_CHARACTER.inventory, encumbrance: 900, encumbranceMax: 1000 }
    });
    expect(on.character(light, 'now')!.retreat).toMatchObject({ belowHealth: 0.3, caught: 0.22 });
    expect(on.character(light, 'rested')!.retreat!.caught).toBeCloseTo(0.62);
    expect(on.settingsKey(light)).toBe(on.settingsKey(heavy));
    expect(setup(() => null, {}, { enabled: true, belowHealth: 0.5 }).settingsKey(light)).not.toBe(
      on.settingsKey(light)
    );
    expect(setup(() => null, {}, { enabled: false }).character(light, 'now')!.retreat).toBeNull();
  });
});
