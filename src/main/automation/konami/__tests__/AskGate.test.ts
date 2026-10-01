import { describe, expect, it } from 'vitest';

import { AskGate } from '../AskGate';

const gate = (): AskGate => new AskGate(() => ({ retryMs: 1_000, retryMaxMs: 3_000 }));

describe('the ask gate', () => {
  it('holds a call after a failure, doubling up to the most', () => {
    const it = gate();
    expect(it.heldUntil(0)).toBeNull();
    expect(it.failed(0)).toBe(1_000);
    expect(it.heldUntil(500)).toBe(1_000);
    expect(it.heldUntil(1_000)).toBeNull();
    expect(it.failed(1_000)).toBe(3_000);
    expect(it.failed(3_000)).toBe(6_000);
  });

  it('starts over after a plan is made, and after a reset', () => {
    const it = gate();
    it.failed(0);
    it.failed(1_000);
    it.planned('a');
    expect(it.heldUntil(1_500)).toBeNull();
    expect(it.failed(2_000)).toBe(3_000);
    it.reset();
    expect(it.heldUntil(2_500)).toBeNull();
    expect(it.unchanged('a')).toBe(false);
    expect(it.failed(4_000)).toBe(5_000);
  });

  it('knows the substance the last plan was made over', () => {
    const it = gate();
    it.planned('a');
    expect(it.unchanged('a')).toBe(true);
    expect(it.unchanged('b')).toBe(false);
  });

  it('lets the player and a death past a failure', () => {
    const it = gate();
    it.failed(0);
    it.release();
    expect(it.heldUntil(10)).toBeNull();
  });
});
