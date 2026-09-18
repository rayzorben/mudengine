import { beforeEach, describe, expect, it } from 'vitest';

import { CombatLease } from '../CombatLease';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

/*
 * Auto-combat lent for a hold and given back on arrival (todos 07 and 11,
 * 2026-09-17). The switch is the character's file: every flip here is a
 * request the file answers on its next reload, which `configure` stands for.
 */

function automation(over: { combat?: boolean; fightOnArrival?: boolean } = {}): AutomationConfig {
  const base = DEFAULT_CONFIG.automation;
  return {
    ...base,
    combat: { ...base.combat, enabled: over.combat ?? false },
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
