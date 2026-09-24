import { beforeEach, describe, expect, it } from 'vitest';

import { CombatLease, type DefendFacts } from '../CombatLease';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

/*
 * Auto-combat lent for a hold and given back on arrival (todos 07 and 11,
 * 2026-09-17). The switch is the character's file: every flip here is a
 * request the file answers on its next reload, which `configure` stands for.
 */

function automation(
  over: {
    combat?: boolean;
    fightOnArrival?: boolean;
    master?: boolean;
    retaliate?: boolean;
    defendAfterRounds?: number;
  } = {}
): AutomationConfig {
  const base = DEFAULT_CONFIG.automation;
  return {
    ...base,
    enabled: over.master ?? true,
    combat: {
      ...base.combat,
      enabled: over.combat ?? false,
      retaliate: over.retaliate ?? true,
      defendAfterRounds: over.defendAfterRounds ?? 2
    },
    movement: { ...base.movement, fightOnArrival: over.fightOnArrival ?? true }
  };
}

function state(held: 'yes' | 'no' | 'unknown'): CharacterState {
  const base = structuredClone(EMPTY_CHARACTER);
  return { ...base, phase: 'in-game', afflictions: { ...base.afflictions, held } };
}

let flips: boolean[];
let said: string[];
let lease: CombatLease;
beforeEach(() => {
  flips = [];
  said = [];
  lease = new CombatLease({
    flip: (on) => {
      flips.push(on);
      return true;
    },
    notice: (message) => said.push(message)
  });
});

describe('a hold on a walk with auto-combat off', () => {
  it('lends combat while held, and hands it back when the hold ends', () => {
    lease.configure(automation({ combat: false }));
    lease.onCharacter(state('yes'), true);
    expect(flips).toEqual([true]);
    expect(said).toHaveLength(1);
    // Asked, not yet answered: nothing is asked twice.
    lease.onCharacter(state('yes'), true);
    expect(flips).toEqual([true]);
    // The file caught up.
    lease.configure(automation({ combat: true }));
    lease.onCharacter(state('yes'), true);
    expect(flips).toEqual([true]);
    // The hold wore off: handed back.
    lease.onCharacter(state('no'), true);
    expect(flips).toEqual([true, false]);
    expect(said).toHaveLength(2);
  });

  it('lends nothing when combat is already on, or nothing is walking', () => {
    lease.configure(automation({ combat: true }));
    lease.onCharacter(state('yes'), true);
    lease.configure(automation({ combat: false }));
    lease.onCharacter(state('yes'), false);
    expect(flips).toEqual([]);
  });

  it('respects the player turning it off during the lease', () => {
    lease.configure(automation({ combat: false }));
    lease.onCharacter(state('yes'), true);
    lease.configure(automation({ combat: true }));
    // The player flips it off by hand while still held.
    lease.configure(automation({ combat: false }));
    lease.onCharacter(state('no'), true);
    // Nothing handed back: the file is theirs and already says off.
    expect(flips).toEqual([true]);
  });

  it('asks nothing again when the file refused the write', () => {
    const refusing = new CombatLease({ flip: () => false, notice: (m) => said.push(m) });
    refusing.configure(automation({ combat: false }));
    refusing.onCharacter(state('yes'), true);
    refusing.onCharacter(state('no'), true);
    expect(said).toEqual([]);
  });
});

describe('arriving with auto-combat off', () => {
  it('turns it back on for a route the player asked for', () => {
    lease.configure(automation({ combat: false }));
    lease.onWalkEnded(true, true);
    expect(flips).toEqual([true]);
    expect(said).toHaveLength(1);
  });

  it("leaves a loop's leg, a walk that did not arrive, and a player who said not to alone", () => {
    lease.configure(automation({ combat: false }));
    lease.onWalkEnded(true, false);
    lease.onWalkEnded(false, true);
    lease.configure(automation({ combat: false, fightOnArrival: false }));
    lease.onWalkEnded(true, true);
    expect(flips).toEqual([]);
  });

  it('keeps combat on when the arrival comes during a hold lease', () => {
    lease.configure(automation({ combat: false }));
    lease.onCharacter(state('yes'), true);
    lease.configure(automation({ combat: true }));
    lease.onWalkEnded(true, true);
    // No second flip, and the hold ending afterwards hands nothing back.
    lease.onCharacter(state('no'), false);
    expect(flips).toEqual([true]);
  });
});

