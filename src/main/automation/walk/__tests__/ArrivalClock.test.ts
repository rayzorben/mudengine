import { describe, expect, it } from 'vitest';

import { ArrivalClock } from '../ArrivalClock';

describe('when a walk is expected to end', () => {
  it('is unknown before a step is confirmed, and after the last', () => {
    const clock = new ArrivalClock();
    expect(clock.arrivalAt(0, 5)).toBeNull();
    clock.begin(1_000);
    expect(clock.arrivalAt(0, 5)).toBeNull();
    clock.stepped(2_500);
    expect(clock.arrivalAt(1, 0)).toBeNull();
  });

  it('projects the steps left at the average since the walk began', () => {
    const clock = new ArrivalClock();
    clock.begin(1_000);
    clock.stepped(2_500);
    expect(clock.arrivalAt(1, 4)).toBe(2_500 + 1_500 * 4);
    // A fight on the second step is in the average from then on.
    clock.stepped(42_500);
    expect(clock.arrivalAt(2, 3)).toBe(42_500 + ((42_500 - 1_000) / 2) * 3);
  });

  it('projects a plan redrawn to another length from the same average', () => {
    const clock = new ArrivalClock();
    clock.begin(0);
    clock.stepped(2_000);
    expect(clock.arrivalAt(1, 10)).toBe(22_000);
    expect(clock.arrivalAt(1, 3)).toBe(8_000);
  });

  it('starts the next walk from nothing', () => {
    const clock = new ArrivalClock();
    clock.begin(0);
    clock.stepped(2_000);
    clock.begin(5_000);
    expect(clock.arrivalAt(0, 1)).toBeNull();
    clock.stepped(8_000);
    expect(clock.arrivalAt(1, 1)).toBe(11_000);
  });
});
