import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Blessings } from '../Blessings';
import { BlessRound } from '../BlessRound';
import { CommandQueue } from '../CommandQueue';
import { RoundClock } from '../RoundClock';
import type { SafetyDecision } from '../../../shared/automation';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import { DEFAULT_CONFIG, type AutomationConfig, type SpellsConfig } from '../../../shared/config';
import { OPEN_CAST_GATE, type CastGate } from '../../../shared/spellcraft';
import { blockOf } from '../../../shared/__tests__/blocks';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};
const spells: SpellsConfig = {
  ...DEFAULT_CONFIG.automation.spells,
  blessings: [
    { spell: 'mageshield', target: 'self', minMana: 0, prioritizeOverHeal: false, inCombat: true }
  ]
};

function state(over: Partial<CharacterState> = {}): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return {
    ...base,
    phase: 'in-game',
    name: 'Cretin',
    vitals: { ...base.vitals, hp: 86, hpMax: 86, mana: 86, manaMax: 86 },
    ...over
  };
}

let sent: string[];
let decisions: SafetyDecision[];
let queue: CommandQueue;
let rounds: RoundClock;
let fighting: boolean;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  sent = [];
  decisions = [];
  fighting = true;
  rounds = new RoundClock();
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const gateOver = (inner: CastGate = OPEN_CAST_GATE): BlessRound =>
  new BlessRound(inner, rounds, () => fighting, { decided: (d) => decisions.push(d) });
const bless = (gate: CastGate): Blessings =>
  new Blessings(spells, true, queue, { onTheGround: () => false, castGate: gate });

/** A round's blows arrive now. */
const round = (): void => rounds.onBlock(blockOf('mob-misses', '', {}, Date.now()));

describe('a blessing in a fight', () => {
  /*
   * Cretin, 2026-11-21 (`2026-11-21_17-44-40_cretin.mudcap.jsonl`,
   * t=17333611): the round's blows, `Your mageshield shimmers and fades.`
   * 4,028 ms later, and the next round 5,056 ms after the first. `mshi` went
   * at the fade, 1.0 s before that round.
   */
  it('lapsing 1.0 s before a round waits for that round and goes as it fires', () => {
    const blesser = bless(gateOver());
    const inFight = state({ inCombat: true });
    round();

    vi.advanceTimersByTime(4028);
    blesser.onCharacter(inFight);
    expect(sent).toEqual([]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: 'cast', because: 'mageshield', acted: false });

    // Asked again before the round: still held, and said once.
    vi.advanceTimersByTime(500);
    blesser.onCharacter(inFight);
    expect(sent).toEqual([]);
    expect(decisions).toHaveLength(1);

    vi.advanceTimersByTime(528);
    round();
    blesser.onCharacter(inFight);
    expect(sent).toEqual(['mageshield']);
  });

  it('lapsing right after a round goes at once', () => {
    const blesser = bless(gateOver());
    round();
    vi.advanceTimersByTime(900);
    blesser.onCharacter(state({ inCombat: true }));
    expect(sent).toEqual(['mageshield']);
    expect(decisions).toEqual([]);
  });

  it('is not timed out of a fight', () => {
    fighting = false;
    const blesser = bless(gateOver());
    round();
    vi.advanceTimersByTime(4028);
    blesser.onCharacter(state());
    expect(sent).toEqual(['mageshield']);
  });

  it('is not timed before any round is seen', () => {
    const blesser = bless(gateOver());
    blesser.onCharacter(state({ inCombat: true }));
    expect(sent).toEqual(['mageshield']);
  });

  it('goes by the beat when a round came due and no blow was seen', () => {
    const blesser = bless(gateOver());
    const inFight = state({ inCombat: true });
    round();

    // Held from the half until a round and a half with nothing seen.
    vi.advanceTimersByTime(7400);
    blesser.onCharacter(inFight);
    expect(sent).toEqual([]);

    // Two rounds on by the beat, in its first half.
    vi.advanceTimersByTime(2700);
    blesser.onCharacter(inFight);
    expect(sent).toEqual(['mageshield']);
  });
});

describe('the gate behind it', () => {
  it('is asked only once the round allows, and is told of the cast and the fumble', () => {
    const inner = { mayCast: vi.fn(() => true), noteCast: vi.fn(), noteFumbled: vi.fn() };
    const gate = gateOver(inner);
    round();
    vi.advanceTimersByTime(4028);
    expect(gate.mayCast('mageshield')).toBe(false);
    expect(inner.mayCast).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1028);
    round();
    expect(gate.mayCast('mageshield')).toBe(true);
    expect(inner.mayCast).toHaveBeenCalledWith('mageshield');

    gate.noteCast();
    gate.noteFumbled();
    expect(inner.noteCast).toHaveBeenCalledOnce();
    expect(inner.noteFumbled).toHaveBeenCalledOnce();
  });

  it('holds what the inner gate refuses', () => {
    const gate = gateOver({ ...OPEN_CAST_GATE, mayCast: () => false });
    round();
    expect(gate.mayCast('mageshield')).toBe(false);
  });
});