describe('run it: the switch off before the first step, and left off (todo 06)', () => {
  it('turns combat off once where the file says on, and asks nothing once it is off', () => {
    lease.configure(automation({ combat: true }));
    expect(lease.run()).toBe(true);
    expect(flips).toEqual([false]);
    // Asked, not yet answered: a second run asks nothing.
    expect(lease.run()).toBe(true);
    expect(flips).toEqual([false]);
    // The file caught up, and a run pressed with it off writes nothing.
    lease.configure(automation({ combat: false }));
    expect(lease.run()).toBe(true);
    expect(flips).toEqual([false]);
  });

  it('overtakes a lend still in flight, and hands nothing back when the hold ends', () => {
    lease.configure(automation({ combat: false }));
    lease.onCharacter(state('yes'), true);
    expect(flips).toEqual([true]);
    expect(lease.run()).toBe(true);
    expect(flips).toEqual([true, false]);
    lease.configure(automation({ combat: false }));
    lease.onCharacter(state('no'), true);
    expect(flips).toEqual([true, false]);
  });

  it("hands nothing back on a run's arrival, while a hold on the way still lends and returns", () => {
    lease.configure(automation({ combat: false }));
    lease.onWalkEnded(true, true, true);
    expect(flips).toEqual([]);
    // Held on the run: lent, arrived while still held, then the hold wears off.
    lease.onCharacter(state('yes'), true);
    lease.configure(automation({ combat: true }));
    lease.onWalkEnded(true, true, true);
    lease.onCharacter(state('no'), false);
    expect(flips).toEqual([true, false]);
    expect(said).toHaveLength(2);
  });

  it('refuses where the file will not take the write', () => {
    const refusing = new CombatLease({ flip: () => false, notice: (m) => said.push(m) });
    refusing.configure(automation({ combat: true }));
    expect(refusing.run()).toBe(false);
  });
});

/*
 * Hit and not moving with auto-combat off (todo 00, 2026-09-23): Festus stood
 * eighty-five seconds in a bandit's fight on a declined journey, and nothing
 * but losing half his health would have ended it.
 */
