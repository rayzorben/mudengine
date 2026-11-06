import { describe, expect, it } from 'vitest';

import { UnnamedCasts } from '../UnnamedCasts';
import type { Block } from '../../../shared/blocks';

function block(type: string, groups: Record<string, string> = {}): Block {
  return { seq: 1, at: 0, type, domain: 'combat', groups, text: '', confidence: 1 } as Block;
}

const SOUL_RIP = { key: 'soul rip', ids: [211], castStart: 3086 };
const mine = block('realm-message', { message: '3086', role: '1' });
const theirs = block('realm-message', { message: '3086', role: '3', fills: 'Fatyoshi' });
const rip = block('user-hits', {
  line: 'A strange force rips into bone snake',
  spells: '211|5033'
});

describe('UnnamedCasts', () => {
  it('counts each landing after this character’s start line', () => {
    const casts = new UnnamedCasts();
    expect(casts.heard(mine, SOUL_RIP)).toBe(false);
    expect([casts.heard(rip, SOUL_RIP), casts.heard(rip, SOUL_RIP)]).toEqual([true, true]);
  });

  it('counts none after another caster’s start line (the control)', () => {
    const casts = new UnnamedCasts();
    casts.heard(mine, SOUL_RIP);
    casts.heard(theirs, SOUL_RIP);
    expect([casts.heard(rip, SOUL_RIP), casts.heard(rip, SOUL_RIP)]).toEqual([false, false]);
  });

  it('counts none with no start line, after a fizzle, or for a landing naming its attacker', () => {
    const casts = new UnnamedCasts();
    expect(casts.heard(rip, SOUL_RIP)).toBe(false);
    casts.heard(mine, SOUL_RIP);
    casts.heard(block('spell-failed', { spell: 'soul rip' }), SOUL_RIP);
    expect(casts.heard(rip, SOUL_RIP)).toBe(false);
    casts.heard(mine, SOUL_RIP);
    expect(casts.heard(block('user-hits', { ...rip.groups, attacker: 'Soul' }), SOUL_RIP)).toBe(
      false
    );
  });

  it('counts none for a spell whose start line the table lacks', () => {
    const casts = new UnnamedCasts();
    casts.heard(mine, { ...SOUL_RIP, castStart: null });
    expect(casts.heard(rip, { ...SOUL_RIP, castStart: null })).toBe(false);
  });
});
