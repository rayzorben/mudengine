import { describe, expect, it } from 'vitest';

import { Errands, type ErrandsParts, type ErrandsSession } from '../Errands';
import { ATTACK_ABILITY } from '../../../shared/abilities';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

const MYSTIC: CharacterState = {
  ...EMPTY_CHARACTER,
  className: 'Mystic',
  progress: { ...EMPTY_CHARACTER.progress, level: 10, agility: 80, strength: 82, charm: 50 }
};

function errands(attack: string): Errands {
  const config: AutomationConfig = {
    ...DEFAULT_CONFIG.automation,
    combat: { ...DEFAULT_CONFIG.automation.combat, attack }
  };
  const world = {
    classNamed: () => ({
      combat: 3,
      magery: null,
      abilities: [
        [ATTACK_ABILITY.punch, 1],
        [ATTACK_ABILITY.jumpkick, 1]
      ]
    }),
    raceAbilities: () => null,
    sparedItems: () => new Set([185])
  };
  return new Errands(
    { world, tracker: { current: MYSTIC }, fightRecord: {}, lore: {} } as unknown as ErrandsParts,
    { config: () => config, family: () => 'greatermud' } as unknown as ErrandsSession
  );
}

/*
 * Every reader that prices a fight (the survey's price key, the fitness key,
 * the lair costs, the slot rankings) reads `realmClass`, so the word it carries
 * is the word auto-combat sends (todo 47).
 */
describe('the attack every price reads', () => {
  it('is the chosen round where the field is blank', () => {
    const chosen = errands('');
    const best = chosen.words.attack();
    expect(best.why).toBe('best');
    expect(['pu', 'ju']).toContain(best.verb);
    expect(chosen.realmClass().verb).toBe(best.verb);
    expect(chosen.realmClass().attack.kind).toBe(best.verb === 'pu' ? 'punch' : 'jumpkick');
  });

  it('is the typed word where there is one', () => {
    expect(errands('a').realmClass()).toMatchObject({ verb: 'a', attack: { kind: 'attack' } });
  });
});

/*
 * Todo 31: which monsters wait to be struck moves with an item a monster
 * spares its holder for, and the odds book's pass of a lair is keyed on
 * fitness, so picking one up opens a new book. Any other item moves nothing.
 */
describe('the fitness key and the pack', () => {
  const holding = (...rows: number[]): CharacterState => ({
    ...MYSTIC,
    inventory: { ...MYSTIC.inventory, rows, listedAt: 1 }
  });

  it('moves with an item a monster spares its holder for, and no other', () => {
    const book = errands('a');
    const bare = book.fitness(holding());
    expect(book.fitness(holding(7))).toBe(bare);
    expect(book.fitness(holding(7, 185))).not.toBe(bare);
  });
});
