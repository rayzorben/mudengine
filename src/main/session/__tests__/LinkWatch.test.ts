import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkWatch } from '../LinkWatch';
import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';

/**
 * Asserted against the **shipped** fifteen seconds rather than a short number
 * injected for the test, for the reason `Reconnect.test.ts` gives: the schedule
 * somebody actually runs is the half worth pinning.
 */
const AFTER = DEFAULT_INTERNAL.tuning.reconnect.silentForMs;

let dead: number[] = [];

function build(): LinkWatch {
  return new LinkWatch({ dead: (seconds) => dead.push(seconds) });
}

beforeEach(() => {
  vi.useFakeTimers();
  dead = [];
});

afterEach(() => {
  vi.useRealTimers();
  setTuning(DEFAULT_INTERNAL.tuning);
});

describe('LinkWatch', () => {
  it('calls a command that goes unanswered a dead link', () => {
    const watch = build();
    watch.noteSent();
    expect(watch.waiting).toBe(true);

    vi.advanceTimersByTime(AFTER - 1);
    expect(dead).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(dead).toEqual([AFTER / 1000]);
    expect(watch.waiting).toBe(false);
  });

  it('is answered by any byte, not only by a reply to the command', () => {
    const watch = build();
    watch.noteSent();
    vi.advanceTimersByTime(AFTER - 1);
    // The unprompted status-line repaint this realm sends every thirty seconds
    // is as good an answer to "is anything there" as a reply would be.
    watch.noteReceived();
    vi.advanceTimersByTime(AFTER * 2);
    expect(dead).toEqual([]);
    expect(watch.waiting).toBe(false);
  });

  it('owes the deadline to the oldest unanswered command', () => {
    const watch = build();
    watch.noteSent();
    vi.advanceTimersByTime(AFTER - 1);
    // A character meditating every three seconds must not be able to hold a
    // dead link open for ever by sending into it.
    watch.noteSent();
    vi.advanceTimersByTime(1);
    expect(dead).toEqual([AFTER / 1000]);
  });

  it('counts nothing until something is sent', () => {
    const watch = build();
    vi.advanceTimersByTime(AFTER * 4);
    expect(dead).toEqual([]);
    expect(watch.waiting).toBe(false);
  });

  it('is switched off by a zero threshold', () => {
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      reconnect: { ...DEFAULT_INTERNAL.tuning.reconnect, silentForMs: 0 }
    });
    const watch = build();
    watch.noteSent();
    expect(watch.waiting).toBe(false);
    vi.advanceTimersByTime(AFTER * 4);
    expect(dead).toEqual([]);
  });

  it('reads the threshold at each arm, so an edit reaches a running session', () => {
    const watch = build();
    setTuning({
      ...DEFAULT_INTERNAL.tuning,
      reconnect: { ...DEFAULT_INTERNAL.tuning.reconnect, silentForMs: 4_000 }
    });
    watch.noteSent();
    vi.advanceTimersByTime(4_000);
    expect(dead).toEqual([4]);
  });

  it('owes nothing across a socket, and releases its timer', () => {
    const watch = build();
    watch.noteSent();
    watch.reset();
    vi.advanceTimersByTime(AFTER * 2);
    expect(dead).toEqual([]);

    watch.noteSent();
    watch.dispose();
    vi.advanceTimersByTime(AFTER * 2);
    expect(dead).toEqual([]);
  });
});
