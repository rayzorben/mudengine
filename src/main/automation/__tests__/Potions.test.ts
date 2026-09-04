import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { Potions } from '../Potions';
import { DEFAULT_CONFIG, type AutomationConfig, type HealthConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CarriedItem, type CharacterState } from '../../../shared/character';
import { wireItem } from '../../../shared/entities';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const health = (over: Partial<HealthConfig> = {}): HealthConfig => ({
  ...DEFAULT_CONFIG.automation.health,
  drinkHealingPotionBelow: 0.25,
  drinkManaPotionBelow: 0.15,
  ...over
});
const carried = (name: string): CarriedItem => ({
  ...wireItem(name)
});
function state(
  vitals: Partial<CharacterState['vitals']>,
  items: CarriedItem[] = [carried('healing potion'), carried('mana potion')]
): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    vitals: { ...base.vitals, hp: 90, hpMax: 100, mana: 50, manaMax: 50, ...vitals },
    inventory: { ...base.inventory, items }
  };
}

let sent: string[];
let queue: CommandQueue;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const drinker = (over: Partial<HealthConfig> = {}) => new Potions(health(over), true, queue);

describe('drinking by a number', () => {
  it('drinks the healing potion below the threshold, and the mana potion below its own', () => {
    const potions = drinker();
    potions.onCharacter(state({ hp: 20 }));
    expect(sent).toEqual(['drink healing potion']);
    potions.onCharacter(state({ mana: 5 }));
    expect(sent).toEqual(['drink healing potion', 'drink mana potion']);
  });

  /* Unknown is not low, and 0 is never. */
  it('does nothing above the threshold, with no maximum, or when told never', () => {
    drinker().onCharacter(state({ hp: 60 }));
    drinker().onCharacter(state({ hp: 5, hpMax: null }));
    drinker({ drinkHealingPotionBelow: 0, drinkManaPotionBelow: 0 }).onCharacter(
      state({ hp: 5, mana: 1 })
    );
    // A class with no mana has no maximum, which is unknown rather than low.
    drinker().onCharacter(state({ mana: null, manaMax: null }));
    expect(sent).toEqual([]);
  });

  it('asks only for a potion the pack lists', () => {
    drinker().onCharacter(state({ hp: 5 }, []));
    drinker().onCharacter(state({ hp: 5 }, [carried('rusty dagger')]));
    expect(sent).toEqual([]);
  });

  /*
   * The server resolves a typed name as exact, a prefix, or the start of a
   * later word, so `healing potion` finds a `minor healing potion` and this
   * client matches the same way rather than a second way of its own.
   */
  it('matches the pack the way the server matches a typed name', () => {
    drinker().onCharacter(state({ hp: 5 }, [carried('minor healing potion (Readied/2)')]));
    expect(sent).toEqual(['drink healing potion']);
  });

  it('uses the verb it was told, and says nothing with no name', () => {
    drinker({ potionVerb: 'use' }).onCharacter(state({ hp: 5 }));
    expect(sent).toEqual(['use healing potion']);
    sent.length = 0;
    drinker({ healingPotionName: '  ' }).onCharacter(state({ hp: 5 }));
    expect(sent).toEqual([]);
  });

  it('does not ask again while the last drink is still working', () => {
    const potions = drinker();
    potions.onCharacter(state({ hp: 5 }));
    potions.onCharacter(state({ hp: 4 }));
    vi.advanceTimersByTime(2_000);
    potions.onCharacter(state({ hp: 3 }));
    expect(sent).toEqual(['drink healing potion']);
    vi.advanceTimersByTime(6_000);
    potions.onCharacter(state({ hp: 3 }));
    expect(sent).toEqual(['drink healing potion', 'drink healing potion']);
  });

  it('is off with automation off, and out of the realm', () => {
    new Potions(health(), false, queue).onCharacter(state({ hp: 5 }));
    drinker().onCharacter({ ...state({ hp: 5 }), phase: 'unknown' });
    expect(sent).toEqual([]);
  });
});
