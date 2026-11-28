import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DebugRecord } from '../../../shared/debug';
import { activityLine, WIRE_KINDS } from '../../../shared/debug';
import type { LoopProgress } from '../../../shared/loops';
import { SessionDebug } from '../SessionDebug';

let records: DebugRecord[] = [];
let debug = new SessionDebug((record) => records.push(record));

beforeEach(() => {
  vi.useFakeTimers();
  records = [];
  debug = new SessionDebug((record) => records.push(record));
});
afterEach(() => vi.useRealTimers());

const loop = (over: Partial<LoopProgress>): LoopProgress =>
  ({
    status: 'running',
    name: 'black-caves',
    stop: 1,
    stops: 4,
    stopName: 'Cave',
    laps: 0,
    reason: null,
    hold: null,
    ...over
  }) as LoopProgress;

describe('what the activity record holds', () => {
  it('records a loop that starts, and then why it stands still', () => {
    debug.loop(loop({}));
    debug.loop(loop({}));
    debug.loop(loop({ hold: 'mana' }));
    expect(records.map((r) => `${r.tag}: ${r.text}`)).toEqual([
      'loop: running, black-caves, stop 1/4, to Cave, lap 0',
      'loop: running, black-caves, stop 1/4, to Cave, hold mana, lap 0'
    ]);
  });

  it('records a refused command once, then counts the repeats', () => {
    debug.refusal('n', 'switched-off', 'walk');
    debug.refusal('n', 'switched-off', 'walk');
    debug.refusal('n', 'switched-off', 'walk');
    expect(records.map((r) => r.text)).toEqual(['n [walk] switched-off']);
    vi.advanceTimersByTime(31_000);
    debug.refusal('n', 'switched-off', 'walk');
    expect(records.at(-1)?.text).toBe('n [walk] switched-off (2 more since)');
  });

  it('records a setting that changed, not the first read', () => {
    debug.settings({ health: { restBelow: 0.5 } });
    expect(records).toEqual([]);
    debug.settings({ health: { restBelow: 0.4 } });
    expect(records.map((r) => r.text)).toEqual(['health.restBelow: 0.5 → 0.4']);
  });

  it('records a closed ui word that changed, under ui', () => {
    debug.settings({}, { routeView: 'legs' });
    debug.settings({}, { routeView: 'forecast' });
    expect(records.map((r) => r.text)).toEqual(['ui.routeView: "legs" → "forecast"']);
  });

  it('writes a record as one line, and keeps wire text out of the activity file', () => {
    debug.action('call', 'loop:start "x"');
    expect(activityLine(records[0]!)).toBe('event call loop:start "x"\n');
    expect(WIRE_KINDS).toEqual(['in', 'line', 'block']);
  });
});
