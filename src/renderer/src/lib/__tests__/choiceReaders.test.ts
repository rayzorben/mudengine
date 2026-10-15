import { describe, expect, it } from 'vitest';

import { combatCaps, combatChoiceFields, combatChoices, DEFAULT_CONFIG } from '@shared/config';
import {
  DEFAULT_LOOP_CHOICES,
  DEFAULT_MOVEMENT_CHOICES,
  loopChoices,
  movementChoices
} from '@shared/walkChoices';
import { percentOf, shareOf } from '../form';

/*
 * What `ChoiceFields` does with a keystroke: the typed text (a share through
 * `shareOf`) laid over the block's figures and read back through the block's
 * own reader, so a cleared field saves as the shipped figure and an
 * out-of-range one as the nearest allowed.
 */
function typed<T extends object>(
  read: (raw: Record<string, unknown>) => T,
  values: T,
  field: keyof T & string,
  text: string,
  share = false
): T {
  return read({ ...values, [field]: share ? shareOf(text) : text });
}

describe('a settings figure read back through its block', () => {
  const movement = DEFAULT_MOVEMENT_CHOICES;

  it('takes a typed share as a percent and keeps the switches', () => {
    const next = typed(
      movementChoices,
      { ...movement, pullLevers: false },
      'anotherWayLonger',
      '75',
      true
    );
    expect(next.anotherWayLonger).toBe(0.75);
    expect(percentOf(next.anotherWayLonger)).toBe(75);
    expect(next.pullLevers).toBe(false);
  });

  it('saves a cleared field as the shipped figure, never 0', () => {
    expect(typed(movementChoices, movement, 'fightCost', '').fightCost).toBe(movement.fightCost);
    expect(typed(movementChoices, movement, 'disarmDoubt', '', true).disarmDoubt).toBe(
      movement.disarmDoubt
    );
    expect(typed(loopChoices, DEFAULT_LOOP_CHOICES, 'failedLegs', '').failedLegs).toBe(
      DEFAULT_LOOP_CHOICES.failedLegs
    );
  });

  it('saves an out-of-range figure as the nearest allowed', () => {
    expect(typed(movementChoices, movement, 'anotherWayPenalty', '0').anotherWayPenalty).toBe(1);
    expect(typed(loopChoices, DEFAULT_LOOP_CHOICES, 'minExpPerHour', '-5').minExpPerHour).toBe(0);
    const caps = combatCaps({ ...DEFAULT_CONFIG.automation.combat });
    expect(typed(combatCaps, caps, 'maxTargetHealth', '9999999').maxTargetHealth).toBe(1_000_000);
  });

  it('keeps the risky line while the safe one is typed a digit at a time', () => {
    const combat = {
      ...combatChoices({ ...DEFAULT_CONFIG.automation.combat }),
      safeOddsAbove: 0.5,
      riskyOddsAbove: 0.4
    };
    const seven = typed(combatChoiceFields, combat, 'safeOddsAbove', '7', true);
    expect(seven.riskyOddsAbove).toBe(0.4);
    const seventy = typed(combatChoiceFields, seven, 'safeOddsAbove', '70', true);
    expect(seventy).toMatchObject({ safeOddsAbove: 0.7, riskyOddsAbove: 0.4 });
  });

  it('holds the risky line under the safe one in what is saved', () => {
    const combat = combatChoiceFields({ safeOddsAbove: 0.1, riskyOddsAbove: 0.4 });
    expect(combatChoices(combat)).toMatchObject({ safeOddsAbove: 0.1, riskyOddsAbove: 0.1 });
  });
});
