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
    raceAbilities: () => null
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