describe('hit for rounds without moving, with auto-combat off', () => {
  const calm: DefendFacts = {
    moveOnly: false,
    escaping: false,
    stoodDown: false,
    movePending: false,
    fighting: false
  };

  function inRoom(arrival: number): CharacterState {
    const base = state('no');
    return { ...base, room: { ...base.room, arrival } };
  }

  /** `rounds` rounds of blows, a second apart, from `from`. */
  function hit(rounds: number, from = 10_000): void {
    for (let i = 0; i < rounds; i++) lease.noteMonsterBlow(from + i * 1000);
  }

  let returned: boolean[];
  let decisions: Array<{ action: string; acted: boolean }>;
  let declined: boolean;
  beforeEach(() => {
    returned = [];
    decisions = [];
    declined = false;
    lease = new CombatLease({
      flip: (on) => {
        flips.push(on);
        return true;
      },
      notice: (message) => said.push(message),
      decided: (decision) => decisions.push(decision),
      declined: () => declined,
      returned: (was) => returned.push(was)
    });
    lease.configure(automation());
    lease.defend(inRoom(1), calm);
  });

  it('lends after the configured rounds and not before, and gives it back on arrival', () => {
    hit(1);
    lease.defend(inRoom(1), calm);
    // Positive control first: one round is below two, and nothing is asked.
    expect(flips).toEqual([]);
    hit(1, 12_000);
    lease.defend(inRoom(1), calm);
    expect(flips).toEqual([true]);
    expect(lease.lending).toBe(true);
    expect(decisions).toEqual([expect.objectContaining({ action: 'defend', acted: true })]);
    // The file answers; the character stays put and is hit again: no second ask.
    lease.configure(automation({ combat: true }));
    hit(3, 20_000);
    lease.defend(inRoom(1), calm);
    expect(flips).toEqual([true]);
    // Arrived in another room: handed back, the journey put back as it was.
    lease.defend(inRoom(2), calm);
    expect(flips).toEqual([true, false]);
    expect(returned).toEqual([false]);
    expect(said).toHaveLength(2);
  });

  it('counts a burst of blows inside one round as one round', () => {
    lease.noteMonsterBlow(10_000);
    lease.noteMonsterBlow(10_020);
    lease.noteMonsterBlow(10_040);
    lease.defend(inRoom(1), calm);
    expect(flips).toEqual([]);
  });

  it('starts counting again from each arrival', () => {
    hit(1);
    lease.defend(inRoom(2), calm);
    hit(1, 20_000);
    lease.defend(inRoom(2), calm);
    expect(flips).toEqual([]);
  });

  it('never lends with the master off, retaliation off, or at 0', () => {
    for (const config of [
      automation({ master: false }),
      automation({ retaliate: false }),
      automation({ defendAfterRounds: 0 })
    ]) {
      lease.configure(config);
      hit(3);
      lease.defend(inRoom(1), calm);
    }
    expect(flips).toEqual([]);
  });

  it('never lends under a timed spell, an escape, a break, a move in flight, or while fighting', () => {
    hit(3);
    for (const over of [
      { moveOnly: true },
      { escaping: true },
      { stoodDown: true },
      { movePending: true },
      { fighting: true }
    ]) {
      lease.defend(inRoom(1), { ...calm, ...over });
    }
    expect(flips).toEqual([]);
    // Positive control: the same rounds, nothing else holding, lends.
    lease.defend(inRoom(1), calm);
    expect(flips).toEqual([true]);
  });

  it('puts a declined journey back declined when it hands the switch back', () => {
    declined = true;
    hit(2);
    lease.defend(inRoom(1), calm);
    lease.configure(automation({ combat: true }));
    lease.defend(inRoom(2), calm);
    expect(returned).toEqual([true]);
  });

  it('hands it back on a death or a lost connection, and not twice', () => {
    hit(2);
    lease.defend(inRoom(1), calm);
    lease.configure(automation({ combat: true }));
    lease.end('lost');
    lease.end('died');
    expect(flips).toEqual([true, false]);
  });

  it('ends with nothing handed back when the player turns it off by hand', () => {
    hit(2);
    lease.defend(inRoom(1), calm);
    // The lend landing is the lease's own edge; the player's is not.
    expect(lease.configure(automation({ combat: true }))).toBe(true);
    expect(lease.configure(automation({ combat: false }))).toBe(false);
    // Still in the same room and still being hit: not lent again.
    hit(3, 30_000);
    lease.defend(inRoom(1), calm);
    lease.defend(inRoom(2), calm);
    expect(flips).toEqual([true]);
    // The next room asks afresh.
    hit(2, 60_000);
    lease.defend(inRoom(2), calm);
    expect(flips).toEqual([true, true]);
  });

  it('does not lend the rounds counted before the player turned the switch off', () => {
    lease.configure(automation({ combat: true }));
    hit(3);
    lease.configure(automation({ combat: false }));
    lease.defend(inRoom(1), calm);
    expect(flips).toEqual([]);
  });

  it('keeps a give-back the file refused, says so once, and tries again', () => {
    let writable = true;
    const stuck = new CombatLease({
      flip: (on) => {
        if (!writable) return false;
        flips.push(on);
        return true;
      },
      notice: (message) => said.push(message),
      decided: (decision) => decisions.push(decision),
      returned: (was) => returned.push(was)
    });
    stuck.configure(automation());
    stuck.defend(inRoom(1), calm);
    for (let i = 0; i < 2; i++) stuck.noteMonsterBlow(10_000 + i * 1000);
    stuck.defend(inRoom(1), calm);
    stuck.configure(automation({ combat: true }));
    writable = false;
    stuck.defend(inRoom(2), calm);
    stuck.defend(inRoom(2), calm);
    expect(stuck.lending).toBe(true);
    expect(said.filter((m) => m.includes('could not be turned back off'))).toHaveLength(1);
    writable = true;
    stuck.defend(inRoom(2), calm);
    expect(flips).toEqual([true, false]);
    expect(stuck.lending).toBe(false);
  });

  it('leaves combat on when a route the player asked for arrives during the lease', () => {
    hit(2);
    lease.defend(inRoom(1), calm);
    lease.configure(automation({ combat: true }));
    // The walker has the arrival first: the destination wants combat on.
    lease.onWalkEnded(true, true);
    lease.defend(inRoom(2), calm);
    expect(flips).toEqual([true]);
  });

  it('says a file that will not take the write once, in the trace', () => {
    const refusing = new CombatLease({
      flip: () => false,
      notice: (m) => said.push(m),
      decided: (decision) => decisions.push(decision)
    });
    refusing.configure(automation());
    refusing.defend(inRoom(1), calm);
    for (let i = 0; i < 4; i++) refusing.noteMonsterBlow(10_000 + i * 1000);
    refusing.defend(inRoom(1), calm);
    // More rounds in the same room ask nothing again.
    for (let i = 0; i < 4; i++) refusing.noteMonsterBlow(20_000 + i * 1000);
    refusing.defend(inRoom(1), calm);
    expect(decisions).toEqual([expect.objectContaining({ action: 'defend', acted: false })]);
    expect(said).toEqual([]);
  });
});
