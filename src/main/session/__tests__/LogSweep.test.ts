import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LogSweep, sweepLogs, type LogKeeping } from '../LogSweep';
import { CAPTURE_SUFFIX, isSessionRecord, LOG_SUFFIX, slug, stamp } from '../filename';
import { DAY_MS } from '../../../shared/values';

const NOW = new Date('2026-10-05T12:00:00Z').getTime();

let dir = '';

/** A file in the sweep's folder, last written `daysAgo` before `NOW`. */
const write = (name: string, daysAgo: number): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x');
  const at = new Date(NOW - daysAgo * DAY_MS);
  fs.utimesSync(file, at, at);
  return name;
};

const left = (): string[] => fs.readdirSync(dir).sort();

/** The name the writers give a session started `daysAgo` before `NOW`. */
const named = (label: string, suffix: string, daysAgo: number): string =>
  `${stamp(new Date(NOW - daysAgo * DAY_MS))}_${slug(label)}${suffix}`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-sweep-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isSessionRecord', () => {
  it('accepts the names the log and the capture write, and nothing else', () => {
    expect(isSessionRecord(named('festus', LOG_SUFFIX, 0))).toBe(true);
    expect(isSessionRecord(named('festus', CAPTURE_SUFFIX, 0))).toBe(true);
    expect(isSessionRecord(named('bbs.bearfather.net_23', LOG_SUFFIX, 0))).toBe(true);
    expect(isSessionRecord('stalls.log')).toBe(false);
    expect(isSessionRecord('debug-festus-2026-10-05T12-00-00-000Z.txt')).toBe(false);
    expect(isSessionRecord('2026-10-05_06-01-22_.log')).toBe(false);
    expect(isSessionRecord('2026-10-05_06-01-22_festus.jsonl')).toBe(false);
    expect(isSessionRecord('notes 2026-10-05_06-01-22_festus.log')).toBe(false);
  });
});

describe('sweepLogs', () => {
  it('deletes the session records last written before the window, and only those', async () => {
    const oldLog = write(named('festus', LOG_SUFFIX, 30), 30);
    const oldCapture = write(named('festus', CAPTURE_SUFFIX, 30), 8);
    // Started long ago, written to today: still being written, so kept.
    const running = write(named('main', CAPTURE_SUFFIX, 20), 0);
    const fresh = write(named('main', LOG_SUFFIX, 1), 1);
    const theirs = write('my notes.log', 90);
    const report = write('debug-festus-2026-08-01T00-00-00-000Z.txt', 90);
    fs.mkdirSync(path.join(dir, 'stalls'));

    const swept = await sweepLogs(dir, 7, NOW);

    expect(swept).toEqual({ deleted: 2, failed: null });
    expect(left()).toEqual([fresh, running, report, theirs, 'stalls'].sort());
    expect(left()).not.toContain(oldLog);
    expect(left()).not.toContain(oldCapture);
  });

  it('keeps everything at 0 days', async () => {
    const old = write(named('festus', LOG_SUFFIX, 400), 400);
    expect(await sweepLogs(dir, 0, NOW)).toEqual({ deleted: 0, failed: null });
    expect(left()).toEqual([old]);
  });

  it('stops between files once told to', async () => {
    write(named('festus', LOG_SUFFIX, 30), 30);
    write(named('main', LOG_SUFFIX, 30), 30);
    let looked = 0;
    const swept = await sweepLogs(dir, 7, NOW, () => looked++ > 0);
    expect(swept.deleted).toBe(1);
    expect(left()).toHaveLength(1);
  });

  it('has nothing to sweep in a folder that is not there', async () => {
    expect(await sweepLogs(path.join(dir, 'never'), 7, NOW)).toEqual({ deleted: 0, failed: null });
  });
});

describe('LogSweep', () => {
  const sweeper = (keeping: () => LogKeeping, notices: Array<'log' | 'warn'>): LogSweep =>
    new LogSweep({ keeping, notice: (_message, level) => notices.push(level), now: () => NOW });

  it('says what it deleted once per sweep, and nothing when nothing went', async () => {
    write(named('festus', LOG_SUFFIX, 10), 10);
    write(named('festus', CAPTURE_SUFFIX, 10), 10);
    const notices: Array<'log' | 'warn'> = [];
    const sweep = sweeper(() => ({ directory: dir, keepDays: 7 }), notices);

    await sweep.sweep();
    await sweep.sweep();

    expect(left()).toEqual([]);
    expect(notices).toEqual(['log']);
    sweep.dispose();
  });

  it('runs a request made during a sweep after it, under the settings asked for', async () => {
    write(named('festus', LOG_SUFFIX, 3), 3);
    const notices: Array<'log' | 'warn'> = [];
    let keepDays = 7;
    const sweep = sweeper(() => ({ directory: dir, keepDays }), notices);

    const first = sweep.sweep();
    keepDays = 2;
    const second = sweep.sweep();
    expect(second).not.toBe(first);
    expect(sweep.sweep()).toBe(second);
    await second;

    expect(left()).toEqual([]);
    sweep.dispose();
  });

  it('still runs a request made during a sweep that threw', async () => {
    write(named('festus', LOG_SUFFIX, 30), 30);
    let asked = 0;
    const sweep = sweeper(() => {
      asked += 1;
      if (asked === 1) throw new Error('no settings yet');
      return { directory: dir, keepDays: 7 };
    }, []);

    const first = sweep.sweep();
    const second = sweep.sweep();
    await expect(first).rejects.toThrow('no settings yet');
    await second;

    expect(left()).toEqual([]);
    sweep.dispose();
  });

  it('reports a folder it cannot read', async () => {
    const file = write('not-a-folder', 0);
    const notices: Array<'log' | 'warn'> = [];
    const sweep = sweeper(() => ({ directory: path.join(dir, file), keepDays: 7 }), notices);

    await sweep.sweep();

    expect(notices).toEqual(['warn']);
    sweep.dispose();
  });

  it('keeps one clock however often it is started, and none once disposed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const sweep = sweeper(() => ({ directory: dir, keepDays: 7 }), []);
      sweep.start();
      sweep.start();
      expect(vi.getTimerCount()).toBe(1);
      sweep.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweeps nothing once disposed', async () => {
    const old = write(named('festus', LOG_SUFFIX, 30), 30);
    const sweep = sweeper(() => ({ directory: dir, keepDays: 7 }), []);
    sweep.dispose();

    await sweep.sweep();

    expect(left()).toEqual([old]);
  });
});
