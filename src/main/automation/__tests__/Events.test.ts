import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Events } from '../Events';
import type { ScheduledEvent } from '../../../shared/events';
import { CommandQueue } from '../CommandQueue';
import { DEFAULT_CONFIG, type AutomationConfig } from '../../../shared/config';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';

const automation: AutomationConfig = {
  ...DEFAULT_CONFIG.automation,
  pacing: { window: 8, minGapMs: 0, ackTimeoutMs: 1000 }
};

function state(over: Partial<CharacterState> = {}): CharacterState {
  return { ...structuredClone(EMPTY_CHARACTER), phase: 'in-game', ...over };
}

let sent: string[];
let queue: CommandQueue;
let clock: number;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  clock = new Date('2026-08-27T09:00:00').getTime();
  // The queue compares expiry against Date.now(); without this the test's
  // injected clock and the fake Date drift apart by however far the real
  // clock stands from 09:00 — a test that passed all night and expired at
  // breakfast.
  vi.setSystemTime(clock);
  queue = new CommandQueue(automation, { send: (command) => sent.push(command) });
});
afterEach(() => {
  queue.dispose();
  vi.useRealTimers();
});

const make = (events: ScheduledEvent[], enabled = true): Events =>
  new Events(events, enabled, queue, () => clock);
const drain = () => void vi.advanceTimersByTime(500);

describe('a timed event', () => {
  const roster: ScheduledEvent[] = [{ name: 'roster', command: 'party', everySeconds: 60 }];

  it('sends its command when it comes due, and not before', () => {
    const events = make(roster);
    events.onCharacter(state());
    clock += 59_000;
    events.check();
    drain();
    expect(sent).toEqual([]);
    clock += 2_000;
    events.check();
    drain();
    expect(sent).toEqual(['party']);
  });

  it('holds while fighting unless told otherwise', () => {
    const events = make(roster);
    events.onCharacter(state());
    clock += 61_000;
    events.onCharacter(state({ inCombat: true }));
    events.check();
    drain();
    expect(sent).toEqual([]);
    events.onCharacter(state());
    events.check();
    drain();
    expect(sent).toEqual(['party']);
  });

  it('does nothing outside the realm, or when automation is off', () => {
    const off = make(roster, false);
    off.onCharacter(state());
    clock += 61_000;
    off.check();
    const outside = make(roster);
    outside.onCharacter(state({ phase: 'unknown' }));
    outside.check();
    drain();
    expect(sent).toEqual([]);
  });

  it('fires once per interval however often the clock is checked', () => {
    const events = make(roster);
    events.onCharacter(state());
    clock += 61_000;
    events.check();
    events.check();
    events.check();
    drain();
    expect(sent).toEqual(['party']);
  });
});
