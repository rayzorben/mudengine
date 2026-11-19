import { describe, expect, it } from 'vitest';

import { aliasRefusal } from '../aliases';
import { COMMAND_WORDS } from '../commands';
import { RETURN_COMMAND_WORD, returnCommandOf } from '../returnCommand';

describe('return typed in the game', () => {
  it('lists alone, gives with one name, and says what to type with more', () => {
    expect(returnCommandOf('return')).toEqual({ kind: 'list' });
    expect(returnCommandOf('  Return Cretin ')).toEqual({ kind: 'give', player: 'Cretin' });
    expect(returnCommandOf('return cretin now')).toEqual({ kind: 'usage' });
    // Positive control above: speech and other words are not it.
    expect(returnCommandOf('gos return cretin')).toBeNull();
    expect(returnCommandOf('returns')).toBeNull();
  });

  it('is a word the realm does not have and no alias may take', () => {
    expect(Object.hasOwn(COMMAND_WORDS, RETURN_COMMAND_WORD)).toBe(false);
    expect(aliasRefusal('return', 'rest')).toBe('client');
  });
});
