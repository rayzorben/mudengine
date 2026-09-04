import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandQueue } from '../CommandQueue';
import { Cures, RETRY_MS } from '../Cures';
import { DEFAULT_CONFIG, type AutomationConfig, type SpellsConfig } from '../../../shared/config';
import {
  EMPTY_CHARACTER,
  NO_AFFLICTIONS,
  type Afflictions,
  type CharacterState
} from '../../../shared/character';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const spells = (over: Partial<SpellsConfig> = {}): SpellsConfig => ({
  ...DEFAULT_CONFIG.automation.spells,
  minMana: 0,
  cures: { blindness: 'cure blindness', poison: 'cure poison', disease: 'cure disease' },
  ...over
});
function state(afflictions: Partial<Afflictions>, vitals: Partial<CharacterState['vitals']> = {}) {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game' as const,
    name: 'Vaelor',
    vitals: { ...base.vitals, hp: 90, hpMax: 100, mana: 50, manaMax: 50, ...vitals },
    afflictions: { ...NO_AFFLICTIONS, ...afflictions }
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

describe('curing by a sentence', () => {
  it('casts the configured cure, bare, when the server says the condition is on', () => {
    const cures = new Cures(spells(), true, queue);
    cures.onCharacter(state({ poisoned: 'yes' }));
    expect(sent).toEqual(['c cure poison']);
    cures.onCharacter(state({ poisoned: 'yes', blind: 'yes', diseased: 'yes' }));
    expect(sent).toEqual(['c cure poison', 'c cure blindness', 'c cure disease']);
  });

  it('casts by the short word when the realm can name it', () => {
    const cures = new Cures(spells(), true, queue, undefined, (name) =>
      name === 'cure poison' ? { id: 19, name: 'cure poison', short: 'cpoi' } : null
    );
    cures.onCharacter(state({ poisoned: 'yes' }));
    expect(sent).toEqual(['c cpoi']);
  });

  /* Unknown is not yes, and no is not yes. */
  it('casts nothing while nothing has been said, or once the condition has ended', () => {
    const cures = new Cures(spells(), true, queue);
    cures.onCharacter(state({}));
    cures.onCharacter(state({ poisoned: 'no' }));
    expect(sent).toEqual([]);
  });

  it('casts once per onset, not once per status line', () => {
    const cures = new Cures(spells(), true, queue);
    cures.onCharacter(state({ poisoned: 'yes' }));
    cures.onCharacter(state({ poisoned: 'yes' }));
    cures.onCharacter(state({ poisoned: 'yes' }));
    expect(sent).toEqual(['c cure poison']);
  });

  /* A cure the server answered with nothing gets a second chance, patiently. */
  it('tries again only after the retry has passed while the condition is still stated', () => {
    const cures = new Cures(spells(), true, queue);
    cures.onCharacter(state({ poisoned: 'yes' }));
    vi.advanceTimersByTime(RETRY_MS - 1);
    cures.onCharacter(state({ poisoned: 'yes' }));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(2);
    cures.onCharacter(state({ poisoned: 'yes' }));
    expect(sent).toHaveLength(2);
  });

  it('casts again at once for a fresh onset after the condition ended', () => {
    const cures = new Cures(spells(), true, queue);
    cures.onCharacter(state({ poisoned: 'yes' }));
    cures.onCharacter(state({ poisoned: 'no' }));
    cures.onCharacter(state({ poisoned: 'yes' }));
    expect(sent).toHaveLength(2);
  });

  it('keeps the mana floor, and casts nothing with no spell configured', () => {
    new Cures(spells({ minMana: 0.5 }), true, queue).onCharacter(
      state({ poisoned: 'yes' }, { mana: 10 })
    );
    new Cures(
      spells({ cures: { blindness: '', poison: '', disease: '' } }),
      true,
      queue
    ).onCharacter(state({ poisoned: 'yes' }));
    expect(sent).toEqual([]);
  });

  it('is off with automation off, and out of the realm', () => {
    new Cures(spells(), false, queue).onCharacter(state({ poisoned: 'yes' }));
    new Cures(spells(), true, queue).onCharacter({
      ...state({ poisoned: 'yes' }),
      phase: 'unknown'
    });
    expect(sent).toEqual([]);
  });
});

/**
 * A cure that cannot be paid for is not sent, and the onset is not spent on it.
 *
 * The flag stays `yes` and `lastCastAt` is untouched, so the cast goes out on
 * the first status line that can afford it rather than after the thirty-second
 * retry clock — which is the whole reason nothing here needed a timer.
 */
describe('a cure the pool cannot pay for', () => {
  const table = (name: string) =>
    name.toLowerCase() === 'cure poison'
      ? { id: 19, name: 'cure poison', short: 'cpoi', mana: 8 }
      : null;

  it('waits for the mana rather than being refused out loud', () => {
    const cures = new Cures(spells(), true, queue, undefined, table);
    cures.onCharacter(state({ poisoned: 'yes' }, { mana: 3 }));
    expect(sent).toEqual([]);
    cures.onCharacter(state({ poisoned: 'yes' }, { mana: 8 }));
    expect(sent).toEqual(['c cpoi']);
  });
});
