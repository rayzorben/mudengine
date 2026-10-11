import { afterEach, describe, expect, it, vi } from 'vitest';
import { Attendance } from '../Attendance';

const MINUTE = 60_000;

/* Todo 79: whether anybody is at the keyboard, read by the reply and the hang-up alike. */
describe('whether anybody is at the keyboard', () => {
  it('is away once no key has been pressed for the minutes, and back at the first key', () => {
    let clock = 1_700_000_000_000;
    const attendance = new Attendance(5, undefined, () => clock);
    attendance.note();
    clock += 4 * MINUTE;
    expect(attendance.away).toBe(false);
    clock += 1 * MINUTE;
    expect(attendance.away).toBe(true);
    attendance.note();
    expect(attendance.away).toBe(false);
  });

  it('is never away before the realm, and forgets on reset', () => {
    let clock = 1_700_000_000_000;
    const attendance = new Attendance(5, undefined, () => clock);
    clock += 60 * MINUTE;
    expect(attendance.away).toBe(false);
    attendance.note();
    clock += 6 * MINUTE;
    expect(attendance.away).toBe(true);
    attendance.reset();
    expect(attendance.away).toBe(false);
  });

  it('reads a reloaded figure', () => {
    let clock = 1_700_000_000_000;
    const attendance = new Attendance(5, undefined, () => clock);
    attendance.note();
    clock += 2 * MINUTE;
    attendance.configure(1);
    expect(attendance.away).toBe(true);
  });

  it('says each flip when it happens, and nothing after a reset', () => {
    vi.useFakeTimers();
    let flips = 0;
    const attendance = new Attendance(5, () => void flips++);
    attendance.note();
    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(flips).toBe(0);
    vi.advanceTimersByTime(1);
    expect([flips, attendance.away]).toEqual([1, true]);
    attendance.note();
    expect([flips, attendance.away]).toEqual([2, false]);
    attendance.reset();
    vi.advanceTimersByTime(10 * MINUTE);
    expect(flips).toBe(2);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
