import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_INTERNAL } from '../../../shared/internal';
import { setTuning } from '../../app/tuning';
import { Poller } from '../Poller';
import type { Watched } from '../revision';

/** Off, a test's checks run only when it asks: no directory watch nudges one. */
const watch = vi.hoisted(() => ({ on: true }));
vi.mock('../revision', async (original) => {
  const real = await original<typeof import('../revision')>();
  return {
    ...real,
    directoriesOf: (watched: readonly Watched[]) =>
      watch.on ? real.directoriesOf(watched) : Promise.resolve(new Map())
  };
});

let dir: string;
let file: string;
let pollers: Poller[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-poller-'));
  file = path.join(dir, 'default.yaml');
  fs.writeFileSync(file, 'a: 1\n');
  pollers = [];
});

/** The fallback poll at `ms`, so a test can say which way in a reload came. */
function pollEvery(ms: number): void {
  setTuning({
    ...DEFAULT_INTERNAL.tuning,
    files: { ...DEFAULT_INTERNAL.tuning.files, pollIntervalMs: ms }
  });
}

afterEach(() => {
  watch.on = true;
  setTuning(DEFAULT_INTERNAL.tuning);
  for (const poller of pollers) poller.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(watched: () => readonly Watched[] = () => [{ kind: 'file', path: file }]) {
  const reload = vi.fn();
  const poller = new Poller({ watched, reload });
  pollers.push(poller);
  poller.settle();
  poller.start();
  return { poller, reload };
}

/** Until `reload` has run, or the timeout. */
async function reloaded(reload: ReturnType<typeof vi.fn>, times = 1): Promise<void> {
  for (let tries = 0; tries < 200 && reload.mock.calls.length < times; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Poller', () => {
  it('reloads after an edit and not before', async () => {
    const { poller, reload } = open();
    await poller.poll();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reload).not.toHaveBeenCalled();

    fs.writeFileSync(file, 'a: 22\n');
    await poller.poll();
    await reloaded(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('drops a poll that began before a settle, since it read the files first', async () => {
    const { poller, reload } = open();
    fs.writeFileSync(file, 'a: 22\n');
    const begun = poller.poll();
    // The store read the edit itself and settled on it while the poll was out.
    poller.settle();
    await begun;
    await poller.poll();
    // The positive control: a later edit still reloads, so the absence above is real.
    fs.writeFileSync(file, 'a: 333\n');
    await poller.poll();
    await reloaded(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('runs one poll at a time', async () => {
    let asked = 0;
    const { poller } = open(() => {
      asked += 1;
      return [{ kind: 'file', path: file }];
    });
    const before = asked;
    await Promise.all([poller.poll(), poller.poll(), poller.poll()]);
    expect(asked - before).toBe(1);
  });

  it('schedules nothing from a poll that ends after stop', async () => {
    const { poller, reload } = open();
    fs.writeFileSync(file, 'a: 22\n');
    const begun = poller.poll();
    poller.stop();
    await begun;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps watching when the store’s own description throws', async () => {
    let broken = true;
    const { poller, reload } = open(() => {
      if (broken) throw new Error('no home yet');
      return [{ kind: 'file', path: file }];
    });
    await expect(poller.poll()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reload).not.toHaveBeenCalled();

    broken = false;
    await poller.poll();
    await reloaded(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('notices a save by rename through the directory watch, the poll an hour away', async () => {
    pollEvery(3_600_000);
    const { reload } = open();
    // What vim, JetBrains and the client's own write do: a new file renamed over the old.
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, 'a: 22\n');
    fs.renameSync(temporary, file);
    await reloaded(reload);
    expect(reload).toHaveBeenCalledTimes(1);
    // And again, which a watch on the file itself would have lost at the first rename.
    fs.writeFileSync(temporary, 'a: 333\n');
    fs.renameSync(temporary, file);
    await reloaded(reload, 2);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('keeps polling where no watch can start', async () => {
    // Longer than the debounce, which each check that sees the change starts again.
    pollEvery(200);
    const missing = path.join(dir, 'later', 'default.yaml');
    const { reload } = open(() => [{ kind: 'file', path: missing }]);
    // Nothing watches `later/` (it is not there) or `dir` (not one of the store's).
    fs.mkdirSync(path.dirname(missing));
    fs.writeFileSync(missing, 'a: 1\n');
    await reloaded(reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('settles its own write of one file, and still reloads a hand edit to another', async () => {
    pollEvery(3_600_000);
    watch.on = false;
    const other = path.join(dir, 'other.yaml');
    fs.writeFileSync(other, 'b: 1\n');
    const { poller, reload } = open(() => [
      { kind: 'file', path: file },
      { kind: 'file', path: other }
    ]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const debounced = (): void => {
      vi.advanceTimersByTime(DEFAULT_INTERNAL.tuning.files.debounceMs);
    };
    try {
      fs.writeFileSync(file, 'a: 22\n');
      poller.settleFile(file);
      await poller.poll();
      debounced();
      expect(reload).not.toHaveBeenCalled();

      // The positive control: a hand edit to the other file in the same window reloads.
      fs.writeFileSync(other, 'b: 22\n');
      fs.writeFileSync(file, 'a: 333\n');
      poller.settleFile(file);
      await poller.poll();
      debounced();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
