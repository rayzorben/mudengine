import { describe, expect, it } from 'vitest';

import { restoreQueue } from '../restore';

/*
 * One restored backscroll at a time, the shown console's first (todo 02,
 * 2026-09-23): four written at once parsed side by side and the console on
 * screen finished last among equals.
 */
describe('the restore queue', () => {
  function job(name: string, shown: boolean, ran: string[], finish: Map<string, () => void>) {
    return {
      shown: () => shown,
      run: (done: () => void) => {
        ran.push(name);
        finish.set(name, done);
      }
    };
  }

  it('runs one at a time, the shown console first among those waiting', () => {
    const queue = restoreQueue();
    const ran: string[] = [];
    const finish = new Map<string, () => void>();
    queue.add(job('a', false, ran, finish));
    queue.add(job('b', false, ran, finish));
    queue.add(job('c', true, ran, finish));
    // `a` took the free slot; nothing else runs beside it.
    expect(ran).toEqual(['a']);
    finish.get('a')!();
    expect(ran).toEqual(['a', 'c']);
    finish.get('c')!();
    expect(ran).toEqual(['a', 'c', 'b']);
  });

  it('takes a waiting job back, and frees the slot of a running one', () => {
    const queue = restoreQueue();
    const ran: string[] = [];
    const finish = new Map<string, () => void>();
    const takeA = queue.add(job('a', false, ran, finish));
    const takeB = queue.add(job('b', false, ran, finish));
    queue.add(job('c', false, ran, finish));
    takeB();
    // A console disposed mid-restore never calls back; the next one runs.
    takeA();
    expect(ran).toEqual(['a', 'c']);
    // A late callback from the taken-back job moves nothing.
    finish.get('a')!();
    expect(ran).toEqual(['a', 'c']);
  });

  it('keeps the slot for a shown console whose attach has not arrived', () => {
    const queue = restoreQueue();
    const ran: string[] = [];
    const finish = new Map<string, () => void>();
    const letGo = queue.hold();
    queue.add(job('hidden', false, ran, finish));
    expect(ran).toEqual([]);
    queue.add(job('shown', true, ran, finish));
    letGo();
    letGo();
    expect(ran).toEqual(['shown']);
    finish.get('shown')!();
    expect(ran).toEqual(['shown', 'hidden']);
  });
});
