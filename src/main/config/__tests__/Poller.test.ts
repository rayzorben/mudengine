import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Poller } from '../Poller';
import type { Watched } from '../revision';

let dir: string;
let file: string;
let pollers: Poller[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-poller-'));
  file = path.join(dir, 'default.yaml');
  fs.writeFileSync(file, 'a: 1\n');
  pollers = [];
});

afterEach(() => {
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
});
