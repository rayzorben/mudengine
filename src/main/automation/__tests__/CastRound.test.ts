import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutoHeal } from '../AutoHeal';
import { Blessings } from '../Blessings';
import { CastRound } from '../CastRound';
import { CommandQueue } from '../CommandQueue';
import { Cures } from '../Cures';
import { tuning } from '../../app/tuning';
import type { SafetyDecision } from '../../../shared/automation';
import type { Block } from '../../../shared/blocks';
import { EMPTY_CHARACTER, NO_AFFLICTIONS, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig, type SpellsConfig } from '../../../shared/config';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const spells: SpellsConfig = {
  ...DEFAULT_CONFIG.automation.spells,
  heal: 'minor healing',
  healBelow: 0.5,
  minMana: 0,
  cures: { ...DEFAULT_CONFIG.automation.spells.cures, poison: 'cure poison' },
  blessings: [
    { spell: 'protection', target: 'self', minMana: 0, prioritizeOverHeal: false, inCombat: true }
  ]
};

function state(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Vaelor',
    vitals: { ...base.vitals, hp: 40, hpMax: 100, mana: 50, manaMax: 50 },
    ...over
  };
}

const block = (type: Block['type']): Block =>
  ({ type, seq: 1, at: Date.now(), domain: 'combat', groups: {} }) as unknown as Block;

/** One round of a fight going by: a quiet longer than the gap, then the round's blows. */
function nextRound(gate: CastRound): void {
  vi.advanceTimersByTime(tuning().hunting.roundSeconds * 1000 - 200);
  gate.onBlock(block('mob-hits'));
  gate.onBlock(block('user-misses'));
}

let sent: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;
let gate: CastRound;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  decisions = [];
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
  gate = new CastRound({ decided: (decision) => decisions.push(decision) });
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const heal = (): AutoHeal =>
  new AutoHeal(spells, true, queue, undefined, undefined, {}, undefined, gate);
const bless = (): Blessings =>
  new Blessings(spells, true, queue, { onTheGround: () => false, castGate: gate });
const cures = (): Cures => new Cures(spells, true, queue, undefined, undefined, {}, gate);

describe('one heal, blessing or cure a round', () => {
  it('sends the heal and holds a blessing due in the same round until the next', () => {
    const healer = heal();
    const blesser = bless();
    const fighting = state({ inCombat: true });
    gate.onBlock(block('mob-hits'));

    healer.onCharacter(fighting);
    blesser.onCharacter(fighting);
    expect(sent).toEqual(['minor healing']);

    // A late blow of the same round's burst opens nothing.
    vi.advanceTimersByTime(1000);
    gate.onBlock(block('user-hits'));
    blesser.onCharacter(fighting);
    expect(sent).toEqual(['minor healing']);

    nextRound(gate);
    blesser.onCharacter(fighting);
    expect(sent).toEqual(['minor healing', 'protection']);
  });

  it('holds the second cast out of a fight too, until a round has passed', () => {
    const healer = heal();
    const blesser = bless();
    const idle = state();

    healer.onCharacter(idle);
    blesser.onCharacter(idle);
    // The positive control: the first cast went, so the gate was asked.
    expect(sent).toEqual(['minor healing']);

    vi.advanceTimersByTime(tuning().hunting.roundSeconds * 1000 - 100);
    blesser.onCharacter(idle);
    expect(sent).toEqual(['minor healing']);

    vi.advanceTimersByTime(tuning().spells.castSlackMs + 100);
    blesser.onCharacter(idle);
    expect(sent).toEqual(['minor healing', 'protection']);
  });

  it('takes a refusal as the round spent, and says once why a cast waits', () => {
    const healer = heal();
    gate.onBlock(block('mob-hits'));
    gate.onBlock(block('spell-refused'));

    healer.onCharacter(state({ inCombat: true }));
    healer.onCharacter(state({ inCombat: true }));
    expect(sent).toEqual([]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: 'cast', because: 'minor healing', acted: false });

    nextRound(gate);
    healer.onCharacter(state({ inCombat: true }));
    expect(sent).toEqual(['minor healing']);
  });

  it('keeps a cure held at the send due, rather than waiting out its retry', () => {
    const healer = heal();
    const curer = cures();
    const poisoned = state({
      inCombat: true,
      afflictions: { ...NO_AFFLICTIONS, poisoned: 'yes' }
    });
    gate.onBlock(block('mob-hits'));

    healer.onCharacter(poisoned);
    curer.onCharacter(poisoned);
    expect(sent).toEqual(['minor healing']);

    nextRound(gate);
    curer.onCharacter(poisoned);
    expect(sent).toEqual(['minor healing', 'cure poison']);
  });

  it('opens again on reset', () => {
    gate.noteCast();
    expect(gate.mayCast('protection')).toBe(false);
    gate.reset();
    expect(gate.mayCast('protection')).toBe(true);
  });
});
