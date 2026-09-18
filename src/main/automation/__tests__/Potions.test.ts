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
  ...over
});

/** The two rows the two removed named slots used to be (todo 00). */
const VITAL_RULES: HealthConfig['potions'] = [
  { name: 'healing potion', when: 'hp', below: 0.25, verb: 'drink' },
  { name: 'mana potion', when: 'mana', below: 0.15, verb: 'drink' }
];
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

const drinker = (over: Partial<HealthConfig> = {}) =>
  new Potions(health({ potions: VITAL_RULES, ...over }), true, queue);

/*
 * The two vitals, which until todo 00 were named slots of their own with a
 * threshold and a shared verb. They are rows now, and every rule they used to
 * state is a rule about a row.
 */
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
    drinker({
      potions: VITAL_RULES.map((rule) => ({ ...rule, below: 0 }))
    }).onCharacter(state({ hp: 5, mana: 1 }));
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

  it('uses the verb the row states, and says nothing with no name', () => {
    drinker({
      potions: [{ name: 'healing potion', when: 'hp', below: 0.25, verb: 'use' }]
    }).onCharacter(state({ hp: 5 }));
    expect(sent).toEqual(['use healing potion']);
    sent.length = 0;
    // A nameless row is dropped by `normalizePotionRules` before it gets here;
    // one that reached here anyway asks for nothing.
    drinker({ potions: [{ name: '  ', when: 'hp', below: 0.25, verb: 'drink' }] }).onCharacter(
      state({ hp: 5 })
    );
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
    new Potions(health({ potions: VITAL_RULES }), false, queue).onCharacter(state({ hp: 5 }));
    drinker().onCharacter({ ...state({ hp: 5 }), phase: 'unknown' });
    expect(sent).toEqual([]);
  });
});

/*
 * *Use this item when that is true* — the player's own list (todo 19).
 *
 * The two thresholds above are health and mana, which is what MegaMUD had.
 * This is the rest of it: a character wanting two healing potions at different
 * depths, or an antidote the moment it is poisoned, could not say so before.
 */
describe('the potion rules', () => {
  const afflicted = (over: Partial<CharacterState['afflictions']> = {}) => ({
    blind: 'no' as const,
    poisoned: 'no' as const,
    diseased: 'no' as const,
    held: 'no' as const,
    confused: 'no' as const,
    ...over
  });

  const withRules = (rules: HealthConfig['potions']) =>
    new Potions(health({ potions: rules }), true, queue);

  it('uses an item when a stated condition holds', () => {
    const base = state({ hp: 90 }, [carried('cure poison potion')]);
    withRules([
      { name: 'cure poison potion', when: 'poisoned', below: 0, verb: 'drink' }
    ]).onCharacter({ ...base, afflictions: afflicted({ poisoned: 'yes' }) });
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['drink cure poison potion']);
  });

  /* Unknown is not afflicted: only a stated `yes` fires. */
  it('does not fire on an unstated condition', () => {
    const base = state({ hp: 90 }, [carried('cure poison potion')]);
    withRules([
      { name: 'cure poison potion', when: 'poisoned', below: 0, verb: 'drink' }
    ]).onCharacter({ ...base, afflictions: afflicted({ poisoned: 'unknown' }) });
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });

  /* Two rules on one item at two depths are two proposals, not one. */
  it('keeps two rules on the same item apart', () => {
    const base = state({ hp: 10, hpMax: 100 }, [carried('healing potion')]);
    withRules([
      { name: 'healing potion', when: 'hp', below: 0.5, verb: 'drink' },
      { name: 'healing potion', when: 'hp', below: 0.2, verb: 'drink' }
    ]).onCharacter(base);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['drink healing potion', 'drink healing potion']);
  });

  /* The verb is the row's: a scroll is read where a potion is drunk. */
  it('uses the verb the row states', () => {
    const base = state({ hp: 10, hpMax: 100 }, [carried('scroll of major healing')]);
    withRules([
      { name: 'scroll of major healing', when: 'hp', below: 0.5, verb: 'use' }
    ]).onCharacter(base);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['use scroll of major healing']);
  });

  /* Only an item the pack lists: a `drink` for what is not carried is a
     command spent to be told so, in the room. */
  it('never asks for an item the pack does not list', () => {
    const base = state({ hp: 10, hpMax: 100 }, [carried('rusty dagger')]);
    withRules([{ name: 'healing potion', when: 'hp', below: 0.5, verb: 'drink' }]).onCharacter(
      base
    );
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });

  /* An unknown maximum is not low — the rule every threshold here follows. */
  it('does not fire on an unknown maximum', () => {
    const base = state({ mana: 2, manaMax: null }, [carried('mana potion')]);
    withRules([{ name: 'mana potion', when: 'mana', below: 0.5, verb: 'drink' }]).onCharacter(base);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });
});
