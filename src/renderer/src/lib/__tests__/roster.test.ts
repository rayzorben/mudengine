import { describe, expect, it } from 'vitest';

import { keepRoster } from '../roster';
import { EMPTY_CHARACTER, type Adventurer, type CharacterState } from '@shared/character';

function row(name: string, over: Partial<Adventurer> = {}): Adventurer {
  return {
    name,
    alignment: 'Neutral',
    title: 'Squire',
    flags: null,
    gang: null,
    provisional: false,
    ...over
  };
}

/** A push as the bridge hands it over: a fresh clone, every array new. */
function pushed(online: Adventurer[], over: Partial<CharacterState> = {}): CharacterState {
  return structuredClone({ ...EMPTY_CHARACTER, online, ...over });
}

describe('keepRoster', () => {
  it('keeps the roster array when a status line brings the same rows', () => {
    const before = pushed([row('Soul'), row('Yang')]);
    const next = pushed([row('Soul'), row('Yang')], { name: 'Vaelor' });
    const kept = keepRoster(before, next);
    expect(kept.online).toBe(before.online);
    // Everything else is the push's own.
    expect(kept.name).toBe('Vaelor');
  });

  it('takes the new roster when a row moved, on any field', () => {
    const before = pushed([row('Soul'), row('Yang')]);
    for (const next of [
      pushed([row('Soul')]),
      pushed([row('Soul'), row('Yin')]),
      pushed([row('Soul'), row('Yang', { alignment: 'FIEND' })]),
      pushed([row('Soul'), row('Yang', { gang: 'Dora' })]),
      pushed([row('Soul'), row('Yang', { provisional: true })]),
      pushed([row('Yang'), row('Soul')])
    ]) {
      expect(keepRoster(before, next)).toBe(next);
    }
  });

  it('compares a field it was not written for', () => {
    const before = pushed([row('Soul')]);
    const next = pushed([{ ...row('Soul'), seen: 1 } as Adventurer]);
    expect(keepRoster(before, next)).toBe(next);
  });
});
