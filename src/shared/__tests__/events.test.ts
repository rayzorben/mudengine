import { describe, expect, it } from 'vitest';

import { asEvents, dueAt, type ScheduledEvent } from '../events';

describe('reading events out of the options file', () => {
  it('takes an interval or a time of day', () => {
    const events = asEvents([
      { name: 'roster', command: 'party', everySeconds: 120 },
      { name: 'nightly', command: 'save', at: '3:30' }
    ]);
    expect(events).toEqual([
      { name: 'roster', command: 'party', everySeconds: 120 },
      { name: 'nightly', command: 'save', at: '3:30' }
    ]);
  });

  it('never lets one outrun the server’s acknowledgement', () => {
    expect(asEvents([{ name: 'a', command: 'l', everySeconds: 0.2 }])[0]?.everySeconds).toBe(5);
  });

  it('drops what is not an event', () => {
    // No clock at all, no command, no name, not an object: none of these fires.
    expect(asEvents([{ name: 'a', command: 'l' }])).toEqual([]);
    expect(asEvents([{ name: 'a', everySeconds: 60 }])).toEqual([]);
    expect(asEvents([{ command: 'l', everySeconds: 60 }])).toEqual([]);
    expect(asEvents([{ name: 'a', command: 'l', at: '25:00' }])).toEqual([]);
    expect(asEvents('nope')).toEqual([]);
  });
});

describe('when an event is due', () => {
  const every = (seconds: number): ScheduledEvent => ({
    name: 'e',
    command: 'l',
    everySeconds: seconds
  });
  const start = new Date('2026-08-27T09:00:00').getTime();

  it('counts from the session start until it has fired once', () => {
    expect(dueAt(every(60), start + 59_000, 0, start)).toBe(false);
    expect(dueAt(every(60), start + 60_000, 0, start)).toBe(true);
    expect(dueAt(every(60), start + 90_000, start + 60_000, start)).toBe(false);
    expect(dueAt(every(60), start + 121_000, start + 60_000, start)).toBe(true);
  });

  it('honours disabled without deleting it', () => {
    expect(dueAt({ ...every(1), disabled: true }, start + 60_000, 0, start)).toBe(false);
  });

  it('fires a daily event once its time has passed, and not again that day', () => {
    const at: ScheduledEvent = { name: 'd', command: 'save', at: '10:00' };
    const ten = new Date('2026-08-27T10:00:00').getTime();
    expect(dueAt(at, ten - 1000, 0, start)).toBe(false);
    expect(dueAt(at, ten + 1000, 0, start)).toBe(true);
    expect(dueAt(at, ten + 60_000, ten + 1000, start)).toBe(false);
  });

  it('does not fire this morning’s event for a session started this afternoon', () => {
    const at: ScheduledEvent = { name: 'd', command: 'save', at: '10:00' };
    const afternoon = new Date('2026-08-27T14:00:00').getTime();
    expect(dueAt(at, afternoon, 0, afternoon)).toBe(false);
  });
});
